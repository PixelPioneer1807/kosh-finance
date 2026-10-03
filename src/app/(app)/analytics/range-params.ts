import { resolveRange, RANGE_PRESETS, type DateRange, type RangePreset } from "@/lib/dates";

type SP = Record<string, string | string[] | undefined>;

export const spStr = (sp: SP, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

/** Range from `?range=<preset>` or `?from=&to=` (custom), falling back to `fallback`. */
export function rangeFromParams(
  sp: SP,
  prefs: { today: string; weekStartsOn: 0 | 1; monthStartDay: number },
  fallback: string,
): DateRange & { preset: RangePreset } {
  const from = spStr(sp, "from");
  const to = spStr(sp, "to");
  const raw = spStr(sp, "range");
  const known = raw === "custom" || RANGE_PRESETS.some((p) => p.id === raw);
  const preset = known ? raw : from || to ? "custom" : fallback;
  return resolveRange(preset, prefs.today, { weekStartsOn: prefs.weekStartsOn, monthStartDay: prefs.monthStartDay, from, to });
}

/** Query string that carries the current range to sibling pages. */
export function rangeQuery(r: { preset: string; from: string; to: string }) {
  return r.preset === "custom" ? `range=custom&from=${r.from}&to=${r.to}` : `range=${r.preset}`;
}
