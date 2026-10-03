/**
 * CSV import helpers shared by the browser (preview) and the server (authoritative re-parse).
 * Pure functions only — no database, no Node APIs — so the server can re-run exactly the same
 * interpretation on the raw cells the client sends instead of trusting client-side parsing.
 */
import Papa from "papaparse";
import { z } from "zod";
import { isISODate } from "./dates";
import { fromUnits, normalize, toUnits } from "./money";

export const MAX_IMPORT_ROWS = 10_000;
export const IMPORT_CHUNK_SIZE = 500;
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_COLUMNS = 100;

/* ───────────── CSV text → rows ───────────── */

export type ParsedCsv = { headers: string[]; rows: string[][]; delimiter: string; errors: string[] };

/** Parse CSV text (handles UTF-8 BOM, `,` `;` tab `|` delimiters, quoted fields with newlines). */
export function parseCsvText(text: string, opts: { hasHeader?: boolean } = {}): ParsedCsv {
  const clean = text.replace(/^﻿/, "");
  const res = Papa.parse<string[]>(clean, {
    skipEmptyLines: "greedy",
    delimitersToGuess: [",", ";", "\t", "|"],
  });
  const all = (res.data as string[][]).map((r) => r.slice(0, MAX_COLUMNS).map((c) => (typeof c === "string" ? c : String(c ?? ""))));
  const errors = res.errors
    .filter((e) => e.code !== "UndetectableDelimiter")
    .slice(0, 20)
    .map((e) => (e.row !== undefined ? `Row ${e.row + 1}: ${e.message}` : e.message));
  const hasHeader = opts.hasHeader ?? true;
  const width = Math.max(0, ...all.map((r) => r.length));
  const headers = hasHeader && all.length ? all[0].map((h, i) => h.trim() || `Column ${i + 1}`) : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  while (headers.length < width) headers.push(`Column ${headers.length + 1}`);
  return { headers, rows: hasHeader ? all.slice(1) : all, delimiter: res.meta.delimiter, errors };
}

/* ───────────── Dates ───────────── */

export const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-MM-YYYY", "D MMM YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
function build(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1900 || y > 2200) return null;
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isISODate(iso) ? iso : null;
}

/** Parse a date cell in the given format into YYYY-MM-DD, or null. A trailing time part is ignored. */
export function parseDateValue(raw: string | null | undefined, format: DateFormat): string | null {
  if (!raw) return null;
  const s = raw.trim().replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i, "").trim();
  let m: RegExpExecArray | null;
  switch (format) {
    case "YYYY-MM-DD":
      m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
      return m ? build(+m[1], +m[2], +m[3]) : null;
    case "DD/MM/YYYY":
      m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(s);
      return m ? build(+m[3], +m[2], +m[1]) : null;
    case "MM/DD/YYYY":
      m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/.exec(s);
      return m ? build(+m[3], +m[1], +m[2]) : null;
    case "DD-MM-YYYY":
      m = /^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/.exec(s);
      return m ? build(+m[3], +m[2], +m[1]) : null;
    case "D MMM YYYY": {
      m = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]+([A-Za-z]{3,9})\.?,?[\s\-/.]+(\d{2}|\d{4})$/.exec(s);
      if (m) {
        const mon = MONTHS[m[2].toLowerCase()];
        return mon ? build(+m[3], mon, +m[1]) : null;
      }
      // Also accept "Oct 1, 2026".
      m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
      if (m) {
        const mon = MONTHS[m[1].toLowerCase()];
        return mon ? build(+m[3], mon, +m[2]) : null;
      }
      return null;
    }
  }
}

/**
 * Pick the date format that parses every sample. DD/MM vs MM/DD is decided by evidence
 * (a first part > 12 means day-first); when nothing disambiguates, `ambiguous` is true.
 */
