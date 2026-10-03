/**
 * Deterministic natural-language transaction parser. Works offline and without AI;
 * the AI parser (src/server/ai/parse.ts) refines its output when available.
 *
 *   "Spent 450 at Starbucks today"  → expense 450, merchant Starbucks, today
 *   "120 Uber"                      → expense 120, merchant Uber
 *   "Bought shoes for 5000"         → expense 5000, notes "shoes", hint Clothing
 *   "Paid 2000 for electricity"     → expense 2000, hint Electricity
 *   "Got salary 85k yesterday"      → income 85000, hint Salary
 */
import { addDaysISO, isISODate, toISO, toDate, type ISODate } from "./dates";
import { mul, normalize } from "./money";

export type ParsedDraft = {
  type: "expense" | "income";
  amount: string | null;
  date: ISODate;
  merchant: string | null;
  notes: string | null;
  /** Free-text category hint to match against the user's categories. */
  categoryHint: string | null;
  currency: string | null;
  confidence: number;
  uncertain: string[];
};

const INCOME_WORDS = /\b(received|receive|got paid|earned|salary|income|paycheck|payday|bonus|refund(?:ed)?|cashback|interest|dividend|freelance|invoice paid|sold)\b/i;
const CURRENCY_SYMBOLS: Record<string, string> = { "₹": "INR", $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", rs: "INR", inr: "INR", usd: "USD", eur: "EUR", gbp: "GBP" };

/** Keyword → category-name hints (matched against the user's own category names, not hardcoded ids). */
export const KEYWORD_HINTS: [RegExp, string][] = [
  [/\b(starbucks|coffee|cafe|café|latte|espresso|chai|tea)\b/i, "Coffee"],
  [/\b(uber|ola|lyft|taxi|cab|rapido|auto|rickshaw)\b/i, "Taxi & rideshare"],
  [/\b(metro|bus|train|subway|transit|railway)\b/i, "Public transit"],
  [/\b(petrol|diesel|fuel|gas station|shell)\b/i, "Fuel"],
  [/\b(parking|toll)\b/i, "Parking & tolls"],
  [/\b(groceries|grocery|supermarket|vegetables|fruits|milk|bigbasket|blinkit|zepto|instamart|walmart|costco|tesco|aldi)\b/i, "Groceries"],
  [/\b(swiggy|zomato|doordash|ubereats|uber eats|deliveroo|food delivery)\b/i, "Food delivery"],
  [/\b(lunch|dinner|breakfast|restaurant|pizza|burger|dine|dining|mcdonald'?s|kfc|domino'?s|subway sandwich)\b/i, "Restaurants"],
  [/\b(electricity|electric bill|power bill)\b/i, "Electricity"],
  [/\b(water bill)\b/i, "Water"],
  [/\b(internet|wifi|broadband|fiber)\b/i, "Internet"],
  [/\b(phone bill|mobile recharge|recharge|airtel|jio|verizon|vodafone)\b/i, "Phone"],
  [/\b(rent)\b/i, "Rent"],
  [/\b(shoes|clothes|clothing|shirt|jeans|dress|jacket|zara|h&m|uniqlo|myntra)\b/i, "Clothing"],
  [/\b(phone|laptop|headphones|electronics|charger|gadget|iphone)\b/i, "Electronics"],
  [/\b(amazon|flipkart|shopping|mall)\b/i, "Shopping"],
  [/\b(netflix|spotify|prime|hotstar|youtube premium|subscription|icloud|chatgpt|disney)\b/i, "Subscriptions"],
  [/\b(movie|cinema|concert|game|tickets?)\b/i, "Entertainment"],
  [/\b(doctor|hospital|clinic|medical)\b/i, "Medical"],
  [/\b(pharmacy|medicine|meds|chemist)\b/i, "Pharmacy"],
  [/\b(gym|fitness|yoga)\b/i, "Fitness"],
  [/\b(flight|hotel|airbnb|travel|trip|holiday|vacation)\b/i, "Travel"],
  [/\b(course|tuition|books?|school|college|udemy|coursera)\b/i, "Education"],
  [/\b(haircut|salon|spa|barber)\b/i, "Personal Care"],
  [/\b(gift|donation|charity)\b/i, "Gifts & Donations"],
  [/\b(insurance|premium)\b/i, "Insurance"],
  [/\b(emi|loan)\b/i, "Loan & EMI"],
  [/\b(salary|paycheck|payday)\b/i, "Salary"],
  [/\b(freelance|client|invoice)\b/i, "Freelance"],
  [/\b(bonus)\b/i, "Bonus"],
  [/\b(interest)\b/i, "Interest"],
  [/\b(dividend)\b/i, "Investment income"],
  [/\b(cashback|reward)\b/i, "Cashback & rewards"],
];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const FILLER = new Set([
  "spent", "spend", "paid", "pay", "bought", "buy", "purchased", "for", "on", "at", "from", "to", "the", "a", "an", "of", "my", "some",
  "today", "yesterday", "tonight", "this", "morning", "evening", "afternoon", "got", "received", "earned", "via", "using", "with", "in",
  "rs", "inr", "usd", "eur", "gbp", "and", "was", "it", "i", "me", "expense", "income", "add", "an", "log", "record",
]);

function parseDate(text: string, today: ISODate): { date: ISODate; matched: string | null } {
  const t = text.toLowerCase();
  if (/\bday before yesterday\b/.test(t)) return { date: addDaysISO(today, -2), matched: "day before yesterday" };
  if (/\byesterday\b/.test(t)) return { date: addDaysISO(today, -1), matched: "yesterday" };
  if (/\b(today|tonight|this morning|this evening)\b/.test(t)) return { date: today, matched: null };
  const iso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && isISODate(iso[1])) return { date: iso[1], matched: iso[1] };
  const daysAgo = t.match(/\b(\d{1,2}) days? ago\b/);
  if (daysAgo) return { date: addDaysISO(today, -Number(daysAgo[1])), matched: daysAgo[0] };
  const last = t.match(/\b(?:last|on)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (last) {
    const target = WEEKDAYS.indexOf(last[1]);
    const cur = toDate(today).getDay();
    let diff = (cur - target + 7) % 7;
    if (diff === 0) diff = 7;
    return { date: addDaysISO(today, -diff), matched: last[0] };
  }
  // "5 oct", "oct 5", "5th october"
  const dm = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/) ?? null;
  const md = t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/) ?? null;
  if (dm || md) {
    const day = Number(dm ? dm[1] : md![2]);
    const month = MONTHS.indexOf((dm ? dm[2] : md![1]).slice(0, 3));
    const ref = toDate(today);
    let d = new Date(ref.getFullYear(), month, day);
    if (d > ref) d = new Date(ref.getFullYear() - 1, month, day);
    return { date: toISO(d), matched: (dm ?? md)![0] };
  }
  return { date: today, matched: null };
}

