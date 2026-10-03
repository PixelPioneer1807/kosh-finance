import { afterEach, describe, expect, it, vi } from "vitest";
import { amountAppearsIn, extractReceiptLocally, findReceiptDate, parseReceiptAmount, paymentHint } from "@/lib/receipt-parse";
import { getReceiptFile, saveReceipt, sniffMime } from "@/server/services/receipts";
import { extractReceipt } from "@/server/ai/receipt";
import { updatePreferences } from "@/server/services/preferences";
import { makeUser } from "./helpers";

const US_RECEIPT = `TRADER JOE'S
2001 Market St
San Francisco CA
10/01/2026 18:42
BANANAS            1.99
ORGANIC MILK       4.49
SOURDOUGH BREAD    5.99
SUBTOTAL          12.47
SALES TAX 8.625%   0.00
TOTAL             12.47
VISA ************4421
THANK YOU FOR SHOPPING`;

const INDIA_RECEIPT = `TAX INVOICE
Cafe Coffee Day
GSTIN: 29AABCC1234D1ZX
Date: 28-Sep-2026  Time: 14:05
Cappuccino            180.00
Veg Sandwich          220.00
Sub Total             400.00
CGST 2.5%              10.00
SGST 2.5%              10.00
Grand Total ₹         420.00
Paid via UPI`;

const EU_RECEIPT = `Boulangerie Paul
03.09.2026
Croissant 1,80
Café 2,50
TOTAL EUR 4,30
Espèces / Cash`;

describe("receipt regex fallback", () => {
  it("parses amounts in common formats", () => {
    expect(parseReceiptAmount("1,234.56")).toBe("1234.5600");
    expect(parseReceiptAmount("1.234,56")).toBe("1234.5600");
    expect(parseReceiptAmount("12,50")).toBe("12.5000");
    expect(parseReceiptAmount("1,234")).toBe("1234.0000");
    expect(parseReceiptAmount("₹ 420.00")).toBe("420.0000");
    expect(parseReceiptAmount("0.00")).toBeNull();
    expect(parseReceiptAmount("abc")).toBeNull();
  });

  it("extracts a US grocery receipt", () => {
    const r = extractReceiptLocally(US_RECEIPT, { today: "2026-10-03", dayFirst: false });
    // No currency symbol on the receipt → currency stays unknown rather than guessed.
    expect(r).toMatchObject({ merchant: "Trader Joe's", date: "2026-10-01", total: "12.4700", currency: null, paymentMethod: "card" });
    expect(r.items.map((i) => i.name)).toEqual(["BANANAS", "ORGANIC MILK", "SOURDOUGH BREAD"]);
  });

  it("extracts an Indian GST receipt (CGST + SGST summed, grand total preferred over subtotal)", () => {
    const r = extractReceiptLocally(INDIA_RECEIPT, { today: "2026-10-03" });
    expect(r).toMatchObject({ merchant: "Cafe Coffee Day", date: "2026-09-28", total: "420.0000", tax: "20.0000", currency: "INR", paymentMethod: "upi" });
    expect(r.items).toEqual([
      { name: "Cappuccino", amount: "180.0000" },
      { name: "Veg Sandwich", amount: "220.0000" },
    ]);
  });

  it("extracts a European receipt with comma decimals", () => {
    const r = extractReceiptLocally(EU_RECEIPT, { today: "2026-10-03" });
    expect(r).toMatchObject({ merchant: "Boulangerie Paul", date: "2026-09-03", total: "4.3000", currency: "EUR", paymentMethod: "cash" });
  });

  it("dates: ambiguity follows the locale; future and impossible dates are rejected", () => {
    expect(findReceiptDate("03/04/2026", { dayFirst: true })).toBe("2026-04-03");
    expect(findReceiptDate("03/04/2026", { dayFirst: false })).toBe("2026-03-04");
    expect(findReceiptDate("25/09/26")).toBe("2026-09-25");
    expect(findReceiptDate("Oct 2, 2026")).toBe("2026-10-02");
    expect(findReceiptDate("2026-12-25", { today: "2026-10-03" })).toBeNull();
    expect(findReceiptDate("31/02/2026")).toBeNull();
  });

  it("returns nulls rather than guessing", () => {
    const r = extractReceiptLocally("smudged\n???", { today: "2026-10-03" });
    expect(r).toMatchObject({ total: null, date: null, tax: null, items: [] });
    expect(paymentHint("nothing here")).toBeNull();
  });

  it("amountAppearsIn guards against invented totals", () => {
    expect(amountAppearsIn("420.0000", INDIA_RECEIPT)).toBe(true);
    expect(amountAppearsIn("12.4700", US_RECEIPT)).toBe(true);
    expect(amountAppearsIn("99.9900", US_RECEIPT)).toBe(false);
  });
});

