import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { getAiUsage } from "@/server/services/settings";
import { AiForm } from "./ai-form";

export const metadata: Metadata = { title: "AI" };

export default async function AiSettingsPage() {
  const { user } = await requireUserPage();
  const [prefs, usage] = await Promise.all([getPreferences(user.id), getAiUsage(user.id)]);
  return (
    <AiForm
      configured={Boolean(process.env.GROQ_API_KEY)}
      aiEnabled={prefs.aiEnabled}
      aiInsightsEnabled={prefs.aiInsightsEnabled}
      usage={{ today: usage.today, dailyLimit: usage.dailyLimit, recent: usage.recent.map((r) => ({ day: r.day, requests: r.requests })) }}
    />
  );
}
