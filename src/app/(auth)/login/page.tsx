import Link from "next/link";
import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1.5 mb-7 text-sm text-muted-foreground">Sign in to your private finance workspace.</p>
      {sp.deleted === "1" && (
        <p role="status" className="mb-5 rounded-md bg-positive-soft px-3 py-2 text-sm text-positive">
          Your account and all of its data have been permanently deleted.
        </p>
      )}
      <LoginForm next={next} />
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Have an invite code?{" "}
        <Link href="/register" className="font-medium text-foreground underline-offset-4 hover:underline">
          Create your account
        </Link>
      </p>
    </div>
  );
}
