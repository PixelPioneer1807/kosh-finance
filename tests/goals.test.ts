import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { goals, notifications, transactions } from "@/server/db/schema";
import {
  addContribution,
  computeProgress,
  createGoal,
  deleteContribution,
  deleteGoal,
  generateGoalReminders,
  listContributions,
  listGoalsWithProgress,
  setGoalStatus,
  updateGoal,
} from "@/server/services/goals";
import { accountBalances } from "@/server/services/accounts";
import { getPreferences, updateNotificationPreferences } from "@/server/services/preferences";
import { addDaysISO, addMonthsISO } from "@/lib/dates";
import { makeAccount, makeUser } from "./helpers";

const base = { targetAmount: "1200", startingAmount: "200", deadline: null, contributionFrequency: null, targetContribution: null, status: "active" as const };

describe("goal progress maths", () => {
  it("computes remaining and the required contribution per period to hit the deadline", () => {
    const p = computeProgress({ ...base, deadline: "2026-06-30", contributionFrequency: "monthly", createdDate: "2026-01-01" }, { contributed: "0", recent: "0", firstDate: null }, "2026-01-15");
    expect(p.current).toBe("200.0000");
    expect(p.remaining).toBe("1000.0000");
    expect(p.progress).toBeCloseTo(1 / 6, 5);
    // Jan 15, Feb 15, Mar 15, Apr 15, May 15, Jun 15 → 6 periods; 1000 / 6 rounded *up* to cents.
    expect(p.periodsLeft).toBe(6);
    expect(p.requiredPerPeriod).toBe("166.6700");
    expect(p.track).toBe("no_pace");
    expect(p.onTrack).toBe(false);
  });

  it("weekly cadence counts weeks; a past deadline asks for everything now", () => {
    const w = computeProgress({ ...base, deadline: "2026-02-11", contributionFrequency: "weekly", createdDate: "2026-01-01" }, { contributed: "0", recent: "0", firstDate: null }, "2026-01-14");
    expect(w.periodsLeft).toBe(5); // 14, 21, 28 Jan, 4, 11 Feb
    expect(w.requiredPerPeriod).toBe("200.0000");
    const late = computeProgress({ ...base, deadline: "2026-01-01", createdDate: "2025-06-01" }, { contributed: "0", recent: "0", firstDate: null }, "2026-01-14");
    expect(late.periodsLeft).toBe(0);
    expect(late.requiredPerPeriod).toBe("1000.0000");
    expect(late.track).toBe("overdue");
  });

  it("projects completion from the recent pace and judges on-track against the deadline", () => {
    // 300 saved in the last 90 days → 900 remaining takes 270 days.
    const g = { ...base, startingAmount: "0", contributionFrequency: "monthly" as const, createdDate: "2025-01-01" };
    const agg = { contributed: "300", recent: "300", firstDate: "2025-01-01" };
    const onTrack = computeProgress({ ...g, deadline: "2027-01-01" }, agg, "2026-01-01");
    expect(onTrack.paceWindowDays).toBe(90);
    expect(onTrack.projectedCompletionDate).toBe(addDaysISO("2026-01-01", 270));
    expect(onTrack.track).toBe("on_track");
    expect(onTrack.pacePerPeriod).toBe("101.4583"); // 300 × 30.4375 / 90
    const behind = computeProgress({ ...g, deadline: "2026-06-01" }, agg, "2026-01-01");
    expect(behind.track).toBe("behind");
    expect(behind.onTrack).toBe(false);
  });

  it("uses at least a 30-day pace window for brand-new goals and has no projection without pace", () => {
    const p = computeProgress({ ...base, startingAmount: "0", createdDate: "2026-01-10" }, { contributed: "100", recent: "100", firstDate: "2026-01-10" }, "2026-01-12");
    expect(p.paceWindowDays).toBe(30);
    expect(p.projectedCompletionDate).toBe(addDaysISO("2026-01-12", 330)); // 1100 / 100 × 30
    const none = computeProgress({ ...base, createdDate: "2026-01-10" }, { contributed: "-50", recent: "-50", firstDate: "2026-01-10" }, "2026-01-12");
    expect(none.projectedCompletionDate).toBeNull();
    expect(none.pacePerPeriod).toBeNull();
  });
});

