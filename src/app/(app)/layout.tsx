import { Suspense } from "react";
import { after } from "next/server";
import { requireUserPage } from "@/server/auth/current";
import { maybeRunRemindersForUser } from "@/server/services/reminders";
import { ServiceWorkerRegister } from "@/components/app/sw-register";
import { InstallPrompt } from "@/components/app/install-prompt";
import { OfflineBanner } from "@/components/app/offline-banner";
import { UrlActions } from "@/components/shell/url-actions";
import { getPreferences } from "@/server/services/preferences";
import { listAccounts } from "@/server/services/accounts";
import { listCategories, listPaymentMethods } from "@/server/services/taxonomy";
import { AppDataProvider } from "@/components/app/user-context";
import { ShellProvider } from "@/components/shell/shell-context";
import { Sidebar } from "@/components/shell/sidebar";
import { Topbar } from "@/components/shell/topbar";
import { MobileNav } from "@/components/shell/mobile-nav";
import { QuickAdd } from "@/components/shell/quick-add";
import { CommandPalette } from "@/components/shell/command-palette";
import { ThemeSync } from "@/components/shell/theme-sync";

/** Authenticated shell. Loads the reference data every page and the quick-add form need. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const session = await requireUserPage();
  const userId = session.user.id;
  // Reminders & auto-posting also run lazily (throttled) so they work even without a cron job.
  after(() => maybeRunRemindersForUser(userId));
  const [prefs, accounts, categories, paymentMethods] = await Promise.all([
    getPreferences(userId),
    listAccounts(userId, { includeArchived: true }),
    listCategories(userId),
    listPaymentMethods(userId),
  ]);
  const data = {
    user: { id: userId, email: session.user.email, name: session.user.name, role: session.user.role },
    prefs: {
      currency: prefs.currency,
      locale: prefs.locale,
      timezone: prefs.timezone,
      today: prefs.today,
      weekStartsOn: prefs.weekStartsOn,
      monthStartDay: prefs.monthStartDay,
      aiEnabled: prefs.aiEnabled && Boolean(process.env.GROQ_API_KEY),
      defaultAccountId: prefs.defaultAccountId,
      defaultPaymentMethodId: prefs.defaultPaymentMethodId,
    },
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, currency: a.currency, balance: a.balance, isArchived: a.isArchived, color: a.color })),
    categories: categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId, icon: c.icon, color: c.color, isArchived: c.isArchived })),
    paymentMethods: paymentMethods.map((p) => ({ id: p.id, name: p.name, type: p.type, defaultAccountId: p.defaultAccountId })),
    vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? null,
  };
  return (
    <AppDataProvider value={data}>
      <ShellProvider>
        <ThemeSync theme={prefs.theme} />
        <ServiceWorkerRegister />
        <OfflineBanner />
        <Suspense>
          <UrlActions />
        </Suspense>
        <div className="flex min-h-dvh">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar />
            <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pt-4 pb-28 sm:px-6 lg:px-8 lg:pt-2 lg:pb-12">
              {children}
            </main>
          </div>
        </div>
        <MobileNav />
        <QuickAdd />
        <CommandPalette />
        <InstallPrompt />
      </ShellProvider>
    </AppDataProvider>
  );
}
