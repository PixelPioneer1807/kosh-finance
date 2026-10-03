import { isZero, ratio, sub } from "@/lib/money";

/** Change and relative change between two decimal strings (pct null when previous is zero). */
export function delta(current: string, previous: string) {
  const change = sub(current, previous);
  return { change, pct: isZero(previous) ? null : ratio(change, previous.replace(/^-/, "")) };
}
