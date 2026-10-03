import { redirect } from "next/navigation";
import { getSession } from "@/server/auth/current";

export default async function Home() {
  const s = await getSession();
  redirect(s ? (s.user.onboardingCompletedAt ? "/dashboard" : "/onboarding") : "/login");
}
