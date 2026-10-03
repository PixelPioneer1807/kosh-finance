/**
 * Deterministic receipt-text extraction (no AI). Used when AI is off/unavailable and to
 * sanity-check AI output. Input is noisy OCR text; every field may come back null.
 */
import { isISODate, type ISODate } from "./dates";
import { add, normalize, toUnits } from "./money";

export type PaymentHint = "card" | "cash" | "upi" | "wallet" | "bank_transfer" | "other";

export type ReceiptExtraction = {
  merchant: string | null;
  date: ISODate | null;
  total: string | null;
  tax: string | null;
  currency: string | null;
  paymentMethod: PaymentHint | null;
  items: { name: string; amount: string }[];
};

const NUM = String.raw`(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})|\d+(?:[.,]\d{1,2})?)`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "1,234.56" / "1.234,56" / "1 234,56" / "12,50" → "1234.5600". */
export function parseReceiptAmount(raw: string): string | null {
  let s = raw.trim().replace(/[^\d.,\s]/g, "").replace(/\s+/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decSep = lastDot > lastComma ? "." : lastComma > lastDot ? "," : null;
  if (decSep) {
    const idx = s.lastIndexOf(decSep);
    const frac = s.slice(idx + 1);
    if (frac.length === 3 && !(decSep === "." ? s.includes(",") : s.includes("."))) {
      // "1,234" or "1.234" alone: a thousands separator, not a decimal point.
      s = s.replace(/[.,]/g, "");
    } else {
      s = s.slice(0, idx).replace(/[.,]/g, "") + "." + frac;
    }
  }
  try {
    const n = normalize(s);
    return toUnits(n) > BigInt(0) && toUnits(n) < toUnits("100000000") ? n : null;
  } catch {
    return null;
  }
}

const TOTAL_PATTERNS: RegExp[] = [
  /\b(?:grand\s*total|total\s*amount|amount\s*due|total\s*due|balance\s*due|amount\s*payable|net\s*payable|total\s*payable|net\s*amount|total\s*(?:inr|usd|eur|gbp|rs\.?))\b/i,
  /\b(?:total)\b/i,
];
const NOT_TOTAL = /\b(sub\s*-?\s*total|total\s*(?:tax|vat|gst|items?|qty|quantity|savings?|discount)|items?\s*total|no\.?\s*of)\b/i;

function amountsIn(line: string): string[] {
  const out: string[] = [];
  const re = new RegExp(NUM, "g");
  for (const m of line.matchAll(re)) {
    // Skip percentages ("GST 18%") and things that look like dates/times.
    const after = line.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 1);
    if (after === "%" || after === ":" || after === "/") continue;
    const a = parseReceiptAmount(m[0]);
    if (a) out.push(a);
  }
  return out;
}

function findTotal(lines: string[]): string | null {
  for (const pattern of TOTAL_PATTERNS) {
    // Receipts print the final total near the bottom; scan from the end.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!pattern.test(line) || NOT_TOTAL.test(line)) continue;
      const here = amountsIn(line.replace(pattern, " "));
      if (here.length) return here[here.length - 1];
      const next = lines[i + 1] ? amountsIn(lines[i + 1]) : [];
      if (next.length) return next[0];
    }
  }
  return null;
}

function findTax(lines: string[]): string | null {
  const total = lines.find((l) => /\btotal\s*(tax|vat|gst)\b/i.test(l));
  if (total) return amountsIn(total.replace(/\d+(?:\.\d+)?\s*%/g, " ")).pop() ?? null;
  const parts = lines.filter((l) => /\b(c\s*gst|s\s*gst|i\s*gst|u\s*gst|vat|sales\s*tax|tax|gst)\b/i.test(l) && !/\b(incl|inclusive|exclusive|excl|gstin|tax\s*invoice|tax\s*id|vat\s*(no|reg|number))\b/i.test(l));
  const amounts = parts.map((l) => amountsIn(l.replace(/\d+(?:\.\d+)?\s*%/g, " ")).pop()).filter((x): x is string => Boolean(x));
  if (!amounts.length) return null;
  // CGST + SGST style receipts list each half separately.
  if (parts.some((l) => /c\s*gst/i.test(l)) && parts.some((l) => /s\s*gst/i.test(l))) {
    return add(...amounts);
  }
  return amounts[0];
}

function validDate(y: number, m: number, d: number, today?: ISODate): ISODate | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (!isISODate(iso)) return null;
  if (today && iso > today) return null; // receipts aren't from the future
  if (y < 2000) return null;
  return iso;
}

