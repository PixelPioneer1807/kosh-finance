import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { importBatches, transactions } from "@/server/db/schema";
import {
  detectDateFormat,
  detectDecimalSeparator,
  guessMapping,
  interpretRow,
  parseAmountValue,
  parseCsvText,
  parseDateValue,
  type ImportMapping,
  type ImportParseOptions,
} from "@/lib/csv-import";
import { findExistingDuplicates, finishImportBatch, importChunk, importHash, listImportBatches, startImportBatch, undoImportBatch } from "@/server/services/import";
import { createTransaction } from "@/server/services/transactions";
import { accountBalances } from "@/server/services/accounts";
import { listCategories } from "@/server/services/taxonomy";
import { category, makeAccount, makeUser } from "./helpers";

const M = (m: Partial<ImportMapping>): ImportMapping => ({
  date: 0,
  amount: null,
  debit: null,
  credit: null,
  description: null,
  merchant: null,
  category: null,
  account: null,
  notes: null,
  type: null,
  ...m,
});
const O = (o: Partial<ImportParseOptions> = {}): ImportParseOptions => ({
  dateFormat: "YYYY-MM-DD",
  decimalSeparator: ".",
  amountMode: "signed",
  signConvention: "negative_expense",
  ...o,
});

describe("CSV parsing helpers", () => {
  it("parses CSV text with BOM, semicolons and quoted fields", () => {
    const text = '﻿Date;Description;Amount\n2026-10-01;"Coffee; large";-4,50\n2026-10-02;"Say ""hi""\nsecond line";100\n';
    const r = parseCsvText(text);
    expect(r.delimiter).toBe(";");
    expect(r.headers).toEqual(["Date", "Description", "Amount"]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0][1]).toBe("Coffee; large");
    expect(r.rows[1][1]).toBe('Say "hi"\nsecond line');
  });

  it("parses comma CSV and guesses the mapping", () => {
    const r = parseCsvText("Transaction Date,Narration,Debit,Credit,Category\n01/10/2026,Rent,1500,,Housing\n");
    expect(r.delimiter).toBe(",");
    const g = guessMapping(r.headers);
    expect(g.date).toBe(0);
    expect(g.description).toBe(1);
    expect(g.debit).toBe(2);
    expect(g.credit).toBe(3);
    expect(g.category).toBe(4);
  });

  it("parses every supported date format", () => {
    expect(parseDateValue("2026-10-03", "YYYY-MM-DD")).toBe("2026-10-03");
    expect(parseDateValue("2026/10/03 14:22:01", "YYYY-MM-DD")).toBe("2026-10-03");
    expect(parseDateValue("2026-10-03T08:00:00Z", "YYYY-MM-DD")).toBe("2026-10-03");
    expect(parseDateValue("03/10/2026", "DD/MM/YYYY")).toBe("2026-10-03");
    expect(parseDateValue("3.10.26", "DD/MM/YYYY")).toBe("2026-10-03");
    expect(parseDateValue("10/03/2026", "MM/DD/YYYY")).toBe("2026-10-03");
    expect(parseDateValue("03-10-2026", "DD-MM-YYYY")).toBe("2026-10-03");
    expect(parseDateValue("3 Oct 2026", "D MMM YYYY")).toBe("2026-10-03");
    expect(parseDateValue("03-Oct-2026", "D MMM YYYY")).toBe("2026-10-03");
    expect(parseDateValue("3 October 2026", "D MMM YYYY")).toBe("2026-10-03");
    expect(parseDateValue("Oct 3, 2026", "D MMM YYYY")).toBe("2026-10-03");
    // invalid
    expect(parseDateValue("31/02/2026", "DD/MM/YYYY")).toBeNull();
    expect(parseDateValue("13/13/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseDateValue("hello", "YYYY-MM-DD")).toBeNull();
    expect(parseDateValue("", "YYYY-MM-DD")).toBeNull();
  });

  it("auto-detects date formats using evidence", () => {
    expect(detectDateFormat(["2026-10-01", "2026-10-15"]).format).toBe("YYYY-MM-DD");
    expect(detectDateFormat(["01/10/2026", "25/10/2026"])).toMatchObject({ format: "DD/MM/YYYY", ambiguous: false });
    expect(detectDateFormat(["10/01/2026", "10/25/2026"])).toMatchObject({ format: "MM/DD/YYYY", ambiguous: false });
    expect(detectDateFormat(["01/02/2026", "03/04/2026"])).toMatchObject({ ambiguous: true });
    expect(detectDateFormat(["01-10-2026"]).format).toBe("DD-MM-YYYY");
    expect(detectDateFormat(["1 Oct 2026", "12 Nov 2026"]).format).toBe("D MMM YYYY");
    expect(detectDateFormat(["nope"]).format).toBeNull();
  });

  it("parses amounts with thousands separators, symbols and negatives", () => {
    expect(parseAmountValue("1,234.56")).toBe("1234.5600");
    expect(parseAmountValue("1.234,56", ",")).toBe("1234.5600");
    expect(parseAmountValue("1 234,56", ",")).toBe("1234.5600");
    expect(parseAmountValue("1'234.56")).toBe("1234.5600");
    expect(parseAmountValue("-$1,234.56")).toBe("-1234.5600");
    expect(parseAmountValue("(45.00)")).toBe("-45.0000");
    expect(parseAmountValue("45.00-")).toBe("-45.0000");
    expect(parseAmountValue("₹ 12,34,567.00")).toBeNull(); // Indian grouping isn't 3-digit groups
    expect(parseAmountValue("€12,50", ",")).toBe("12.5000");
    expect(parseAmountValue("100 DR")).toBe("-100.0000");
    expect(parseAmountValue("100 CR")).toBe("100.0000");
    expect(parseAmountValue("+7")).toBe("7.0000");
    expect(parseAmountValue("1,23.4")).toBeNull();
    expect(parseAmountValue("abc")).toBeNull();
    expect(parseAmountValue("")).toBeNull();
    expect(parseAmountValue("1.234.567,8", ",")).toBe("1234567.8000");
  });

  it("detects the decimal separator", () => {
    expect(detectDecimalSeparator(["1,234.56", "12.00"])).toBe(".");
    expect(detectDecimalSeparator(["1.234,56", "12,00"])).toBe(",");
    expect(detectDecimalSeparator(["12,5", "3,25"])).toBe(",");
    expect(detectDecimalSeparator(["1.234.567"])).toBe(",");
  });

  it("interprets debit/credit columns and sign conventions", () => {
    const split = O({ amountMode: "split" });
    const map = M({ debit: 1, credit: 2, description: 3 });
    expect(interpretRow(["2026-10-01", "50.00", "", "Groceries"], map, split)).toMatchObject({ amount: "50.0000", type: "expense", merchant: "Groceries", errors: [] });
    expect(interpretRow(["2026-10-01", "", "2,000.00", "Salary"], map, split)).toMatchObject({ amount: "2000.0000", type: "income" });
    expect(interpretRow(["2026-10-01", "", "", "x"], map, split).errors).toContain("Amount is missing");

    const signed = M({ amount: 1, description: 2 });
    expect(interpretRow(["2026-10-01", "-12", "Lunch"], signed, O()).type).toBe("expense");
    expect(interpretRow(["2026-10-01", "12", "Lunch"], signed, O({ signConvention: "positive_expense" })).type).toBe("expense");
    expect(interpretRow(["2026-10-01", "-12", "Refund"], signed, O({ signConvention: "positive_expense" })).type).toBe("income");
  });

  it("reports row validation errors", () => {
    const map = M({ amount: 1, type: 2, category: 3 });
    const r = interpretRow(["32/13/2026", "abc", "transfer", "Food › Groceries"], map, O({ dateFormat: "DD/MM/YYYY" }));
    expect(r.errors.join(" ")).toMatch(/date/i);
    expect(r.errors.join(" ")).toMatch(/amount/i);
    expect(r.errors.join(" ")).toMatch(/Transfers/);
    expect(r.category).toEqual({ parent: "Food", name: "Groceries" });
    expect(interpretRow(["2026-10-01", "0", "", ""], map, O()).errors).toContain("Amount is zero");
    expect(interpretRow(["2026-10-01", "5", "refund", ""], map, O()).type).toBe("refund");
  });
});

describe("CSV import service", () => {
  const mapping = M({ amount: 1, description: 2, category: 3 });

  it("imports rows, matches categories by name, records the batch and source", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "1000" });
    const groceries = await category(u.id, "Groceries");
    const salary = await category(u.id, "Salary");
    const batch = await startImportBatch(u.id, { filename: "bank.csv", rowCount: 4 });
    const r = await importChunk(u.id, {
      batchId: batch.id,
      mapping,
      options: { ...O(), accountId: acc.id },
      rows: [
        { line: 2, cells: ["2026-09-01", "-45.50", "BIG BAZAAR", "food › groceries"] },
        { line: 3, cells: ["2026-09-02", "3000", "ACME PAYROLL", "Salary"] },
        { line: 4, cells: ["2026-09-03", "-10", "Mystery", "Unknown thing"] },
        { line: 5, cells: ["not a date", "-10", "Bad", ""] },
      ],
    });
    expect(r).toMatchObject({ imported: 3, errors: 1, duplicates: 0 });
    expect(r.rows[0]).toMatchObject({ line: 5, status: "error" });
    const rows = await db.select().from(transactions).where(eq(transactions.importBatchId, batch.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((t) => t.source === "import" && t.importHash && t.userId === u.id)).toBe(true);
    expect(rows.find((t) => t.amount === "45.5000")?.categoryId).toBe(groceries.id);
    expect(rows.find((t) => t.type === "income")?.categoryId).toBe(salary.id);
    expect(rows.find((t) => t.amount === "10.0000")?.categoryId).toBeNull();
    expect((await accountBalances(u.id)).get(acc.id)).toBe("3944.5000");
    const [b] = await db.select().from(importBatches).where(eq(importBatches.id, batch.id));
    expect(b).toMatchObject({ importedCount: 3, skippedCount: 1, rowCount: 4 });
  });

  it("can create unknown categories when asked", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const batch = await startImportBatch(u.id, { filename: null, rowCount: 2 });
    await importChunk(u.id, {
      batchId: batch.id,
      mapping,
      options: { ...O(), accountId: acc.id, createCategories: true },
      rows: [
        { line: 1, cells: ["2026-09-01", "-5", "a", "Hobbies › Pottery"] },
        { line: 2, cells: ["2026-09-02", "-6", "b", "Hobbies › Pottery"] },
      ],
    });
    const cats = await listCategories(u.id);
    const hobbies = cats.find((c) => c.name === "Hobbies");
    const pottery = cats.find((c) => c.name === "Pottery");
    expect(hobbies?.parentId).toBeNull();
    expect(pottery?.parentId).toBe(hobbies?.id);
    expect(cats.filter((c) => c.name === "Pottery")).toHaveLength(1);
  });

  it("detects duplicates within the file and against existing transactions (incl. manual ones)", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id);
    const coffee = await category(u.id, "Coffee");
    await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "4.50", date: "2026-09-10", merchant: "Starbucks", categoryId: coffee.id });
    const rows = [
      { line: 1, cells: ["2026-09-10", "-4.50", "  STARBUCKS ", ""] }, // matches the manual entry
      { line: 2, cells: ["2026-09-11", "-9", "Lunch", ""] },
      { line: 3, cells: ["2026-09-11", "-9", "lunch", ""] }, // repeated in file
    ];
    // Preview check flags the manual duplicate.
    const dupLines = await findExistingDuplicates(u.id, { rows: [{ line: 1, accountId: acc.id, date: "2026-09-10", type: "expense", amount: "4.5000", description: "STARBUCKS" }] });
    expect(dupLines).toEqual([1]);

    const b1 = await startImportBatch(u.id, { filename: "a.csv", rowCount: 3 });
    const r1 = await importChunk(u.id, { batchId: b1.id, mapping, options: { ...O(), accountId: acc.id }, rows });
    expect(r1).toMatchObject({ imported: 1, duplicates: 2 });

    // Re-importing the same file: everything is a duplicate.
    const b2 = await startImportBatch(u.id, { filename: "a.csv", rowCount: 3 });
    const r2 = await importChunk(u.id, { batchId: b2.id, mapping, options: { ...O(), accountId: acc.id }, rows });
    expect(r2.imported).toBe(0);
    expect((await finishImportBatch(u.id, b2.id)).removed).toBe(true);

    // Forcing a line imports it anyway.
    const b3 = await startImportBatch(u.id, { filename: "a.csv", rowCount: 1 });
    const r3 = await importChunk(u.id, { batchId: b3.id, mapping, options: { ...O(), accountId: acc.id, forceLines: [3] }, rows: [rows[2]] });
    expect(r3.imported).toBe(1);
  });

  it("matches the account column by name and rejects unknown accounts", async () => {
    const u = await makeUser();
    const a = await makeAccount(u.id, { name: "HDFC Savings" });
    const batch = await startImportBatch(u.id, { filename: null, rowCount: 2 });
    const r = await importChunk(u.id, {
      batchId: batch.id,
      mapping: M({ amount: 1, description: 2, account: 3 }),
      options: { ...O() },
      rows: [
        { line: 1, cells: ["2026-09-01", "-5", "x", "hdfc savings"] },
        { line: 2, cells: ["2026-09-01", "-5", "y", "Nope Bank"] },
      ],
    });
    expect(r.imported).toBe(1);
    expect(r.rows[0].message).toMatch(/No account named/);
    const [t] = await db.select().from(transactions).where(eq(transactions.importBatchId, batch.id));
    expect(t.accountId).toBe(a.id);
  });

  it("requires an exchange rate for foreign-currency accounts (same rule as manual entry)", async () => {
    const u = await makeUser({ currency: "USD" });
    const eur = await makeAccount(u.id, { name: "Euro", currency: "EUR" });
    const batch = await startImportBatch(u.id, { filename: null, rowCount: 1 });
    const r = await importChunk(u.id, { batchId: batch.id, mapping, options: { ...O(), accountId: eur.id }, rows: [{ line: 1, cells: ["2026-09-01", "-5", "x", ""] }] });
    expect(r.errors).toBe(1);
    expect(r.rows[0].message).toMatch(/exchange rate/);
  });

  it("undoes an import batch", async () => {
    const u = await makeUser();
    const acc = await makeAccount(u.id, { openingBalance: "100" });
    await createTransaction(u.id, { type: "expense", accountId: acc.id, amount: "1", date: "2026-09-01" });
    const batch = await startImportBatch(u.id, { filename: "x.csv", rowCount: 2 });
    await importChunk(u.id, {
      batchId: batch.id,
      mapping,
      options: { ...O(), accountId: acc.id },
      rows: [
        { line: 1, cells: ["2026-09-02", "-10", "a", ""] },
        { line: 2, cells: ["2026-09-03", "-20", "b", ""] },
      ],
    });
    expect((await accountBalances(u.id)).get(acc.id)).toBe("69.0000");
    expect(await undoImportBatch(u.id, batch.id)).toEqual({ removed: 2 });
    expect((await accountBalances(u.id)).get(acc.id)).toBe("99.0000");
    expect((await listImportBatches(u.id))[0].undoneAt).not.toBeNull();
    await expect(undoImportBatch(u.id, batch.id)).rejects.toThrow(/already/);
    await expect(importChunk(u.id, { batchId: batch.id, mapping, options: { ...O(), accountId: acc.id }, rows: [{ line: 1, cells: ["2026-09-02", "-10", "a", ""] }] })).rejects.toThrow(/undone/);
  });

  it("enforces the row limit and chunk size", async () => {
    const u = await makeUser();
    await expect(startImportBatch(u.id, { filename: null, rowCount: 10_001 })).rejects.toThrow(/10,000/);
    const acc = await makeAccount(u.id);
    const batch = await startImportBatch(u.id, { filename: null, rowCount: 501 });
    const rows = Array.from({ length: 501 }, (_, i) => ({ line: i, cells: ["2026-09-01", "-1", `r${i}`, ""] }));
    await expect(importChunk(u.id, { batchId: batch.id, mapping, options: { ...O(), accountId: acc.id }, rows })).rejects.toThrow();
  });

  it("isolation: B can't import into A's batch/account/category, or undo A's import", async () => {
    const A = await makeUser();
    const B = await makeUser();
    const accA = await makeAccount(A.id);
    const accB = await makeAccount(B.id);
    const catA = await category(A.id, "Groceries");
    const batchA = await startImportBatch(A.id, { filename: null, rowCount: 1 });
    await importChunk(A.id, { batchId: batchA.id, mapping, options: { ...O(), accountId: accA.id }, rows: [{ line: 1, cells: ["2026-09-01", "-3", "a", ""] }] });
    const batchB = await startImportBatch(B.id, { filename: null, rowCount: 1 });
    const row = [{ line: 1, cells: ["2026-09-01", "-3", "a", ""] }];
    await expect(importChunk(B.id, { batchId: batchA.id, mapping, options: { ...O(), accountId: accB.id }, rows: row })).rejects.toThrow(/not found/);
    await expect(importChunk(B.id, { batchId: batchB.id, mapping, options: { ...O(), accountId: accA.id }, rows: row })).rejects.toThrow(/not found/);
    await expect(importChunk(B.id, { batchId: batchB.id, mapping, options: { ...O(), accountId: accB.id, defaultExpenseCategoryId: catA.id }, rows: row })).rejects.toThrow(/not found/);
    // Account names are matched only against B's own accounts.
    const r = await importChunk(B.id, { batchId: batchB.id, mapping: M({ amount: 1, description: 2, account: 3 }), options: { ...O() }, rows: [{ line: 1, cells: ["2026-09-01", "-3", "a", "Checking"] }] });
    expect(r.imported).toBe(1);
    const bRows = await db.select().from(transactions).where(eq(transactions.importBatchId, batchB.id));
    expect(bRows[0].accountId).toBe(accB.id);
    await expect(undoImportBatch(B.id, batchA.id)).rejects.toThrow(/not found/);
    expect(await db.$count(transactions, and(eq(transactions.importBatchId, batchA.id), eq(transactions.userId, A.id)))).toBe(1);
    expect(await findExistingDuplicates(B.id, { rows: [{ line: 1, accountId: accA.id, date: "2026-09-01", type: "expense", amount: "3", description: "a" }] })).toEqual([]);
    expect((await listImportBatches(B.id)).map((b) => b.id)).not.toContain(batchA.id);
  });

  it("import hashes are user-scoped", () => {
    expect(importHash("u1", "a", "2026-01-01", "expense", "1", "x")).not.toBe(importHash("u2", "a", "2026-01-01", "expense", "1", "x"));
    expect(importHash("u1", "a", "2026-01-01", "expense", "1.00", " X ")).toBe(importHash("u1", "a", "2026-01-01", "expense", "1", "x"));
  });
});