function parseAmount(text: string): { amount: string | null; matched: string | null; currency: string | null } {
  const m = text.match(/(₹|\$|€|£|¥|\brs\.?|\binr|\busd|\beur|\bgbp)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|lakh|lac|l|cr|m)?\b(?!\s*(?:days?|st|nd|rd|th)\b)/i);
  if (!m) return { amount: null, matched: null, currency: null };
  let n = normalize(m[2].replace(/,/g, ""));
  const suffix = m[3]?.toLowerCase();
  const mult = suffix === "k" ? "1000" : suffix === "lakh" || suffix === "lac" || suffix === "l" ? "100000" : suffix === "cr" ? "10000000" : suffix === "m" ? "1000000" : null;
  if (mult) n = mul(n, mult);
  const symbol = m[1]?.toLowerCase().replace(".", "") ?? null;
  return { amount: n, matched: m[0], currency: symbol ? (CURRENCY_SYMBOLS[symbol] ?? null) : null };
}

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

/** Brand names that read as a merchant even without "at"/"from" ("120 Uber"). Generic item words
 *  ("shoes", "salary", "coffee") are descriptions, not merchants. */
const BRAND_RE =
  /\b(starbucks|uber|ola|lyft|rapido|shell|bigbasket|blinkit|zepto|instamart|walmart|costco|tesco|aldi|swiggy|zomato|doordash|ubereats|uber eats|deliveroo|mcdonald'?s|kfc|domino'?s|airtel|jio|verizon|vodafone|zara|h&m|uniqlo|myntra|amazon|flipkart|netflix|spotify|hotstar|icloud|chatgpt|disney|airbnb|udemy|coursera)\b/i;