describe("goals service", () => {
  it("creates with defaults (base currency, kind icon/colour) for the onboarding contract", async () => {
    const u = await makeUser({ currency: "INR" });
    const g = await createGoal(u.id, { name: "Rainy day", targetAmount: "50000", deadline: null, kind: "custom" });
    expect(g.currency).toBe("INR");
    expect(g.icon).toBe("piggy-bank");
    expect(g.startingAmount).toBe("0.0000");
    expect(g.status).toBe("active");
  });

  it("tracks contributions and withdrawals, refuses over-withdrawal, and auto-completes once", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const g = await createGoal(u.id, { name: "Laptop", kind: "electronics", targetAmount: "1000", startingAmount: "100", deadline: addMonthsISO(today, 6), contributionFrequency: "monthly" });
    await addContribution(u.id, { goalId: g.id, amount: "400", date: today });
    await addContribution(u.id, { goalId: g.id, direction: "withdraw", amount: "50", date: today, note: "Oops" });
    let [p] = await listGoalsWithProgress(u.id);
    expect(p.contributed).toBe("350.0000");
    expect(p.current).toBe("450.0000");
    expect(p.remaining).toBe("550.0000");
    expect(p.contributionCount).toBe(2);
    expect(p.requiredPerPeriod).not.toBeNull();
    expect(p.projectedCompletionDate).not.toBeNull();

    await expect(addContribution(u.id, { goalId: g.id, direction: "withdraw", amount: "451", date: today })).rejects.toThrow(/at most/);
    await expect(addContribution(u.id, { goalId: g.id, amount: "1", date: addDaysISO(today, 1) })).rejects.toThrow(/future/);

    const r = await addContribution(u.id, { goalId: g.id, amount: "600", date: today });
    expect(r.completed).toBe(true);
    [p] = await listGoalsWithProgress(u.id);
    expect(p.status).toBe("completed");
    expect(p.track).toBe("completed");
    const completedAt = p.completedAt;
    expect(completedAt).not.toBeNull();

    // Reactivating while still at target keeps it active (no immediate re-complete).
    await setGoalStatus(u.id, g.id, "reactivate");
    [p] = await listGoalsWithProgress(u.id);
    expect(p.status).toBe("active");
    expect(p.completedAt).toBe(completedAt);

    // Raising the target re-arms auto-completion.
    await updateGoal(u.id, g.id, { name: "Laptop", kind: "electronics", targetAmount: "1500", startingAmount: "100", deadline: addMonthsISO(today, 6), contributionFrequency: "monthly" });
    [p] = await listGoalsWithProgress(u.id);
    expect(p.completedAt).toBeNull();
    await addContribution(u.id, { goalId: g.id, amount: "450", date: today });
    [p] = await listGoalsWithProgress(u.id);
    expect(p.status).toBe("completed");

    await setGoalStatus(u.id, g.id, "archive");
    await expect(addContribution(u.id, { goalId: g.id, amount: "1", date: today })).rejects.toThrow(/Reactivate/);
  });

  it("a contribution can move real money as a transfer; deleting it removes the transfer", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const checking = await makeAccount(u.id, { name: "Checking", openingBalance: "1000" });
    const savings = await makeAccount(u.id, { name: "Savings", type: "savings", openingBalance: "0" });
    const g = await createGoal(u.id, { name: "Trip", kind: "vacation", targetAmount: "2000", linkedAccountId: savings.id });

    const { contribution } = await addContribution(u.id, { goalId: g.id, amount: "250", date: today, accountId: checking.id });
    expect(contribution.transactionId).not.toBeNull();
    let bal = await accountBalances(u.id);
    expect(bal.get(checking.id)).toBe("750.0000");
    expect(bal.get(savings.id)).toBe("250.0000");

    // Withdrawal moves money back out of the goal account.
    await addContribution(u.id, { goalId: g.id, direction: "withdraw", amount: "50", date: today, accountId: checking.id });
    bal = await accountBalances(u.id);
    expect(bal.get(checking.id)).toBe("800.0000");
    expect(bal.get(savings.id)).toBe("200.0000");

    const history = await listContributions(u.id, g.id);
    expect(history).toHaveLength(2);
    expect(history.find((h) => h.id === contribution.id)?.transfer).toEqual({ fromAccountName: "Checking", toAccountName: "Savings" });

    await deleteContribution(u.id, contribution.id);
    bal = await accountBalances(u.id);
    expect(bal.get(checking.id)).toBe("1050.0000");
    expect(bal.get(savings.id)).toBe("-50.0000");
    const [t] = await db.select().from(transactions).where(eq(transactions.id, contribution.transactionId!));
    expect(t.deletedAt).not.toBeNull();

    // Moving money needs a goal account, and both accounts in the goal's currency.
    const g2 = await createGoal(u.id, { name: "No account", targetAmount: "100" });
    await expect(addContribution(u.id, { goalId: g2.id, amount: "10", date: today, accountId: checking.id })).rejects.toThrow(/account that holds/);
    const eur = await makeAccount(u.id, { name: "Euro", currency: "EUR", openingBalance: "0" }).catch(() => null);
    if (eur) await expect(addContribution(u.id, { goalId: g.id, amount: "10", date: today, accountId: eur.id })).rejects.toThrow(/EUR/);
  });

  it("validates the linked account (asset, same currency)", async () => {
    const u = await makeUser();
    const card = await makeAccount(u.id, { name: "Card", type: "credit_card", openingBalance: "0" });
    await expect(createGoal(u.id, { name: "X", targetAmount: "10", linkedAccountId: card.id })).rejects.toThrow(/credit card/);
  });

  it("reminds about a missed period and a reached goal, once, respecting the preference", async () => {
    const u = await makeUser();
    const { today } = await getPreferences(u.id);
    const g = await createGoal(u.id, { name: "Fund", kind: "emergency_fund", targetAmount: "1000", contributionFrequency: "weekly" });
    // Pretend the goal was created three weeks ago and nothing was added last week.
    await db.update(goals).set({ createdAt: new Date(Date.now() - 21 * 86_400_000) }).where(eq(goals.id, g.id));
    await addContribution(u.id, { goalId: g.id, amount: "10", date: addDaysISO(today, -20) });
    expect(await generateGoalReminders(u.id)).toBe(1);
    expect(await generateGoalReminders(u.id)).toBe(0); // deduped

    const done = await createGoal(u.id, { name: "Small", targetAmount: "5" });
    await addContribution(u.id, { goalId: done.id, amount: "5", date: today });
    expect(await generateGoalReminders(u.id)).toBe(1);
    const rows = await db.select().from(notifications).where(and(eq(notifications.userId, u.id), eq(notifications.type, "goal")));
    const keys = rows.map((r) => r.dedupeKey);
    expect(keys).toHaveLength(2);
    expect(keys).toContain(`goal:${done.id}:reached`);
    expect(keys).toContain(`goal:${g.id}:missed:${addDaysISO(today, -7)}`);

    const v = await makeUser();
    const vg = await createGoal(v.id, { name: "Small", targetAmount: "5" });
    await addContribution(v.id, { goalId: vg.id, amount: "5", date: today });
    await updateNotificationPreferences(v.id, { goalReminders: false });
    expect(await generateGoalReminders(v.id)).toBe(0);
  });

  it("isolation: another user can't read, modify, contribute to or link into someone else's goals", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { today } = await getPreferences(a.id);
    const aAcc = await makeAccount(a.id, { name: "A savings", type: "savings" });
    const bAcc = await makeAccount(b.id, { name: "B checking" });
    const g = await createGoal(a.id, { name: "A's goal", targetAmount: "100", linkedAccountId: aAcc.id });
    const { contribution } = await addContribution(a.id, { goalId: g.id, amount: "10", date: today });

    expect(await listGoalsWithProgress(b.id)).toEqual([]);
    await expect(listContributions(b.id, g.id)).rejects.toThrow(/not found/);
    await expect(addContribution(b.id, { goalId: g.id, amount: "10", date: today })).rejects.toThrow(/not found/);
    await expect(updateGoal(b.id, g.id, { name: "Hijack", targetAmount: "1" })).rejects.toThrow(/not found/);
    await expect(setGoalStatus(b.id, g.id, "archive")).rejects.toThrow(/not found/);
    await expect(deleteContribution(b.id, contribution.id)).rejects.toThrow(/not found/);
    await expect(deleteGoal(b.id, g.id)).rejects.toThrow(/not found/);
    // B can't link A's account to B's goal, nor move money out of A's account.
    await expect(createGoal(b.id, { name: "B", targetAmount: "10", linkedAccountId: aAcc.id })).rejects.toThrow(/not found/);
    const bg = await createGoal(b.id, { name: "B", targetAmount: "10", linkedAccountId: bAcc.id });
    await expect(addContribution(b.id, { goalId: bg.id, amount: "1", date: today, accountId: aAcc.id })).rejects.toThrow(/not found/);
    await expect(addContribution(b.id, { goalId: bg.id, amount: "1", date: today, accountId: bAcc.id, goalAccountId: aAcc.id })).rejects.toThrow(/not found/);

    const [p] = await listGoalsWithProgress(a.id);
    expect(p.name).toBe("A's goal");
    expect(p.current).toBe("10.0000");
  });
});
