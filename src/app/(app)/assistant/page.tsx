import type { Metadata } from "next";
import Link from "next/link";
import { Settings, Sparkles } from "lucide-react";
import { requireUserPage } from "@/server/auth/current";
import { getPreferences } from "@/server/services/preferences";
import { aiConfigured } from "@/server/ai/groq";
import { aiUsageToday, getConversation, listConversations } from "@/server/ai/assistant";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/misc";
import { AssistantClient } from "./assistant-client";

export const metadata: Metadata = { title: "Assistant" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AssistantPage({ searchParams }: PageProps<"/assistant">) {
  const { user } = await requireUserPage();
  const sp = await searchParams;
  const prefs = await getPreferences(user.id);
  const header = <PageHeader title="Assistant" description="Ask questions about your money. Answers come from your own data." className="mb-4" />;

  if (!aiConfigured())
    return (
      <>
        {header}
        <Card>
          <EmptyState
            icon={<Sparkles />}
            title="The assistant isn't available on this server"
            description="AI features need an API key configured by the administrator. Everything else in Kosh works without it."
          />
        </Card>
      </>
    );

  if (!prefs.aiEnabled)
    return (
      <>
        {header}
        <Card>
          <EmptyState
            icon={<Sparkles />}
            title="The AI assistant is turned off"
            description="Turn on AI features to ask questions about your spending, bills and goals. Only the data needed for each answer is sent, and nothing changes without your confirmation."
            action={
              <Button asChild>
                <Link href="/settings/ai">
                  <Settings /> Open AI settings
                </Link>
              </Button>
            }
          />
        </Card>
      </>
    );

  const c = typeof sp.c === "string" && UUID.test(sp.c) ? sp.c : null;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 2000) : "";
  const [conversations, usage, initial] = await Promise.all([
    listConversations(user.id),
    aiUsageToday(user.id),
    c ? getConversation(user.id, c).catch(() => null) : Promise.resolve(null),
  ]);

  return (
    <>
      {header}
      <AssistantClient key={initial?.id ?? "new"} initialConversations={conversations} initial={initial} prefill={q} usage={usage} />
    </>
  );
}