/* ───────────── Upload safety & isolation ───────────── */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

describe("receipt storage", () => {
  it("sniffs the real file type and rejects anything that isn't an image or PDF", async () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(Buffer.from("%PDF-1.7 rest of file"))).toBe("application/pdf");
    expect(sniffMime(Buffer.from("<html><script>alert(1)</script></html>"))).toBeNull();
    expect(sniffMime(Buffer.from("MZ\x90\x00 fake exe ......"))).toBeNull();
    const u = await makeUser();
    await expect(saveReceipt(u.id, { name: "evil.png", bytes: Buffer.from("<svg onload=alert(1)>  padding") })).rejects.toThrow(/Only JPEG, PNG, WebP/);
    await expect(saveReceipt(u.id, { name: "empty.jpg", bytes: Buffer.alloc(0) })).rejects.toThrow(/empty/);
    const ok = await saveReceipt(u.id, { name: "../../etc/receipt?.png", bytes: PNG });
    expect(ok).toMatchObject({ mimeType: "image/png", filename: "receipt_.png" });
  });

  it("user B can't fetch or extract user A's receipt", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const saved = await saveReceipt(a.id, { name: "r.png", bytes: PNG });
    expect((await getReceiptFile(a.id, saved.id)).userId).toBe(a.id);
    await expect(getReceiptFile(b.id, saved.id)).rejects.toThrow(/not found/i);
    await expect(extractReceipt(b.id, saved.id, US_RECEIPT)).rejects.toThrow(/not found/i);
    expect((await getReceiptFile(a.id, saved.id)).extracted).toBeNull();
  });
});

describe("extractReceipt", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the regex fallback when AI is off, and stores the result", async () => {
    const u = await makeUser();
    await updatePreferences(u.id, { aiEnabled: false });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const saved = await saveReceipt(u.id, { name: "r.png", bytes: PNG });
    const r = await extractReceipt(u.id, saved.id, INDIA_RECEIPT);
    expect(r).toMatchObject({ parser: "local", total: "420.0000", merchant: "Cafe Coffee Day" });
    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await getReceiptFile(u.id, saved.id);
    expect(row.ocrText).toContain("Grand Total");
    expect(row.extracted).toMatchObject({ total: "420.0000", parser: "local" });
  });

  it("with AI: keeps AI fields but rejects a total that isn't in the text", async () => {
    const u = await makeUser();
    const saved = await saveReceipt(u.id, { name: "r.png", bytes: PNG });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [{ message: { role: "assistant", content: JSON.stringify({ merchant: "Trader Joe's SF", date: "2026-10-01", total: "99.99", tax: null, currency: "USD", paymentMethod: "card", items: [{ name: "Bananas", amount: "1.99" }, { name: "Caviar", amount: "250.00" }] }) } }],
          usage: {},
        }),
      ),
    );
    const r = await extractReceipt(u.id, saved.id, US_RECEIPT);
    expect(r).toMatchObject({ parser: "ai", merchant: "Trader Joe's SF", total: "12.4700", currency: "USD", paymentMethod: "card" });
    expect(r.items).toEqual([{ name: "Bananas", amount: "1.9900" }]);
  });

  it("falls back to regex when the AI call fails", async () => {
    const u = await makeUser();
    const saved = await saveReceipt(u.id, { name: "r.png", bytes: PNG });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const r = await extractReceipt(u.id, saved.id, EU_RECEIPT);
    expect(r).toMatchObject({ parser: "local", total: "4.3000" });
  });
});

describe("PDF text extraction (content streams)", () => {
  it("reads Tj/TJ strings with line breaks and escapes", async () => {
    const { textFromContentStream } = await import("@/lib/pdf-text");
    const content = "BT /F1 12 Tf 72 700 Td (ACME STORE) Tj 0 -14 Td [(TOTAL)-300(\\(USD\\))] TJ 0 -14 Td (12.50) Tj ET";
    expect(textFromContentStream(content).split("\n").map((l) => l.trim()).filter(Boolean)).toEqual(["ACME STORE", "TOTAL (USD)", "12.50"]);
  });
});