/** Find a purchase date. `dayFirst` decides ambiguous 03/04/2026 (true outside the US). */
export function findReceiptDate(text: string, opts: { today?: ISODate; dayFirst?: boolean } = {}): ISODate | null {
  const t = text.toLowerCase();
  const iso = t.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) {
    const d = validDate(+iso[1], +iso[2], +iso[3], opts.today);
    if (d) return d;
  }
  for (const m of t.matchAll(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g)) {
    const a = +m[1];
    const b = +m[2];
    const y = +m[3];
    const dayFirst = a > 12 ? true : b > 12 ? false : (opts.dayFirst ?? true);
    const d = dayFirst ? validDate(y, b, a, opts.today) : validDate(y, a, b, opts.today);
    if (d) return d;
  }
  const named = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-/.,']*(\d{2,4})\b/);
  if (named) {
    const d = validDate(+named[3], MONTHS.indexOf(named[2]) + 1, +named[1], opts.today);
    if (d) return d;
  }
  const us = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (us) {
    const d = validDate(+us[3], MONTHS.indexOf(us[1]) + 1, +us[2], opts.today);
    if (d) return d;
  }
  return null;
}

const CURRENCY_HINTS: [RegExp, string][] = [
  [/₹|\binr\b|\brs\.?\s*\d|\brupees?\b/i, "INR"],
  [/€|\beur\b/i, "EUR"],
  [/£|\bgbp\b/i, "GBP"],
  [/\baed\b|\bdhs?\b/i, "AED"],
  [/\bsgd\b|\bs\$/i, "SGD"],
  [/\bcad\b|\bc\$/i, "CAD"],
  [/\baud\b|\ba\$/i, "AUD"],
  [/¥|\bjpy\b/i, "JPY"],
  [/\busd\b|\$/i, "USD"],
];

const SKIP_MERCHANT = /\b(receipt|invoice|tax invoice|bill|welcome|thank|gstin|vat|phone|tel|date|time|cashier|order|table|www\.|http|@|customer|copy)\b/i;

function findMerchant(lines: string[]): string | null {
  for (const raw of lines.slice(0, 8)) {
    const line = raw.replace(/[|*_=~#<>]+/g, " ").replace(/\s+/g, " ").trim();
    const letters = (line.match(/[a-z]/gi) ?? []).length;
    if (line.length < 3 || line.length > 48 || letters < 3 || letters / line.length < 0.5 || SKIP_MERCHANT.test(line)) continue;
    const clean = line.replace(/[^\p{L}\p{N}&'.\- ]/gu, "").trim();
    if (!clean) continue;
    return clean === clean.toUpperCase() ? clean.toLowerCase().replace(/(^|[\s\-&])(\p{L})/gu, (_m, pre: string, c: string) => pre + c.toUpperCase()) : clean;
  }
  return null;
}

function findItems(lines: string[]): { name: string; amount: string }[] {
  const out: { name: string; amount: string }[] = [];
  const skip = /\b(total|subtotal|sub total|tax|gst|vat|cgst|sgst|change|cash|card|tender|balance|amount|round|discount|paid|due|tip|visa|mastercard|upi|qty)\b/i;
  for (const line of lines) {
    const m = line.match(/^\s*(?:\d+\s*[x×@]\s*)?([\p{L}][\p{L}\p{N}&'().,/\- ]{1,50}?)\s+(?:[₹$€£]|rs\.?)?\s*(\d+[.,]\d{2})\s*[a-z]?\s*$/iu);
    if (!m || skip.test(m[1])) continue;
    const amount = parseReceiptAmount(m[2]);
    if (amount) out.push({ name: m[1].trim().replace(/\s+/g, " ").slice(0, 60), amount });
    if (out.length >= 30) break;
  }
  return out;
}

export function paymentHint(text: string): PaymentHint | null {
  if (/\b(upi|gpay|google pay|phonepe|paytm|bhim)\b/i.test(text)) return "upi";
  if (/\b(visa|mastercard|master card|amex|american express|rupay|debit|credit|card\s*(?:no|number|ending)|xx{2,}\d{4}|\*{2,}\d{4})\b/i.test(text)) return "card";
  if (/\b(apple pay|google wallet|wallet)\b/i.test(text)) return "wallet";
  if (/\bcash\b/i.test(text)) return "cash";
  return null;
}

export function extractReceiptLocally(text: string, opts: { today?: ISODate; dayFirst?: boolean } = {}): ReceiptExtraction {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let currency: string | null = null;
  for (const [re, code] of CURRENCY_HINTS)
    if (re.test(text)) {
      currency = code;
      break;
    }
  return {
    merchant: findMerchant(lines),
    date: findReceiptDate(text, opts),
    total: findTotal(lines),
    tax: findTax(lines),
    currency,
    paymentMethod: paymentHint(text),
    items: findItems(lines),
  };
}

/** True when the digits of `amount` appear in the text (guards against invented totals). */
export function amountAppearsIn(amount: string, text: string): boolean {
  const [w, f = ""] = normalize(amount).split(".");
  const frac = f.replace(/0+$/, "");
  const digits = text.replace(/[\s,.]/g, "");
  const want = frac ? `${w}${frac.padEnd(2, "0")}` : w;
  return digits.includes(want) || (!frac && digits.includes(`${w}00`));
}
