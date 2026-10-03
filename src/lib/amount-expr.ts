import { add, normalize, sub, toUnits } from "./money";

/**
 * Evaluates simple amount arithmetic typed into an amount field ("120+45.5-10"), exactly.
 * Only digits, dots, commas, + and - are accepted. Returns null when invalid.
 */
export function evalAmount(input: string): string | null {
  const s = input.replace(/[\s,]/g, "");
  if (!s) return null;
  if (!/^[+-]?\d*\.?\d+([+-]\d*\.?\d+)*$/.test(s)) return null;
  const parts = s.match(/[+-]?[^+-]+/g) ?? [];
  let total = "0";
  for (const p of parts) total = p.startsWith("-") ? sub(total, p.slice(1)) : add(total, p.replace("+", ""));
  return toUnits(total) === BigInt(0) && !/[1-9]/.test(s) ? normalize("0") : total;
}
