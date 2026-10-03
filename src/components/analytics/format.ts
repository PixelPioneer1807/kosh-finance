import { formatDate } from "@/lib/dates";

export type BucketKind = "day" | "week" | "month";

/** Short axis label for a bucket. */
export function bucketLabel(p: { key: string; from: string }, bucket: BucketKind, monthStartDay = 1) {
  if (bucket === "month") return monthStartDay > 1 ? formatDate(p.key, "d MMM") : formatDate(p.key, "MMM yy");
  return formatDate(p.from, "d MMM");
}

/** Full label for tooltips and tables. */
export function bucketTitle(p: { key: string; from: string; to: string }, bucket: BucketKind, monthStartDay = 1) {
  if (bucket === "day") return formatDate(p.from, "EEE, d MMM yyyy");
  if (bucket === "month" && monthStartDay <= 1 && p.from.endsWith("-01")) return formatDate(p.from, "MMMM yyyy");
  return `${formatDate(p.from, "d MMM")} – ${formatDate(p.to, "d MMM yyyy")}`;
}

export const KIND_LABELS: Record<string, string> = {
  expense: "Recurring expense",
  bill: "Bill",
  subscription: "Subscription",
  income: "Income",
  transfer: "Transfer",
  card_due: "Card payment",
  loan_due: "Loan payment",
  goal_deadline: "Goal deadline",
  goal_contribution: "Goal contribution",
};
