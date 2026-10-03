import { describe, expect, it } from "vitest";
import { add, allocateEvenly, cmp, divInt, formatMoney, mul, normalize, ratio, sub, toUnits } from "@/lib/money";
import { positiveMoney } from "@/lib/validation";

describe("money", () => {
  it("adds decimals exactly (no float drift)", () => {
    expect(add("0.1", "0.2")).toBe("0.3000");
    expect(add(...Array(10).fill("0.10"))).toBe("1.0000");
    expect(sub("100", "33.33")).toBe("66.6700");
  });
  it("normalises and rounds half away from zero at 4dp", () => {
    expect(normalize("1,234.5")).toBe("1234.5000");
    expect(normalize("1.00005")).toBe("1.0001");
    expect(normalize("-1.00005")).toBe("-1.0001");
    expect(normalize(".5")).toBe("0.5000");
  });
  it("multiplies by fx rates exactly", () => {
    expect(mul("20", "83.1234567")).toBe("1662.4691");
    expect(mul("-10", "0.5")).toBe("-5.0000");
  });
  it("divides and compares", () => {
    expect(divInt("100", 3)).toBe("33.3333");
    expect(cmp("10", "9.9999")).toBe(1);
    expect(ratio("25", "100")).toBe(0.25);
    expect(ratio("1", "0")).toBe(0);
  });
  it("allocates evenly with no lost cents", () => {
    const parts = allocateEvenly("100", 3);
    expect(parts).toEqual(["33.3400", "33.3300", "33.3300"]);
    expect(add(...parts)).toBe("100.0000");
  });
  it("handles large values beyond float precision", () => {
    expect(add("90071992547409.91", "0.01")).toBe("90071992547409.9200");
    expect(toUnits("1").toString()).toBe("10000");
  });
  it("formats with currency", () => {
    expect(formatMoney("1234.5", "USD")).toBe("$1,234.50");
    expect(formatMoney("1234.5", "JPY")).toBe("¥1,235");
    expect(formatMoney("100000", "INR", { locale: "en-IN" })).toBe("₹1,00,000.00");
  });
  it("validates amounts", () => {
    expect(positiveMoney.safeParse("0").success).toBe(false);
    expect(positiveMoney.safeParse("-5").success).toBe(false);
    expect(positiveMoney.safeParse("abc").success).toBe(false);
    expect(positiveMoney.safeParse("12.50").data).toBe("12.5000");
  });
});
