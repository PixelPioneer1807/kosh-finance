/** Goal metadata shared by the goals service (server) and the goals UI (client). */
import { fromUnits, toUnits } from "./money";

export const GOAL_KINDS = [
  { id: "emergency_fund", label: "Emergency fund", icon: "shield", color: "#0f766e" },
  { id: "vacation", label: "Vacation", icon: "plane", color: "#0ea5e9" },
  { id: "electronics", label: "Electronics", icon: "laptop", color: "#6366f1" },
  { id: "vehicle", label: "Vehicle", icon: "car", color: "#f97316" },
  { id: "education", label: "Education", icon: "graduation-cap", color: "#8b5cf6" },
  { id: "investment", label: "Investment", icon: "trending-up", color: "#10b981" },
  { id: "home", label: "Home", icon: "house", color: "#f59e0b" },
  { id: "wedding", label: "Wedding", icon: "heart", color: "#ec4899" },
  { id: "custom", label: "Something else", icon: "piggy-bank", color: "#64748b" },
] as const;

export type GoalKind = (typeof GOAL_KINDS)[number]["id"];
export const GOAL_KIND_IDS = GOAL_KINDS.map((k) => k.id) as [GoalKind, ...GoalKind[]];

export function goalKindMeta(kind: string) {
  return GOAL_KINDS.find((k) => k.id === kind) ?? GOAL_KINDS[GOAL_KINDS.length - 1];
}

export const GOAL_FREQUENCIES = ["weekly", "biweekly", "monthly", "quarterly", "yearly"] as const;
export type GoalFrequency = (typeof GOAL_FREQUENCIES)[number];

export const GOAL_FREQUENCY_LABELS: Record<GoalFrequency, { label: string; per: string; noun: string }> = {
  weekly: { label: "Weekly", per: "week", noun: "week" },
  biweekly: { label: "Every 2 weeks", per: "2 weeks", noun: "fortnight" },
  monthly: { label: "Monthly", per: "month", noun: "month" },
  quarterly: { label: "Quarterly", per: "quarter", noun: "quarter" },
  yearly: { label: "Yearly", per: "year", noun: "year" },
};

/** Average length of each contribution period in days (used to express pace per period). */
export const GOAL_PERIOD_DAYS: Record<GoalFrequency, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30.4375,
  quarterly: 91.3125,
  yearly: 365.25,
};

/** Icons offered in the goal editor (all exist in components/app/icons.tsx). */
export const GOAL_ICONS = [
  "piggy-bank", "shield", "plane", "laptop", "smartphone", "car", "bike", "graduation-cap", "trending-up", "house", "heart",
  "gift", "baby", "dog", "heart-pulse", "briefcase", "gem", "hotel", "music", "gamepad", "sofa", "wrench", "leaf", "landmark",
] as const;

export type GoalTrack = "completed" | "on_track" | "behind" | "overdue" | "no_deadline" | "no_pace";

export const GOAL_TRACK_LABELS: Record<GoalTrack, string> = {
  completed: "Reached",
  on_track: "On track",
  behind: "Behind",
  overdue: "Past deadline",
  no_deadline: "No deadline",
  no_pace: "No recent saving",
};

/** Ceil `amount / parts` to whole cents, so following the plan actually reaches the target. */
export function ceilDivCents(amount: string, parts: number): string {
  const units = toUnits(amount);
  const cent = BigInt(100); // 0.01 in 4-dp units
  const p = BigInt(Math.max(1, Math.trunc(parts)));
  let per = units / p;
  if (per * p < units) per += BigInt(1);
  const rem = per % cent;
  if (rem > BigInt(0)) per += cent - rem;
  return fromUnits(per);
}
