/** Zod building blocks shared by client forms and server actions (validated on both sides). */
import { z } from "zod";
import { isISODate } from "./dates";
import { isValidCurrency, normalize, toUnits, MoneyParseError } from "./money";

const MAX_UNITS = toUnits("999999999999999"); // fits numeric(19,4)

function moneyBase() {
  return z
    .union([z.string(), z.number()])
    .transform((v, ctx) => {
      try {
        const s = typeof v === "number" ? String(v) : v;
        if (s.trim() === "") {
          ctx.addIssue({ code: "custom", message: "Enter an amount" });
          return z.NEVER;
        }
        const n = normalize(s);
        const u = toUnits(n);
        if (u > MAX_UNITS || u < -MAX_UNITS) {
          ctx.addIssue({ code: "custom", message: "Amount is too large" });
          return z.NEVER;
        }
        return n;
      } catch (e) {
        if (e instanceof MoneyParseError) {
          ctx.addIssue({ code: "custom", message: "Enter a valid amount" });
          return z.NEVER;
        }
        throw e;
      }
    });
}

/** Strictly positive decimal amount → canonical string. */
export const positiveMoney = moneyBase().refine((v) => toUnits(v) > BigInt(0), "Amount must be greater than zero");
/** Zero or positive. */
export const nonNegativeMoney = moneyBase().refine((v) => toUnits(v) >= BigInt(0), "Amount can't be negative");
/** Any sign. */
export const signedMoney = moneyBase();

export const optionalMoney = z
  .union([z.literal(""), z.null(), z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === "" || v === null || v === undefined) return null;
    const r = nonNegativeMoney.safeParse(v);
    if (!r.success) {
      ctx.addIssue({ code: "custom", message: r.error.issues[0]?.message ?? "Invalid amount" });
      return z.NEVER;
    }
    return r.data;
  });

export const isoDate = z.string().refine(isISODate, "Enter a valid date");
export const optionalDate = z
  .union([z.literal(""), z.null(), z.string()])
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || isISODate(v), "Enter a valid date");

export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidCurrency, "Unknown currency");

export const id = z.uuid({ message: "Invalid id" });
export const optionalId = z
  .union([z.literal(""), z.null(), z.uuid()])
  .optional()
  .transform((v) => (v ? v : null));

export const name = (label = "Name", max = 80) =>
  z.string().trim().min(1, `${label} is required`).max(max, `${label} is too long`);

export const optionalText = (max = 1000) =>
  z
    .union([z.null(), z.string()])
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().slice(0, max) : null));

export const email = z.string().trim().toLowerCase().pipe(z.email({ message: "Enter a valid email address" })).pipe(z.string().max(254));

export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid color");

export const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "Unknown timezone");

export const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

export const frequency = z.enum(["daily", "weekly", "biweekly", "monthly", "quarterly", "yearly", "custom"]);
export const unit = z.enum(["day", "week", "month", "year"]);
