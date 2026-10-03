import { describe, expect, it } from "vitest";
import { matchCategory, parseTransactionLocally } from "@/lib/nl-parse";

const TODAY = "2026-10-03"; // a Saturday

describe("local natural-language parser — spec examples", () => {
  it('"Spent 450 at Starbucks today."', () => {
    const d = parseTransactionLocally("Spent 450 at Starbucks today.", TODAY);
    expect(d).toMatchObject({ type: "expense", amount: "450.0000", date: TODAY, merchant: "Starbucks", categoryHint: "Coffee", notes: null });
    expect(d.uncertain).toEqual([]);
  });

  it('"120 Uber."', () => {
    const d = parseTransactionLocally("120 Uber.", TODAY);
    expect(d).toMatchObject({ type: "expense", amount: "120.0000", date: TODAY, merchant: "Uber", categoryHint: "Taxi & rideshare" });
  });

  it('"Bought shoes for 5000." — the item is a note, not a merchant', () => {
    const d = parseTransactionLocally("Bought shoes for 5000.", TODAY);
    expect(d).toMatchObject({ type: "expense", amount: "5000.0000", merchant: null, notes: "Shoes", categoryHint: "Clothing" });
    expect(d.uncertain).toContain("merchant");
  });

  it('"Paid 2000 for electricity."', () => {
    const d = parseTransactionLocally("Paid 2000 for electricity.", TODAY);
    expect(d).toMatchObject({ type: "expense", amount: "2000.0000", merchant: null, notes: "Electricity", categoryHint: "Electricity" });
  });

  it('"got salary 85k yesterday"', () => {
    const d = parseTransactionLocally("got salary 85k yesterday", TODAY);
    expect(d).toMatchObject({ type: "income", amount: "85000.0000", date: "2026-10-02", merchant: null, notes: "Salary", categoryHint: "Salary" });
  });
});

describe("local parser — edge cases", () => {
  it("doesn't read a leading date as the amount", () => {
    expect(parseTransactionLocally("2026-09-28 paid 300 for groceries", TODAY)).toMatchObject({ amount: "300.0000", date: "2026-09-28", categoryHint: "Groceries" });
    expect(parseTransactionLocally("5 oct spent 300 at Zara", TODAY)).toMatchObject({ amount: "300.0000", date: "2025-10-05", merchant: "Zara" });
  });

  it("handles thousands separators, decimals, currency symbols and suffixes", () => {
    expect(parseTransactionLocally("₹1,25,000 rent", TODAY)).toMatchObject({ amount: "125000.0000", currency: "INR", categoryHint: "Rent" });
    expect(parseTransactionLocally("$12.50 coffee at Blue Bottle", TODAY)).toMatchObject({ amount: "12.5000", currency: "USD", merchant: "Blue Bottle" });
    expect(parseTransactionLocally("received 1.5 lakh bonus", TODAY)).toMatchObject({ type: "income", amount: "150000.0000", categoryHint: "Bonus" });
  });

  it("relative dates", () => {
    expect(parseTransactionLocally("lunch 300 3 days ago", TODAY)).toMatchObject({ amount: "300.0000", date: "2026-09-30" });
    expect(parseTransactionLocally("dinner 800 last friday", TODAY)).toMatchObject({ date: "2026-10-02" });
    expect(parseTransactionLocally("taxi 200 day before yesterday", TODAY)).toMatchObject({ date: "2026-10-01" });
  });

  it("reports a missing amount instead of inventing one", () => {
    const d = parseTransactionLocally("coffee at Starbucks", TODAY);
    expect(d.amount).toBeNull();
    expect(d.uncertain).toContain("amount");
  });

  it("'paid' wins over income words (paying for a subscription isn't income)", () => {
    expect(parseTransactionLocally("paid 499 netflix subscription", TODAY).type).toBe("expense");
  });

  it("matchCategory matches the user's own names (exact, partial) within the right kind", () => {
    const cats = [
      { id: "1", name: "Coffee", kind: "expense" },
      { id: "2", name: "Taxi & rideshare", kind: "expense" },
      { id: "3", name: "Salary", kind: "income" },
      { id: "4", name: "Electricity bill", kind: "expense" },
    ];
    expect(matchCategory("Coffee", cats, "expense")?.id).toBe("1");
    expect(matchCategory("Electricity", cats, "expense")?.id).toBe("4");
    expect(matchCategory("Salary", cats, "expense")).toBeNull();
    expect(matchCategory("Salary", cats, "income")?.id).toBe("3");
    expect(matchCategory(null, cats, "expense")).toBeNull();
  });
});
