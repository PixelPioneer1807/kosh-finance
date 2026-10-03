import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { DASHBOARD_WIDGETS, getPreferences } from "@/server/services/preferences";
import { AppearanceForm } from "./appearance-form";

export const metadata: Metadata = { title: "Appearance" };

export default async function AppearancePage() {
  const { user } = await requireUserPage();
  const prefs = await getPreferences(user.id);
  return (
    <AppearanceForm
      theme={(["light", "dark", "system"].includes(prefs.theme) ? prefs.theme : "system") as "light" | "dark" | "system"}
      widgets={prefs.dashboardWidgets}
      catalog={DASHBOARD_WIDGETS}
      defaultDateRange={prefs.defaultDateRange}
    />
  );
}
