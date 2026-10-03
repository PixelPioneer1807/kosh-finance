import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { SettingsNav } from "./settings-nav";

export const metadata: Metadata = { title: { template: "%s · Settings", default: "Settings" } };

export default async function SettingsLayout({ children }: LayoutProps<"/settings">) {
  await requireUserPage();
  return (
    <div>
      <div className="mb-5">
        <h1 className="text-[22px] font-semibold tracking-tight sm:text-2xl">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Make Kosh work the way you do.</p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
        <aside className="lg:sticky lg:top-16 lg:self-start">
          <SettingsNav />
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
