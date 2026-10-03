import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { listMerchantsWithUsage, listTagsWithUsage } from "@/server/services/settings";
import { MerchantsManager } from "./merchants-manager";

export const metadata: Metadata = { title: "Merchants & tags" };

export default async function MerchantsSettingsPage() {
  const { user } = await requireUserPage();
  const [merchants, tags] = await Promise.all([listMerchantsWithUsage(user.id), listTagsWithUsage(user.id)]);
  return <MerchantsManager merchants={merchants} tags={tags} />;
}
