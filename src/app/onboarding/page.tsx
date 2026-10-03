import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { listCategories } from "@/server/services/taxonomy";
import { Providers } from "./providers";
import { OnboardingWizard } from "./wizard";

export const metadata: Metadata = { title: "Welcome" };

export default async function OnboardingPage() {
  const s = await requireUserPage({ allowOnboarding: true });
  if (s.user.onboardingCompletedAt) redirect("/dashboard");
  const [prefs, cats] = await Promise.all([getPreferences(s.user.id), listCategories(s.user.id)]);
  return (
    <Providers>
      <OnboardingWizard
        name={s.user.name ?? ""}
        currency={prefs.currency}
        timezone={prefs.timezone}
        expenseCategories={cats.filter((c) => c.kind === "expense" && !c.parentId).map((c) => ({ id: c.id, name: c.name, icon: c.icon, color: c.color }))}
      />
    </Providers>
  );
}
