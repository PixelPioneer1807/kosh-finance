import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { getNotificationPreferences } from "@/server/services/preferences";
import { NotificationsForm } from "./notifications-form";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsSettingsPage() {
  const { user } = await requireUserPage();
  const n = await getNotificationPreferences(user.id);
  return (
    <NotificationsForm
      initial={{
        dailyReminderEnabled: n.dailyReminderEnabled,
        dailyReminderTime: n.dailyReminderTime,
        missingEntriesDays: n.missingEntriesDays,
        budgetAlerts: n.budgetAlerts,
        billReminders: n.billReminders,
        subscriptionReminders: n.subscriptionReminders,
        creditCardReminders: n.creditCardReminders,
        incomeReminders: n.incomeReminders,
        goalReminders: n.goalReminders,
        maxPerDay: n.maxPerDay,
        quietHoursEnabled: Boolean(n.quietHoursStart && n.quietHoursEnd),
        quietHoursStart: n.quietHoursStart ?? "22:00",
        quietHoursEnd: n.quietHoursEnd ?? "08:00",
      }}
      pushEnabled={n.pushEnabled}
    />
  );
}
