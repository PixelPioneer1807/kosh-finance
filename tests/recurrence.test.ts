import { describe, expect, it } from "vitest";
import { nextAfter, nextOnOrAfter, occurrencesBetween, perMonthFactor } from "@/lib/recurrence";
import { monthRange, resolveRange } from "@/lib/dates";

describe("recurrence", () => {
  it("monthly on the 31st clamps without drifting", () => {
    const rule = { frequency: "monthly" as const, startDate: "2026-01-31" };
    expect(occurrencesBetween(rule, "2026-01-01", "2026-05-31")).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });
  it("weekly, biweekly, quarterly, yearly", () => {
    expect(nextAfter({ frequency: "weekly", startDate: "2026-10-01" }, "2026-10-01")).toBe("2026-10-08");
    expect(nextAfter({ frequency: "biweekly", startDate: "2026-10-01" }, "2026-10-01")).toBe("2026-10-15");
    expect(nextAfter({ frequency: "quarterly", startDate: "2026-01-15" }, "2026-02-01")).toBe("2026-04-15");
    expect(nextAfter({ frequency: "yearly", startDate: "2024-02-29" }, "2024-03-01")).toBe("2025-02-28");
  });
  it("custom intervals and end dates", () => {
    const rule = { frequency: "custom" as const, interval: 10, intervalUnit: "day" as const, startDate: "2026-01-01", endDate: "2026-01-25" };
    expect(occurrencesBetween(rule, "2026-01-01", "2026-12-31")).toEqual(["2026-01-01", "2026-01-11", "2026-01-21"]);
    expect(nextOnOrAfter(rule, "2026-01-22")).toBeNull();
  });
  it("is efficient far from the start date", () => {
    expect(nextOnOrAfter({ frequency: "daily", startDate: "2000-01-01" }, "2026-10-03")).toBe("2026-10-03");
  });
  it("normalises to monthly factors", () => {
    expect(perMonthFactor({ frequency: "yearly" })).toEqual({ num: 1, den: 12 });
    expect(perMonthFactor({ frequency: "quarterly" })).toEqual({ num: 1, den: 3 });
  });
  it("supports payday-based months", () => {
    expect(monthRange("2026-10-03", 25)).toEqual({ from: "2026-09-25", to: "2026-10-24" });
    expect(monthRange("2026-10-26", 25)).toEqual({ from: "2026-10-25", to: "2026-11-24" });
    expect(resolveRange("last_month", "2026-10-03")).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });
});