export function detectDateFormat(samples: string[]): { format: DateFormat | null; ambiguous: boolean; candidates: DateFormat[] } {
  const values = samples.map((s) => s?.trim()).filter(Boolean).slice(0, 500);
  if (!values.length) return { format: null, ambiguous: false, candidates: [] };
  const scores = DATE_FORMATS.map((f) => ({ f, ok: values.filter((v) => parseDateValue(v, f)).length }));
  const best = Math.max(...scores.map((s) => s.ok));
  if (best === 0) return { format: null, ambiguous: false, candidates: [] };
  const candidates = scores.filter((s) => s.ok === best).map((s) => s.f);
  if (candidates.length === 1) return { format: candidates[0], ambiguous: false, candidates };
  if (candidates.includes("DD/MM/YYYY") && candidates.includes("MM/DD/YYYY")) {
    // Both parse everything → no part was ever > 12; genuinely ambiguous. Prefer day-first.
    return { format: "DD/MM/YYYY", ambiguous: true, candidates };
  }
  return { format: candidates[0], ambiguous: candidates.length > 1, candidates };
}

/* ───────────── Amounts ───────────── */

export type DecimalSeparator = "." | ",";

/**
 * Parse an amount cell into a signed canonical decimal ("-1234.5600"), or null.
 * Handles currency symbols/codes, thousands separators ("1,234.56", "1.234,56", "1 234,56", "1'234.56"),
 * accounting negatives "(12.50)", trailing minus "12.50-", and "CR"/"DR" suffixes.
 */
