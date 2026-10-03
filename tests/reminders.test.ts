import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { db } from "@/server/db";
import { notifications, users } from "@/server/db/schema";
import { listNotifications, markRead, notify, unreadCount } from "@/server/services/notifications";
import { updateNotificationPreferences } from "@/server/services/preferences";
import { maybeRunRemindersForUser, runUserReminders } from "@/server/services/reminders";
import { inQuietHours, listPushSubscriptions, pushDecision, pushPendingForUser, safeLink, subscribePush, unsubscribePush } from "@/server/services/push";
import { createRecurring } from "@/server/services/recurring";
import { createTransaction } from "@/server/services/transactions";
import { addDaysISO, timeIn, todayIn } from "@/lib/dates";
import { makeAccount, makeUser } from "./helpers";

// Web Push network calls are faked; endpoints containing "gone" behave like an expired subscription.
const push = vi.hoisted(() => ({ sent: [] as { endpoint: string; payload: { title: string; body: string; url: string; tag?: string } }[] }));
vi.mock("web-push", () => {
  const sendNotification = vi.fn(async (sub: { endpoint: string }, body: string) => {
    if (sub.endpoint.includes("gone")) throw Object.assign(new Error("Gone"), { statusCode: 410 });
    push.sent.push({ endpoint: sub.endpoint, payload: JSON.parse(body) });
    return { statusCode: 201, body: "", headers: {} };
  });
  return { default: { sendNotification }, sendNotification };
});

beforeEach(() => {
  push.sent.length = 0;
});

const endpoint = (tag: string) => `https://fcm.googleapis.com/fcm/send/${tag}-${Math.random().toString(36).slice(2)}`;
const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
const today = () => todayIn("UTC");

async function quietUser() {
  const u = await makeUser();
  // Start from a clean slate: nothing on by default except what each test enables.
  await updateNotificationPreferences(u.id, {
    dailyReminderEnabled: false,
    missingEntriesDays: 0,
    billReminders: false,
    subscriptionReminders: false,
    incomeReminders: false,
    budgetAlerts: false,
    goalReminders: false,
    creditCardReminders: false,
    quietHoursStart: null,
    quietHoursEnd: null,
  });
  return u;
}

const byKey = (userId: string, prefix: string) =>
  db.select().from(notifications).where(and(eq(notifications.userId, userId), like(notifications.dedupeKey, `${prefix}%`)));

describe("daily tracking reminder", () => {
  it("fires once at/after the chosen local time and dedupes repeated runs", async () => {
    const u = await quietUser();
    await updateNotificationPreferences(u.id, { dailyReminderEnabled: true, dailyReminderTime: "00:00" });
    const first = await runUserReminders(u.id);
    const second = await runUserReminders(u.id);
    expect(first.created).toBeGreaterThanOrEqual(1);
    expect(second.created).toBe(0);
    const rows = await byKey(u.id, "daily:");
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe(`daily:${today()}`);
    expect(rows[0].title).toMatch(/tracked today/);
  });

  it("is not created before the chosen time", async () => {
    const u = await quietUser();
    await updateNotificationPreferences(u.id, { dailyReminderEnabled: true, dailyReminderTime: "21:00" });
    const at = new Date(`${today()}T08:00:00Z`);
    await runUserReminders(u.id, at);
    expect(await byKey(u.id, "daily:")).toHaveLength(0);
  });

  it("is skipped when the user already logged a transaction today", async () => {
    const u = await quietUser();
    await updateNotificationPreferences(u.id, { dailyReminderEnabled: true, dailyReminderTime: "00:00" });
    const acc = await makeAccount(u.id);
    await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "4.50", date: today(), merchant: "Coffee" });
    await runUserReminders(u.id);
    expect(await byKey(u.id, "daily:")).toHaveLength(0);
  });

  it("is off when disabled", async () => {
    const u = await quietUser();
    await runUserReminders(u.id);
    expect(await listNotifications(u.id)).toHaveLength(0);
  });
});