const PURCHASE_VERB = /^\s*(bought|purchased|ordered|got|paid for)\b/i;

export function parseTransactionLocally(input: string, today: ISODate): ParsedDraft {
  const text = input.trim().replace(/\s+/g, " ");
  const uncertain: string[] = [];
  // Dates first, so "2026-09-28 paid 300" or "5 oct spent 300" don't read the date as the amount.
  const { date, matched: dateText } = parseDate(text, today);
  let rest = text;
  if (dateText) rest = rest.replace(new RegExp(dateText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  const { amount, matched: amountText, currency } = parseAmount(rest);
  if (!amount) uncertain.push("amount");
  const type: ParsedDraft["type"] = INCOME_WORDS.test(text) && !/\b(paid|spent|bought)\b/i.test(text) ? "income" : "expense";

  if (amountText) rest = rest.replace(amountText, " ");

  // Merchant: words after "at" / "from" (income) / "to", up to a preposition.
  let merchant: string | null = null;
  const mm = rest.match(/\b(?:at|from|@|to)\s+([A-Za-z0-9&'.\- ]{2,40}?)(?=\s+(?:for|on|via|using|with|today|yesterday|by)\b|$|[,.;])/i);
  if (mm) merchant = mm[1].trim();

  // What was bought: words after "for" / "on", or leftover words.
  let what: string | null = null;
  const fm = rest.match(/\b(?:for|on)\s+([A-Za-z][A-Za-z0-9&' \-]{1,40}?)(?=\s+(?:at|from|via|using|with|today|yesterday)\b|$|[,.;])/i);
  if (fm) what = fm[1].trim();
  const leftover = rest
    .replace(merchant ?? "\u0000", " ")
    .replace(what ?? "\u0000", " ")
    .split(/[\s,.;]+/)
    .filter((w) => w && !FILLER.has(w.toLowerCase()));
  if (!merchant && !what && leftover.length) {
    const phrase = leftover.join(" ");
    // A short brand name ("Uber") reads as a merchant; "Bought shoes" / "salary" are descriptions.
    if (leftover.length <= 2 && BRAND_RE.test(phrase) && !PURCHASE_VERB.test(text)) merchant = phrase;
    else what = phrase;
  } else if (!what && leftover.length) what = leftover.join(" ");

  const hintSource = [merchant, what, text].filter(Boolean).join(" ");
  const categoryHint = KEYWORD_HINTS.find(([re]) => re.test(hintSource))?.[1] ?? null;
  if (!categoryHint) uncertain.push("category");
  if (!merchant && type === "expense") uncertain.push("merchant");

  const confidence = Math.max(0.2, 1 - uncertain.length * 0.25);
  return {
    type,
    amount,
    date,
    merchant: merchant ? titleCase(merchant) : null,
    notes: what ? what.charAt(0).toUpperCase() + what.slice(1) : null,
    categoryHint,
    currency,
    confidence,
    uncertain,
  };
}

/** Match a free-text hint against the user's category names (exact, then partial). */
export function matchCategory<T extends { id: string; name: string; kind: string }>(hint: string | null, categories: T[], kind: "expense" | "income"): T | null {
  if (!hint) return null;
  const pool = categories.filter((c) => c.kind === kind);
  const h = hint.toLowerCase();
  return (
    pool.find((c) => c.name.toLowerCase() === h) ??
    pool.find((c) => c.name.toLowerCase().includes(h) || h.includes(c.name.toLowerCase())) ??
    pool.find((c) => h.split(/\W+/).some((w) => w.length > 3 && c.name.toLowerCase().includes(w))) ??
    null
  );
}
