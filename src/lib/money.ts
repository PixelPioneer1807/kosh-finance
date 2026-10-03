/**
 * Exact decimal money arithmetic.
 *
 * Amounts travel as decimal strings ("1234.5600") — the same representation Postgres `numeric`
 * uses. Internally we scale to BigInt with 4 fractional digits, so addition, subtraction and
 * comparison are exact. Multiplication/division (FX, percentages) round half-away-from-zero
 * back to 4 digits. Floats are only used for chart geometry and percentages for display.
 */

export const SCALE = 4;
const FACTOR = BigInt(10 ** SCALE);
const DECIMAL_RE = /^[-+]?(\d+)(\.(\d+))?$/;

export type MoneyInput = string | number | bigint | null | undefined;

export class MoneyParseError extends Error {}

/** Parse a decimal string/number into scaled BigInt units (1 unit = 0.0001). */
export function toUnits(value: MoneyInput): bigint {
  if (value === null || value === undefined || value === "") return BigInt(0);
  if (typeof value === "bigint") return value * FACTOR;
  let str = typeof value === "number" ? numberToPlain(value) : value.trim().replace(/[,_\s]/g, "");
  if (str.startsWith(".")) str = "0" + str;
  if (str.startsWith("-.")) str = "-0" + str.slice(1);
  const m = DECIMAL_RE.exec(str);
  if (!m) throw new MoneyParseError(`Invalid amount: ${String(value)}`);
  const negative = str.startsWith("-");
  const whole = BigInt(m[1]);
  const fracRaw = m[3] ?? "";
  // Round half away from zero at SCALE digits.
  const frac = fracRaw.padEnd(SCALE + 1, "0");
  let units = whole * FACTOR + BigInt(frac.slice(0, SCALE));
  if (Number(frac[SCALE]) >= 5) units += BigInt(1);
  return negative ? -units : units;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyParseError(`Invalid amount: ${n}`);
  // toFixed(10) avoids exponent notation for typical values; trailing zeros are harmless.
  return n.toFixed(10);
}