describe("missing entries", () => {
  it("reminds once per gap after N days without entries, instead of the daily nudge", async () => {
    const u = await quietUser();
    await db.update(users).set({ createdAt: new Date(Date.now() - 10 * 86_400_000) }).where(eq(users.id, u.id));
    await updateNotificationPreferences(u.id, { missingEntriesDays: 3, dailyReminderEnabled: true, dailyReminderTime: "00:00" });
    await runUserReminders(u.id);
    await runUserReminders(u.id);
    const missing = await byKey(u.id, "missing:");
    expect(missing).toHaveLength(1);
    expect(missing[0].body).toMatch(/10 days/);
    expect(await byKey(u.id, "daily:")).toHaveLength(0);
  });

  it("doesn't fire when there was recent activity", async () => {
    const u = await quietUser();
    await updateNotificationPreferences(u.id, { missingEntriesDays: 3 });
    const acc = await makeAccount(u.id);
    await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "1", date: addDaysISO(today(), -1) });
    await runUserReminders(u.id);
    expect(await byKey(u.id, "missing:")).toHaveLength(0);
  });
});

describe("bills, subscriptions and income", () => {
  it("digests several upcoming payments into one notification per day", async () => {
    const u = await quietUser();
    await updateNotificationPreferences(u.id, { billReminders: true, subscriptionReminders: true });
    const tomorrow = addDaysISO(today(), 1);
    await createRecurring(u.id, { kind: "bill", name: "Rent", amount: "1200", frequency: "monthly", startDate: tomorrow, remindDaysBefore: 2 });
    await createRecurring(u.id, { kind: "subscription", name: "Music", amount: "9.99", frequency: "monthly", startDate: tomorrow, remindDaysBefore: 3 });
    // Outside its reminder window — must not be mentioned.
    await createRecurring(u.id, { kind: "bill", name: "Insurance", amount: "300", frequency: "yearly", startDate: addDaysISO(today(), 20), remindDaysBefore: 2 });
    await runUserReminders(u.id);
    await runUserReminders(u.id);
    const rows = await byKey(u.id, "payments:");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("2 payments due soon");
    expect(rows[0].body).toContain("Rent tomorrow");
    expect(rows[0].body).toContain("Music tomorrow");
    expect(rows[0].body).not.toContain("Insurance");
  });

  it("names a single payment directly and respects the bill toggle", async () => {
    const u = await quietUser();
    await createRecurring(u.id, { kind: "bill", name: "Electricity", amount: "80", frequency: "monthly", startDate: today(), remindDaysBefore: 1 });
    await runUserReminders(u.id);
    expect(await byKey(u.id, "payments:")).toHaveLength(0); // bill reminders off
    await updateNotificationPreferences(u.id, { billReminders: true });
    await runUserReminders(u.id);
    const [row] = await byKey(u.id, "payments:");
    expect(row.title).toBe("Electricity is due today");
    expect(row.link).toBe("/recurring");
  });

  it("warns once before a subscription trial ends", async () => {
    const u = await quietUser();
    await updateNotificationPreferences(u.id, { subscriptionReminders: true });
    const trialEnd = addDaysISO(today(), 2);
    await createRecurring(u.id, {
      kind: "subscription",
      name: "Video",
      amount: "15",
      frequency: "monthly",
      startDate: addDaysISO(today(), 2),
      trialEndsAt: trialEnd,
      remindDaysBefore: 3,
    });
    await runUserReminders(u.id);
    await runUserReminders(u.id);
    const rows = await byKey(u.id, "trial:");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Video trial ends in 2 days");
  });

  it("notifies on the expected income date", async () => {
    const u = await quietUser();
    await updateNotificationPreferences(u.id, { incomeReminders: true });
    await createRecurring(u.id, { kind: "income", name: "Salary", employer: "Acme", amount: "5000", frequency: "monthly", startDate: today() });
    await runUserReminders(u.id);
    await runUserReminders(u.id);
    const rows = await byKey(u.id, "income:");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Acme expected today");
  });
});

