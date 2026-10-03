import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/app/logo";
import { APP_TAGLINE } from "@/lib/config";
import { getSession } from "@/server/auth/current";

export default async function AuthLayout({ children }: LayoutProps<"/">) {
  const s = await getSession();
  if (s) redirect(s.user.onboardingCompletedAt ? "/dashboard" : "/onboarding");
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="px-6 pt-6 sm:px-10">
        <Link href="/login" aria-label="Home">
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16 sm:items-center sm:pt-0">
        <div className="w-full max-w-[400px]">{children}</div>
      </main>
      <footer className="px-6 pb-6 text-center text-xs text-muted-foreground sm:px-10">{APP_TAGLINE} Private by default — invite only.</footer>
    </div>
  );
}
