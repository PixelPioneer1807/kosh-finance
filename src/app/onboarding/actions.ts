"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/server/db";
import { users } from "@/server/db/schema";
import { userAction } from "@/server/safe";
import { requireUser } from "@/server/auth/current";
import { changeBaseCurrency, getPreferences, updateNotificationPreferences, updatePreferences, updateProfile } from "@/server/services/preferences";
import { accountInput, createAccount } from "@/server/services/accounts";
import { createRecurring } from "@/server/services/recurring";
import { listCategories } from "@/server/services/taxonomy";
import { createBudget } from "@/server/services/budgets";
import { createGoal } from "@/server/services/goals";
import { currencyCode, optionalDate, optionalMoney, positiveMoney, timeOfDay, timezone } from "@/lib/validation";
import { matchCategory } from "@/lib/nl-parse";
import { monthRange, toDate, toISO } from "@/lib/dates";

/** Next date (today or later) falling on `day` of the month, clamped to short months. */
function nextDayOfMonth(today: string, day: number) {
  const d = toDate(today);
  const clamp = (y: number, m: number) => toISO(new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate())));
  const thisMonth = clamp(d.getFullYear(), d.getMonth());
  return thisMonth >= today ? thisMonth : clamp(d.getFullYear(), d.getMonth() + 1);
}

export const saveProfileStep = userAction(
  z.object({ name: z.string().trim().max(80).optional(), currency: currencyCode, timezone, locale: z.string().max(20).optional() }),
  async (input, { userId }) => {
    if (input.name !== undefined) await updateProfile(userId, { name: input.name || null });
    const prefs = await getPreferences(userId);
    if (prefs.currency !== input.currency) await changeBaseCurrency(userId, input.currency);
    const locale = input.locale && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(input.locale) ? input.locale : prefs.locale;
    await updatePreferences(userId, { timezone: input.timezone, locale });
    return null;
  },
);

export const saveIncomeStep = userAction(
  z.object({
    amount: optionalMoney,
    frequency: z.enum(["monthly", "biweekly", "weekly"]).default("monthly"),
    payDay: z.coerce.number().int().min(1).max(31).optional(),
    nextPayDate: optionalDate,
    employer: z.string().trim().max(80).optional(),
    budgetFromPayday: z.boolean().default(false),
  }),
  async (input, { userId }) => {
    if (!input.amount) return null;
    const prefs = await getPreferences(userId);
    const monthly = input.frequency === "monthly" ? input.amount : null;
    await updatePreferences(userId, {
      expectedMonthlyIncome: monthly ?? undefined,
      monthStartDay: input.budgetFromPayday && input.payDay && input.payDay <= 28 ? input.payDay : prefs.monthStartDay,
    });
    let start = input.nextPayDate;
    if (!start && input.payDay) {
      start = nextDayOfMonth(prefs.today, input.payDay);
    }
    if (start) {
      const cats = await listCategories(userId);
      const salary = matchCategory("Salary", cats, "income");
      await createRecurring(userId, {
        kind: "income",
        name: input.employer ? `Salary — ${input.employer}` : "Salary",
        amount: input.amount,
        frequency: input.frequency,
        startDate: start,
        categoryId: salary?.id ?? null,
        employer: input.employer || null,
        accountId: prefs.defaultAccountId,
        autoPost: false,
      });
    }
    return null;
  },
);

export const saveAccountsStep = userAction(z.array(accountInput).max(20), async (list, { userId }) => {
  const created = [];
  for (const a of list) created.push(await createAccount(userId, a));
  const prefs = await getPreferences(userId);
  const firstSpendable = created.find((a) => ["checking", "cash", "wallet", "credit_card"].includes(a.type)) ?? created[0];
  if (firstSpendable && !prefs.defaultAccountId) await updatePreferences(userId, { defaultAccountId: firstSpendable.id });
  return { count: created.length };
});

export const saveRecurringStep = userAction(
  z.array(z.object({ name: z.string().trim().min(1).max(80), amount: positiveMoney, kind: z.enum(["bill", "subscription", "expense"]), day: z.coerce.number().int().min(1).max(31) })).max(30),
  async (list, { userId }) => {
    const prefs = await getPreferences(userId);
    const cats = await listCategories(userId);
    for (const r of list) {
      const start = nextDayOfMonth(prefs.today, r.day);
      const cat = matchCategory(r.name, cats, "expense") ?? (r.kind === "subscription" ? matchCategory("Subscriptions", cats, "expense") : r.kind === "bill" ? matchCategory("Bills & Utilities", cats, "expense") : null);
      await createRecurring(userId, {
        kind: r.kind,
        name: r.name,
        amount: r.amount,
        frequency: "monthly",
        startDate: start,
        categoryId: cat?.id ?? null,
        accountId: prefs.defaultAccountId,
        autoPost: false,
        remindDaysBefore: 2,
      });
    }
    return { count: list.length };
  },
);

export const saveBudgetsStep = userAction(
  z.object({ overall: optionalMoney, categories: z.array(z.object({ categoryId: z.uuid(), amount: positiveMoney })).max(30).default([]) }),
  async (input, { userId }) => {
    const prefs = await getPreferences(userId);
    const range = monthRange(prefs.today, prefs.monthStartDay);
    if (input.overall) await createBudget(userId, { name: "Monthly spending", period: "monthly", categoryId: null, amount: input.overall, startDate: range.from });
    const cats = await listCategories(userId);
    for (const c of input.categories) {
      const cat = cats.find((x) => x.id === c.categoryId);
      if (!cat) continue;
      await createBudget(userId, { name: cat.name, period: "monthly", categoryId: cat.id, amount: c.amount, startDate: range.from });
    }
    return null;
  },
);

export const saveGoalsStep = userAction(
  z.array(z.object({ name: z.string().trim().min(1).max(80), targetAmount: positiveMoney, deadline: optionalDate, startingAmount: optionalMoney })).max(20),
  async (list, { userId }) => {
    for (const g of list) await createGoal(userId, { name: g.name, targetAmount: g.targetAmount, deadline: g.deadline, startingAmount: g.startingAmount ?? "0", kind: "custom" });
    return null;
  },
);

export const saveNotificationsStep = userAction(
  z.object({ dailyReminderEnabled: z.boolean(), dailyReminderTime: timeOfDay, billReminders: z.boolean(), budgetAlerts: z.boolean() }),
  async (input, { userId }) => {
    await updateNotificationPreferences(userId, input);
    return null;
  },
);

export async function finishOnboarding() {
  const s = await requireUser();
  await db.update(users).set({ onboardingCompletedAt: new Date() }).where(eq(users.id, s.user.id));
  redirect("/dashboard");
}