describe("lazy trigger", () => {
  it("runs at most once per 15 minutes per user", async () => {
    const u = await quietUser();
    const a = await maybeRunRemindersForUser(u.id);
    const b = await maybeRunRemindersForUser(u.id);
    expect(a.ran).toBe(true);
    expect(b.ran).toBe(false);
  });
  it("never runs for disabled users", async () => {
    const u = await quietUser();
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, u.id));
    expect((await maybeRunRemindersForUser(u.id)).ran).toBe(false);
  });
});

describe("push delivery rules", () => {
  it("quiet hours wrap past midnight", () => {
    expect(inQuietHours("23:30", "22:00", "08:00")).toBe(true);
    expect(inQuietHours("07:59", "22:00", "08:00")).toBe(true);
    expect(inQuietHours("08:00", "22:00", "08:00")).toBe(false);
    expect(inQuietHours("12:00", "13:00", "14:00")).toBe(false);
    expect(inQuietHours("13:30", "13:00", "14:00")).toBe(true);
    expect(inQuietHours("13:30", null, null)).toBe(false);
    expect(inQuietHours("13:30", "13:00", "13:00")).toBe(false);
  });

  it("decision honours disabled push, quiet hours and the daily cap", () => {
    const base = { configured: true, pushEnabled: true, localTime: "12:00", quietStart: "22:00", quietEnd: "08:00", maxPerDay: 4, pushedToday: 0 };
    expect(pushDecision(base)).toEqual({ allowed: true, remaining: 4 });
    expect(pushDecision({ ...base, pushEnabled: false })).toEqual({ allowed: false, reason: "disabled" });
    expect(pushDecision({ ...base, localTime: "23:00" })).toEqual({ allowed: false, reason: "quiet_hours" });
    expect(pushDecision({ ...base, pushedToday: 4 })).toEqual({ allowed: false, reason: "daily_cap" });
    expect(pushDecision({ ...base, configured: false })).toEqual({ allowed: false, reason: "not_configured" });
  });

  it("holds pushes during quiet hours but still records the in-app notification", async () => {
    const u = await quietUser();
    await subscribePush(u.id, { endpoint: endpoint("quiet"), keys });
    const now = new Date();
    await updateNotificationPreferences(u.id, {
      quietHoursStart: timeIn("UTC", new Date(now.getTime() - 3600_000)),
      quietHoursEnd: timeIn("UTC", new Date(now.getTime() + 3600_000)),
    });
    await notify(u.id, { type: "system", title: "Hello", body: "World", dedupeKey: "t:quiet" });
    expect(await pushPendingForUser(u.id, now)).toEqual({ pushed: 0, reason: "quiet_hours" });
    expect(push.sent).toHaveLength(0);
    expect(await unreadCount(u.id)).toBe(1);
    // After quiet hours the held notification goes out.
    await updateNotificationPreferences(u.id, { quietHoursStart: null, quietHoursEnd: null });
    expect((await pushPendingForUser(u.id, now)).pushed).toBe(1);
    expect(push.sent[0].payload.title).toBe("Hello");
  });

  it("caps pushes per day; extra notifications stay in-app only", async () => {
    const u = await quietUser();
    await subscribePush(u.id, { endpoint: endpoint("cap"), keys });
    await updateNotificationPreferences(u.id, { maxPerDay: 1 });
    await notify(u.id, { type: "system", title: "First", body: "1", dedupeKey: "t:cap1" });
    expect((await pushPendingForUser(u.id)).pushed).toBe(1);
    await notify(u.id, { type: "system", title: "Second", body: "2", dedupeKey: "t:cap2" });
    expect(await pushPendingForUser(u.id)).toEqual({ pushed: 0, reason: "daily_cap" });
    expect(push.sent).toHaveLength(1);
    expect((await listNotifications(u.id)).map((n) => n.title).sort()).toEqual(["First", "Second"]);
  });

  it("coalesces several pending notifications into one push and never re-sends", async () => {
    const u = await quietUser();
    await subscribePush(u.id, { endpoint: endpoint("digest"), keys });
    for (const i of [1, 2, 3]) await notify(u.id, { type: "system", title: `N${i}`, body: "x", dedupeKey: `t:dg${i}` });
    expect((await pushPendingForUser(u.id)).pushed).toBe(3);
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0].payload.title).toBe("3 new notifications");
    expect((await pushPendingForUser(u.id)).pushed).toBe(0);
    expect(push.sent).toHaveLength(1);
  });

  it("doesn't push when the user has push turned off", async () => {
    const u = await quietUser();
    await subscribePush(u.id, { endpoint: endpoint("off"), keys });
    await updateNotificationPreferences(u.id, { pushEnabled: false });
    await notify(u.id, { type: "system", title: "Muted", body: "x", dedupeKey: "t:off" });
    expect(await pushPendingForUser(u.id)).toEqual({ pushed: 0, reason: "disabled" });
  });

  it("removes subscriptions the push service reports as gone (410)", async () => {
    const u = await quietUser();
    await subscribePush(u.id, { endpoint: endpoint("gone"), keys });
    await subscribePush(u.id, { endpoint: endpoint("alive"), keys });
    await notify(u.id, { type: "system", title: "Ping", body: "x", dedupeKey: "t:gone" });
    expect((await pushPendingForUser(u.id)).pushed).toBe(1);
    const left = await listPushSubscriptions(u.id);
    expect(left).toHaveLength(1);
    expect(left[0].endpoint).toContain("alive");
  });

  it("only pushes internal links", () => {
    expect(safeLink("/budgets")).toBe("/budgets");
    expect(safeLink("https://evil.example")).toBe("/dashboard");
    expect(safeLink("//evil.example")).toBe("/dashboard");
    expect(safeLink("/\\evil.example")).toBe("/dashboard");
    expect(safeLink(null)).toBe("/dashboard");
  });
});

