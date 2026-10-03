"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { userAction } from "@/server/safe";
import { AppError } from "@/server/errors";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { currencyCode } from "@/lib/validation";
import {
  changeBaseCurrency,
  deleteExchangeRate,
  getPreferences,
  listExchangeRates,
  updateProfile,
  upsertExchangeRate,
} from "@/server/services/preferences";
import {
  aiPrefsInput,
  appearanceInput,
  exchangeRateInput,
  fetchLatestRates,
  generalPrefsInput,
  notificationPrefsInput,
  saveNotificationPreferences,
  updateAiPreferences,
  updateAppearance,
  updateGeneralPreferences,
} from "@/server/services/settings";
import { listAccounts } from "@/server/services/accounts";

/* ───────────── Profile & preferences ───────────── */

export const updateProfileAction = userAction(z.object({ name: z.string().trim().max(80, "Name is too long") }), async ({ name }, { userId }) => {
  await updateProfile(userId, { name: name || null });
  refresh();
  return null;
});

export const updatePreferencesAction = userAction(generalPrefsInput, async (input, { userId }) => {
  await updateGeneralPreferences(userId, input);
  refresh();
  return null;
});

export const changeBaseCurrencyAction = userAction(
  z.object({ currency: currencyCode, confirm: z.literal(true, { message: "Confirm the conversion first" }) }),
  async ({ currency }, { userId }) => {
    await enforceRateLimit(`base-currency:${userId}`, 10, 3600);
    await changeBaseCurrency(userId, currency);
    refresh();
    return { currency };
  },
);

/* ───────────── Appearance / notifications / AI ───────────── */

export const updateAppearanceAction = userAction(appearanceInput, async (input, { userId }) => {
  await updateAppearance(userId, input);
  refresh();
  return null;
});

export const updateNotificationPrefsAction = userAction(notificationPrefsInput, async (input, { userId }) => {
  await saveNotificationPreferences(userId, input);
  refresh();
  return null;
});

export const updateAiPrefsAction = userAction(aiPrefsInput, async (input, { userId }) => {
  await updateAiPreferences(userId, input);
  refresh();
  return null;
});

/* ───────────── Exchange rates ───────────── */

export const upsertExchangeRateAction = userAction(exchangeRateInput, async ({ currency, rate }, { userId }) => {
  const prefs = await getPreferences(userId);
  if (currency === prefs.currency) throw new AppError("VALIDATION", `${currency} is your base currency — its rate is always 1.`, { currency: ["Base currency"] });
  await upsertExchangeRate(userId, currency, rate);
  refresh();
  return null;
});

export const saveExchangeRatesAction = userAction(z.array(exchangeRateInput).min(1).max(100), async (list, { userId }) => {
  const prefs = await getPreferences(userId);
  for (const r of list) if (r.currency !== prefs.currency) await upsertExchangeRate(userId, r.currency, r.rate);
  refresh();
  return { saved: list.length };
});

export const deleteExchangeRateAction = userAction(z.object({ currency: currencyCode }), async ({ currency }, { userId }) => {
  await deleteExchangeRate(userId, currency);
  refresh();
  return null;
});

/** Fetches reference rates for review. Nothing is saved until the user confirms. */
export const fetchLatestRatesAction = userAction(z.object({ currencies: z.array(currencyCode).max(60) }), async ({ currencies }, { userId }) => {
  await enforceRateLimit(`fx-fetch:${userId}`, 20, 3600, "You've fetched rates a lot recently. Try again later.");
  const prefs = await getPreferences(userId);
  const [rates, accounts] = await Promise.all([listExchangeRates(userId), listAccounts(userId, { includeArchived: true })]);
  // Default: every currency the user actually uses or has a rate for.
  const wanted = currencies.length ? currencies : [...new Set([...rates.map((r) => r.currency), ...accounts.map((a) => a.currency)])];
  return fetchLatestRates(prefs.currency, wanted);
});