export function parseAmountValue(raw: string | null | undefined, decimal: DecimalSeparator = "."): string | null {
  if (raw === null || raw === undefined) return null;
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  const crdr = /\s*(CR|DR)\.?$/i.exec(s);
  if (crdr) {
    if (crdr[1].toUpperCase() === "DR") negative = !negative;
    s = s.slice(0, crdr.index).trim();
  }
  // Strip currency symbols / codes and spaces (incl. NBSP / thin spaces used as thousands separators).
  s = s.replace(/[A-Za-z$€£¥₹₩₦₱₪₫฿₴₽₺₸₡₲₵₭₮₼₾﷼]/g, "").replace(/[\s  ']/g, "");
  s = s.replace(/[−‒–—]/g, "-"); // unicode minus/dashes
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  if (!s || !/^[\d.,]+$/.test(s)) return null;
  const thousands = decimal === "." ? "," : ".";
  // Thousands separators must form groups of three; otherwise the value is malformed.
  const [intPart, ...rest] = s.split(decimal);
  if (rest.length > 1) return null;
  const frac = rest[0] ?? "";
  if (frac.includes(thousands)) return null;
  if (intPart.includes(thousands)) {
    if (!new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})+$`).test(intPart)) return null;
  }
  const digits = intPart.split(thousands).join("");
  if (!/^\d*$/.test(digits) || !/^\d*$/.test(frac) || (!digits && !frac)) return null;
  try {
    const n = normalize(`${digits || "0"}${frac ? "." + frac : ""}`);
    return negative && toUnits(n) !== BigInt(0) ? fromUnits(-toUnits(n)) : n;
  } catch {
    return null;
  }
}

/** Guess the decimal separator used by a column of amounts. */
export function detectDecimalSeparator(samples: string[]): DecimalSeparator {
  let dot = 0;
  let comma = 0;
  for (const raw of samples.slice(0, 500)) {
    const s = (raw ?? "").replace(/[^\d.,]/g, "");
    if (!s) continue;
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastComma > lastDot) comma++;
      else dot++;
      continue;
    }
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (!sep) continue;
    const after = s.length - s.lastIndexOf(sep) - 1;
    const count = s.split(sep).length - 1;
    if (count > 1) {
      // "1.234.567" → that separator is the thousands separator.
      if (sep === ".") comma++;
      else dot++;
    } else if (after !== 3) {
      if (sep === ".") dot++;
      else comma++;
    }
  }
  return comma > dot ? "," : ".";
}

/* ───────────── Text ───────────── */

/** Normalised description used for duplicate fingerprints. */
export function normalizeDescription(s: string | null | undefined): string {
  return (s ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Display text for a merchant cell (same rules the merchant service uses). */
export const cleanMerchant = (s: string | null | undefined) => (s ?? "").trim().replace(/\s+/g, " ").slice(0, 80);

export type ImportType = "expense" | "income" | "refund";

/** Interpret a "type" column value. Returns "transfer" so callers can reject it explicitly. */
export function parseTypeValue(raw: string | null | undefined): ImportType | "transfer" | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return null;
  if (/^(expense|expenses|debit|dr|withdrawal|payment|purchase|spend|spending|out|outflow|charge)$/.test(s)) return "expense";
  if (/^(income|credit|cr|deposit|salary|in|inflow|received)$/.test(s)) return "income";
  if (/^(refund|reversal|returned|return|cashback)$/.test(s)) return "refund";
  if (/^(transfer|xfer)$/.test(s)) return "transfer";
  return null;
}

/** "Food › Groceries", "Food > Groceries", "Food: Groceries", "Food / Groceries" → parent + child. */
export function splitCategoryPath(raw: string | null | undefined): { parent: string | null; name: string } | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const parts = s.split(/\s*(?:›|>|:|\/)\s*/).filter(Boolean);
  if (parts.length >= 2) return { parent: parts[0].slice(0, 50), name: parts.slice(1).join(" ").slice(0, 50) };
  return { parent: null, name: s.slice(0, 50) };
}

/* ───────────── Mapping & options ───────────── */

const col = z.number().int().min(0).max(MAX_COLUMNS - 1).nullable().default(null);

export const importMappingSchema = z.object({
  date: z.number().int().min(0).max(MAX_COLUMNS - 1),
  amount: col,
  debit: col,
  credit: col,
  description: col,
  merchant: col,
  category: col,
  account: col,
  notes: col,
  type: col,
});
export type ImportMapping = z.output<typeof importMappingSchema>;

export const importParseOptionsSchema = z.object({
  dateFormat: z.enum(DATE_FORMATS),
  decimalSeparator: z.enum([".", ","]),
  /** "signed": one amount column; "split": separate debit (money out) / credit (money in) columns. */
  amountMode: z.enum(["signed", "split"]),
  /** For signed amounts: are negative numbers expenses (bank statements) or positive (card statements)? */
  signConvention: z.enum(["negative_expense", "positive_expense"]),
});
export type ImportParseOptions = z.output<typeof importParseOptionsSchema>;

export type InterpretedRow = {
  date: string | null;
  /** Positive magnitude. */
  amount: string | null;
  type: ImportType | null;
  merchant: string | null;
  notes: string | null;
  category: { parent: string | null; name: string } | null;
  accountName: string | null;
  errors: string[];
};

const cell = (cells: string[], i: number | null) => (i === null || i === undefined ? "" : (cells[i] ?? "").trim());

/** Turn one CSV record into a typed draft (no database lookups). */
export function interpretRow(cells: string[], mapping: ImportMapping, opts: ImportParseOptions): InterpretedRow {
  const errors: string[] = [];
  const rawDate = cell(cells, mapping.date);
  const date = parseDateValue(rawDate, opts.dateFormat);
  if (!rawDate) errors.push("Date is missing");
  else if (!date) errors.push(`Can't read date "${rawDate.slice(0, 30)}" as ${opts.dateFormat}`);

  let signed: string | null = null;
  if (opts.amountMode === "split") {
    const dRaw = cell(cells, mapping.debit);
    const cRaw = cell(cells, mapping.credit);
    const d = dRaw ? parseAmountValue(dRaw, opts.decimalSeparator) : null;
    const c = cRaw ? parseAmountValue(cRaw, opts.decimalSeparator) : null;
    if (dRaw && d === null) errors.push(`Can't read debit "${dRaw.slice(0, 30)}"`);
    if (cRaw && c === null) errors.push(`Can't read credit "${cRaw.slice(0, 30)}"`);
    const du = d ? toUnits(d) : BigInt(0);
    const cu = c ? toUnits(c) : BigInt(0);
    const abs = (u: bigint) => (u < BigInt(0) ? -u : u);
    if (du !== BigInt(0) && cu !== BigInt(0)) signed = fromUnits(abs(cu) - abs(du));
    else if (du !== BigInt(0)) signed = fromUnits(-abs(du));
    else if (cu !== BigInt(0)) signed = fromUnits(abs(cu));
    else if (!errors.length) errors.push("Amount is missing");
  } else {
    const aRaw = cell(cells, mapping.amount);
    const a = parseAmountValue(aRaw, opts.decimalSeparator);
    if (!aRaw) errors.push("Amount is missing");
    else if (a === null) errors.push(`Can't read amount "${aRaw.slice(0, 30)}"`);
    else signed = opts.signConvention === "positive_expense" ? fromUnits(-toUnits(a)) : a;
  }

  let amount: string | null = null;
  let type: ImportType | null = null;
  if (signed !== null) {
    const u = toUnits(signed);
    if (u === BigInt(0)) errors.push("Amount is zero");
    else {
      amount = fromUnits(u < BigInt(0) ? -u : u);
      type = u < BigInt(0) ? "expense" : "income";
    }
  }
  const typeRaw = cell(cells, mapping.type);
  if (typeRaw) {
    const t = parseTypeValue(typeRaw);
    if (t === "transfer") errors.push("Transfers can't be imported — record them as a transfer in the app");
    else if (t) type = t;
    else errors.push(`Unknown type "${typeRaw.slice(0, 20)}"`);
  }

  const desc = cell(cells, mapping.description);
  const merchantRaw = cell(cells, mapping.merchant);
  const merchant = cleanMerchant(merchantRaw || desc) || null;
  const notesParts = [cell(cells, mapping.notes)];
  if (merchantRaw && desc && normalizeDescription(desc) !== normalizeDescription(merchantRaw)) notesParts.push(desc);
  if (!merchantRaw && desc.length > 80) notesParts.push(desc);
  const notes = notesParts.filter(Boolean).join(" · ").slice(0, 1000) || null;

  return {
    date,
    amount,
    type,
    merchant,
    notes,
    category: splitCategoryPath(cell(cells, mapping.category)),
    accountName: cell(cells, mapping.account) || null,
    errors,
  };
}

/** Signed amount for fingerprints: money in positive, money out negative. */
export function signedForHash(type: string, amount: string) {
  const n = normalize(amount);
  return type === "expense" ? fromUnits(-toUnits(n)) : n;
}

/** Fingerprint body (without the user id) — identical rows produce identical keys. */
export function duplicateKey(accountId: string, date: string, type: string, amount: string, description: string | null | undefined) {
  return `${accountId}|${date}|${signedForHash(type, amount)}|${normalizeDescription(description)}`;
}

/** Guess which column holds what, from header names. */
export function guessMapping(headers: string[]): Partial<Record<keyof ImportMapping, number | null>> {
  const find = (...res: RegExp[]) => {
    for (const re of res) {
      const i = headers.findIndex((h) => re.test(h.trim().toLowerCase()));
      if (i >= 0) return i;
    }
    return null;
  };
  return {
    date: find(/^(transaction |posting |value |txn )?date$/, /date/),
    amount: find(/^amount$/, /amount|value|sum/),
    debit: find(/^(debit|withdrawal|withdrawals|money out|paid out|out)( amount)?$/, /debit|withdraw/),
    credit: find(/^(credit|deposit|deposits|money in|paid in|in)( amount)?$/, /credit|deposit/),
    description: find(/^(description|narration|details|memo|particulars|transaction details)$/, /desc|narrat|detail|memo/),
    merchant: find(/^(merchant|payee|vendor|name)$/, /payee|merchant/),
    category: find(/^category$/, /categ/),
    account: find(/^account( name)?$/),
    notes: find(/^(notes?|comment|remarks?)$/),
    type: find(/^(type|transaction type|dr\/cr|cr\/dr)$/),
  };
}
