import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { listGoalsWithProgress } from "@/server/services/goals";
import { GoalsView } from "./goals-view";

export const metadata: Metadata = { title: "Goals" };

export default async function GoalsPage() {
  const { user } = await requireUserPage();
  const [prefs, goals] = await Promise.all([getPreferences(user.id), listGoalsWithProgress(user.id)]);
  return <GoalsView goals={goals} baseCurrency={prefs.currency} />;
}
