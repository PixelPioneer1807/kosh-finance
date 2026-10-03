import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { MONTH_RE, monthlyReview, reviewableMonths } from "@/server/services/review";
import { addDaysISO, daysBetween, monthRange } from "@/lib/dates";
import { ReviewView } from "./review-view";

export const metadata: Metadata = { title: "Monthly review" };

export default async function ReviewPage({ searchParams }: PageProps<"/review">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const current = monthRange(prefs.today, prefs.monthStartDay);
  // Early in a month, the month that just ended is the one worth reviewing.
  const fallback = daysBetween(current.from, prefs.today) < 7 ? monthRange(addDaysISO(current.from, -1), prefs.monthStartDay).from.slice(0, 7) : current.from.slice(0, 7);
  const month = typeof sp.month === "string" && MONTH_RE.test(sp.month) && sp.month <= current.from.slice(0, 7) ? sp.month : fallback;
  const [review, months] = await Promise.all([monthlyReview(user.id, month), reviewableMonths(user.id)]);
  const options = months.includes(month) ? months : [month, ...months].sort().reverse();
  return <ReviewView review={review} months={options} />;
}
