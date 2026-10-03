import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { merchantDetail, merchantStats, type AnalyticsCtx, type MerchantSort } from "@/server/services/analytics";
import { isAppError } from "@/server/errors";
import { MerchantsView } from "./merchants-view";
import { rangeFromParams, rangeQuery, spStr } from "../range-params";

export const metadata: Metadata = { title: "Merchants" };

const PAGE = 50;
const uuidRe = /^[0-9a-f-]{36}$/i;

export default async function MerchantsPage({ searchParams }: PageProps<"/analytics/merchants">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const ctx: AnalyticsCtx = { today: prefs.today, monthStartDay: prefs.monthStartDay, weekStartsOn: prefs.weekStartsOn, currency: prefs.currency, locale: prefs.locale };
  const range = rangeFromParams(sp, prefs, "last_90");
  const q = spStr(sp, "q")?.slice(0, 80) ?? "";
  const sort = (["total", "count", "recent", "change"] as const).find((s) => s === spStr(sp, "sort")) ?? "total";
  const offset = Math.max(0, Math.min(Number(spStr(sp, "offset")) || 0, 100_000));
  const merchantId = spStr(sp, "merchant");

  const [stats, detail] = await Promise.all([
    merchantStats(user.id, range, { q, sort: sort as MerchantSort, limit: PAGE, offset, ctx }),
    merchantId && uuidRe.test(merchantId)
      ? merchantDetail(user.id, merchantId, { months: 12, ctx }).catch((e) => {
          if (isAppError(e) && e.code === "NOT_FOUND") return null;
          throw e;
        })
      : Promise.resolve(null),
  ]);

  return (
    <MerchantsView
      range={{ preset: range.preset, from: stats.range.from, to: stats.range.to }}
      query={rangeQuery(range)}
      q={q}
      sort={sort}
      offset={offset}
      pageSize={PAGE}
      stats={stats}
      detail={detail}
      detailMissing={Boolean(merchantId) && !detail}
    />
  );
}
