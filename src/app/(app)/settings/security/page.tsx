import type { Metadata } from "next";
import { requireUserPage } from "@/server/auth/current";
import { listUserSessions } from "@/server/auth/sessions";
import { SecurityForms } from "./security-forms";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const session = await requireUserPage();
  const sessions = await listUserSessions(session.user.id);
  return (
    <SecurityForms
      email={session.user.email}
      isAdmin={session.user.role === "admin"}
      currentSessionId={session.sessionId}
      sessions={sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
      }))}
    />
  );
}
