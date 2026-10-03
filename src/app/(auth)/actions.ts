"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { email as emailSchema } from "@/lib/validation";
import { checkInvite, login, registerWithInvite, requestPasswordReset, resetPassword } from "@/server/services/auth";
import { clearSessionCookie, getRequestMeta, getSessionToken, setSessionCookie } from "@/server/auth/current";
import { createSession, invalidateSessionByToken } from "@/server/auth/sessions";
import { enforceRateLimit } from "@/server/auth/rate-limit";
import { toFailure, type ActionResult } from "@/server/safe";
import { safeNext } from "@/lib/safe-redirect";

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password").max(200) });


export async function loginAction(input: { email: string; password: string; next?: string }): Promise<ActionResult> {
  let dest = "/dashboard";
  try {
    const data = loginSchema.parse(input);
    const meta = await getRequestMeta();
    const { token, expiresAt, user } = await login(data, meta);
    await setSessionCookie(token, expiresAt);
    dest = user.onboardingCompletedAt ? safeNext(input.next) : "/onboarding";
  } catch (e) {
    return toFailure(e);
  }
  redirect(dest);
}

const registerSchema = z.object({
  inviteCode: z.string().trim().min(4, "Enter your invite code").max(40),
  email: emailSchema,
  name: z.string().trim().max(80).optional(),
  password: z.string().min(1, "Choose a password").max(128),
});

export async function registerAction(input: z.input<typeof registerSchema>): Promise<ActionResult> {
  try {
    const data = registerSchema.parse(input);
    const meta = await getRequestMeta();
    const user = await registerWithInvite(data, meta);
    const { token, expiresAt } = await createSession(user.id, meta);
    await setSessionCookie(token, expiresAt);
  } catch (e) {
    return toFailure(e);
  }
  redirect("/onboarding");
}

export async function checkInviteAction(code: string): Promise<ActionResult<{ state: string }>> {
  try {
    const meta = await getRequestMeta();
    await enforceRateLimit(`invite-check:${meta.ip}`, 20, 600);
    const clean = z.string().trim().min(4).max(40).parse(code);
    return { ok: true, data: { state: await checkInvite(clean) } };
  } catch (e) {
    return toFailure(e);
  }
}

export async function forgotPasswordAction(input: { email: string }): Promise<ActionResult> {
  try {
    const email = emailSchema.parse(input.email);
    await requestPasswordReset(email, await getRequestMeta());
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

export async function resetPasswordAction(input: { token: string; password: string }): Promise<ActionResult> {
  try {
    const data = z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(128) }).parse(input);
    await resetPassword(data.token, data.password, await getRequestMeta());
    return { ok: true, data: null };
  } catch (e) {
    return toFailure(e);
  }
}

export async function logoutAction() {
  const token = await getSessionToken();
  if (token) await invalidateSessionByToken(token);
  await clearSessionCookie();
  redirect("/login");
}
