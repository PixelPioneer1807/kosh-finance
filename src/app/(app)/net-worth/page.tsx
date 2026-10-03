import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { netWorthHistory, netWorthSummary } from "@/server/services/networth";
import { creditCardHealth } from "@/server/services/credit";
import { NetWorthView } from "./net-worth-view";

export const metadata: Metadata = { title: "Net worth" };

export default async function NetWorthPage() {
  const { user } = await requireUserPage();
  const [summary, history, credit] = await Promise.all([netWorthSummary(user.id), netWorthHistory(user.id, 12), creditCardHealth(user.id)]);
  return <NetWorthView summary={summary} history={history} credit={credit} />;
}