/** Scaled units back to a canonical decimal string with SCALE digits. */
export function fromUnits(units: bigint): string {
  const negative = units < BigInt(0);
  const abs = negative ? -units : units;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

export const normalize = (v: MoneyInput) => fromUnits(toUnits(v));
export const add = (...vals: MoneyInput[]) => fromUnits(vals.reduce<bigint>((s, v) => s + toUnits(v), BigInt(0)));
export const sub = (a: MoneyInput, b: MoneyInput) => fromUnits(toUnits(a) - toUnits(b));
export const neg = (a: MoneyInput) => fromUnits(-toUnits(a));
export const abs = (a: MoneyInput) => {
  const u = toUnits(a);
  return fromUnits(u < BigInt(0) ? -u : u);
};
export const cmp = (a: MoneyInput, b: MoneyInput) => {
  const d = toUnits(a) - toUnits(b);
  return d === BigInt(0) ? 0 : d > BigInt(0) ? 1 : -1;
};
export const eq = (a: MoneyInput, b: MoneyInput) => cmp(a, b) === 0;
export const isZero = (a: MoneyInput) => toUnits(a) === BigInt(0);
export const isPositive = (a: MoneyInput) => toUnits(a) > BigInt(0);
export const isNegative = (a: MoneyInput) => toUnits(a) < BigInt(0);
export const sum = (vals: MoneyInput[]) => add(...vals);
export const max = (a: MoneyInput, b: MoneyInput) => (cmp(a, b) >= 0 ? normalize(a) : normalize(b));
export const min = (a: MoneyInput, b: MoneyInput) => (cmp(a, b) <= 0 ? normalize(a) : normalize(b));

/** Divide two scaled BigInts rounding half away from zero. */
function divRound(n: bigint, d: bigint): bigint {
  if (d === BigInt(0)) throw new RangeError("Division by zero");
  const negative = n < BigInt(0) !== d < BigInt(0);
  const an = n < BigInt(0) ? -n : n;
  const ad = d < BigInt(0) ? -d : d;
  let q = an / ad;
  if ((an % ad) * BigInt(2) >= ad) q += BigInt(1);
  return negative ? -q : q;
}

/** a × factor, where factor is a decimal (e.g. FX rate "83.1234567"). Exact up to rounding at 4dp. */
export function mul(a: MoneyInput, factor: string | number): string {
  const f = typeof factor === "number" ? numberToPlain(factor) : factor.trim();
  const m = DECIMAL_RE.exec(f);
  if (!m) throw new MoneyParseError(`Invalid factor: ${factor}`);
  const fracDigits = (m[3] ?? "").length;
  const fUnits = BigInt(f.replace(".", "").replace("+", ""));
  const product = toUnits(a) * fUnits;
  return fromUnits(divRound(product, BigInt(10) ** BigInt(fracDigits)));
}

/** a ÷ divisor (divisor is a plain integer count, e.g. days). */
export function divInt(a: MoneyInput, divisor: number): string {
  return fromUnits(divRound(toUnits(a), BigInt(Math.trunc(divisor))));
}

/** a / b as a JS number ratio — for percentages and chart geometry only. */
export function ratio(a: MoneyInput, b: MoneyInput): number {
  const bu = toUnits(b);
  if (bu === BigInt(0)) return 0;
  // Keep 6 decimal places of precision in the ratio.
  return Number(divRound(toUnits(a) * BigInt(1_000_000), bu)) / 1_000_000;
}

/** Convert to a JS number for charts. Never use the result for further money arithmetic. */
export const toNumber = (a: MoneyInput) => Number(fromUnits(toUnits(a)));

/** Allocate `total` into `parts` equal pieces that add up exactly (remainder spread on the first). */
export function allocateEvenly(total: MoneyInput, parts: number, decimals = 2): string[] {
  const step = BigInt(10 ** (SCALE - decimals));
  const totalSteps = toUnits(total) / step;
  const base = totalSteps / BigInt(parts);
  let remainder = totalSteps - base * BigInt(parts);
  return Array.from({ length: parts }, () => {
    let s = base;
    if (remainder > BigInt(0)) {
      s += BigInt(1);
      remainder -= BigInt(1);
    }
    return fromUnits(s * step);
  });
}

/* ───────────── Currency metadata & formatting ───────────── */

export const CURRENCIES: { code: string; name: string }[] = [
  { code: "USD", name: "US Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "INR", name: "Indian Rupee" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CNY", name: "Chinese Yuan" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "HKD", name: "Hong Kong Dollar" },
  { code: "AED", name: "UAE Dirham" },
  { code: "SAR", name: "Saudi Riyal" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" },
  { code: "PLN", name: "Polish Złoty" },
  { code: "CZK", name: "Czech Koruna" },
  { code: "HUF", name: "Hungarian Forint" },
  { code: "TRY", name: "Turkish Lira" },
  { code: "ZAR", name: "South African Rand" },
  { code: "NGN", name: "Nigerian Naira" },
  { code: "KES", name: "Kenyan Shilling" },
  { code: "EGP", name: "Egyptian Pound" },
  { code: "BRL", name: "Brazilian Real" },
  { code: "MXN", name: "Mexican Peso" },
  { code: "ARS", name: "Argentine Peso" },
  { code: "CLP", name: "Chilean Peso" },
  { code: "COP", name: "Colombian Peso" },
  { code: "KRW", name: "South Korean Won" },
  { code: "IDR", name: "Indonesian Rupiah" },
  { code: "MYR", name: "Malaysian Ringgit" },
  { code: "THB", name: "Thai Baht" },
  { code: "PHP", name: "Philippine Peso" },
  { code: "VND", name: "Vietnamese Dong" },
  { code: "PKR", name: "Pakistani Rupee" },
  { code: "BDT", name: "Bangladeshi Taka" },
  { code: "LKR", name: "Sri Lankan Rupee" },
  { code: "NPR", name: "Nepalese Rupee" },
  { code: "ILS", name: "Israeli Shekel" },
  { code: "KWD", name: "Kuwaiti Dinar" },
  { code: "QAR", name: "Qatari Riyal" },
  { code: "BHD", name: "Bahraini Dinar" },
  { code: "OMR", name: "Omani Rial" },
  { code: "RUB", name: "Russian Ruble" },
  { code: "UAH", name: "Ukrainian Hryvnia" },
  { code: "RON", name: "Romanian Leu" },
  { code: "TWD", name: "New Taiwan Dollar" },
];

export const CURRENCY_CODES = new Set(CURRENCIES.map((c) => c.code));

export function isValidCurrency(code: string): boolean {
  if (CURRENCY_CODES.has(code)) return true;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return /^[A-Z]{3}$/.test(code);
  } catch {
    return false;
  }
}

export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

const fmtCache = new Map<string, Intl.NumberFormat>();
function getFormatter(key: string, make: () => Intl.NumberFormat) {
  let f = fmtCache.get(key);
  if (!f) {
    f = make();
    fmtCache.set(key, f);
  }
  return f;
}

export type FormatOptions = {
  locale?: string;
  /** Show compact notation (1.2K, 3.4M). */
  compact?: boolean;
  /** Always show a sign (+/−). */
  signed?: boolean;
  /** Hide the fractional part when it's zero. */
  trimZeros?: boolean;
};

/**
 * Format a decimal string as currency. Intl.NumberFormat accepts decimal strings directly and
 * formats them exactly (no float conversion).
 */
export function formatMoney(value: MoneyInput, currency: string, opts: FormatOptions = {}): string {
  const locale = opts.locale ?? "en-US";
  const v = normalize(value);
  const decimals = currencyDecimals(currency);
  const key = `${locale}|${currency}|${opts.compact}|${opts.signed}|${opts.trimZeros}|${decimals}`;
  const f = getFormatter(key, () => {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        notation: opts.compact ? "compact" : "standard",
        signDisplay: opts.signed ? "exceptZero" : "auto",
        minimumFractionDigits: opts.compact || (opts.trimZeros && isWhole(v)) ? 0 : decimals,
        maximumFractionDigits: opts.compact ? 1 : decimals,
      });
    } catch {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals });
    }
  });
  // Intl.NumberFormat.format accepts strings as exact decimals (ES2023); cast for older TS libs.
  return f.format(v as unknown as number);
}

function isWhole(v: string) {
  return /\.0+$/.test(v) || !v.includes(".");
}

export function currencySymbol(currency: string, locale = "en-US"): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0);
    return parts.find((p) => p.type === "currency")?.value ?? currency;
  } catch {
    return currency;
  }
}

/** Trim a canonical decimal for editing in an input ("1200.5000" → "1200.5"). */
export function toInputValue(value: MoneyInput): string {
  if (value === null || value === undefined || value === "") return "";
  const n = normalize(value);
  return n.replace(/\.?0+$/, "");
}