describe("isolation", () => {
  it("B can't delete A's push subscription", async () => {
    const A = await quietUser();
    const B = await quietUser();
    const e = endpoint("owned");
    await subscribePush(A.id, { endpoint: e, keys });
    expect((await unsubscribePush(B.id, e)).removed).toBe(0);
    expect((await listPushSubscriptions(A.id)).map((s) => s.endpoint)).toContain(e);
    expect(await listPushSubscriptions(B.id)).toHaveLength(0);
    expect((await unsubscribePush(A.id, e)).removed).toBe(1);
  });

  it("rejects non-https / malformed subscriptions", async () => {
    const A = await quietUser();
    await expect(subscribePush(A.id, { endpoint: "http://push.example/abc", keys })).rejects.toThrow();
    await expect(subscribePush(A.id, { endpoint: endpoint("bad"), keys: { p256dh: "<script>", auth: "x" } })).rejects.toThrow();
  });

  it("B can't read or mark A's notifications", async () => {
    const A = await quietUser();
    const B = await quietUser();
    const id = await notify(A.id, { type: "system", title: "Private to A", body: "x", dedupeKey: "t:iso" });
    expect((await listNotifications(B.id)).map((n) => n.id)).not.toContain(id);
    await markRead(B.id, [id!]);
    await markRead(B.id);
    expect(await unreadCount(A.id)).toBe(1);
    await markRead(A.id, [id!]);
    expect(await unreadCount(A.id)).toBe(0);
  });

  it("A's pushes never reach B's devices", async () => {
    const A = await quietUser();
    const B = await quietUser();
    const eB = endpoint("b-device");
    await subscribePush(B.id, { endpoint: eB, keys });
    await subscribePush(A.id, { endpoint: endpoint("a-device"), keys });
    await notify(A.id, { type: "system", title: "For A", body: "x", dedupeKey: "t:ab" });
    await pushPendingForUser(A.id);
    expect(push.sent.map((s) => s.endpoint)).not.toContain(eB);
  });
});
