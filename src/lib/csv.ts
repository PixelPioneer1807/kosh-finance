/**
 * CSV writing (RFC 4180) with spreadsheet formula-injection protection.
 *
 * Text cells that a spreadsheet would treat as a formula (starting with = + - @, a tab or a
 * carriage return — also after leading spaces) are prefixed with an apostrophe. Plain numbers
 * such as "-12.5000" are left alone so numeric columns stay numeric.
 */

export const CSV_BOM = "﻿";
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
const FORMULA_RE = /^\s*[=+\-@]|^[\t\r]/;

export type CsvValue = string | number | boolean | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : typeof value === "boolean" ? (value ? "true" : "false") : value;
  if (typeof value === "string" && !NUMERIC_RE.test(s) && FORMULA_RE.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(cells: CsvValue[]): string {
  return cells.map(csvCell).join(",") + "\r\n";
}

export function toCsv(rows: CsvValue[][], opts: { bom?: boolean } = {}): string {
  return (opts.bom ? CSV_BOM : "") + rows.map(csvRow).join("");
}

/** Round a decimal string to `decimals` places (half away from zero) for human-friendly CSVs. */
export function roundDecimal(value: string, decimals = 2): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return value;
  const [, sign, whole, frac = ""] = m;
  const digits = BigInt(whole + frac.padEnd(decimals + 1, "0").slice(0, decimals + 1));
  const rounded = (digits + BigInt(5)) / BigInt(10);
  const str = rounded.toString().padStart(decimals + 1, "0");
  const out = decimals ? `${str.slice(0, -decimals)}.${str.slice(-decimals)}` : str;
  return /^0(\.0*)?$/.test(out) ? out : sign + out;
}

/** Safe filename fragment (letters, digits, dashes). */
export const fileSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "export";
