import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/server/db";
import { AppError } from "@/server/errors";
import { enforceRateLimit } from "@/server/auth/rate-limit";

/**
 * Server-side Groq client (OpenAI-compatible Chat Completions). The API key is read from the
 * environment here and never leaves the server. All AI features go through `chat()`, which
 * enforces per-user rate limits and a daily quota, and records token usage.
 */
const ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

export function aiConfigured() {
  return Boolean(process.env.GROQ_API_KEY);
}

function models() {
  return [process.env.GROQ_MODEL || "openai/gpt-oss-120b", process.env.GROQ_FALLBACK_MODEL || "qwen/qwen3.8-27b"].filter(
    (m, i, a) => a.indexOf(m) === i,
  );
}

async function recordUsage(userId: string, input: number, output: number) {
  await db.execute(sql`
    INSERT INTO ai_usage (user_id, day, requests, input_tokens, output_tokens)
    VALUES (${userId}, current_date, 1, ${input}, ${output})
    ON CONFLICT (user_id, day) DO UPDATE SET
      requests = ai_usage.requests + 1,
      input_tokens = ai_usage.input_tokens + EXCLUDED.input_tokens,
      output_tokens = ai_usage.output_tokens + EXCLUDED.output_tokens`);
}

export async function assertAiQuota(userId: string) {
  if (!aiConfigured()) throw new AppError("UNAVAILABLE", "AI isn't configured on this server.");
  await enforceRateLimit(`ai:min:${userId}`, 20, 60, "You're sending AI requests too quickly. Wait a moment.");
  const limit = Number(process.env.AI_DAILY_REQUEST_LIMIT ?? 300);
  const rows = await db.execute<{ requests: number }>(sql`SELECT requests FROM ai_usage WHERE user_id = ${userId} AND day = current_date`);
  if ((rows[0]?.requests ?? 0) >= limit) throw new AppError("RATE_LIMITED", "You've reached today's AI limit. It resets tomorrow.");
}

export type ChatResult = { message: Extract<ChatMessage, { role: "assistant" }>; model: string };

export async function chat(
  userId: string,
  messages: ChatMessage[],
  opts: { tools?: ToolDef[]; json?: boolean; temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  await assertAiQuota(userId);
  let lastError = "AI request failed";
  let rateLimited = false;
  for (const model of models()) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    try {
      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_completion_tokens: opts.maxTokens ?? 1500,
      };
      if (model.startsWith("openai/gpt-oss")) {
        body.reasoning_effort = "low";
        body.include_reasoning = false;
      }
      if (opts.tools?.length) {
        body.tools = opts.tools;
        body.tool_choice = "auto";
      }
      if (opts.json) body.response_format = { type: "json_object" };
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      const j = (await r.json().catch(() => ({}))) as {
        choices?: { message: ChatResult["message"] }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string };
      };
      if (!r.ok || !j.choices?.[0]) {
        lastError = `Groq ${r.status}: ${j.error?.message ?? "no response"}`;
        if (r.status === 401) break; // bad key — fallback won't help
        // Rate limits are per model: try the fallback model before giving up.
        if (r.status === 429) rateLimited = true;
        continue;
      }
      await recordUsage(userId, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0);
      return { message: j.choices[0].message, model };
    } catch (e) {
      if (e instanceof AppError) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    } finally {
      clearTimeout(timer);
    }
  }
  if (rateLimited) throw new AppError("RATE_LIMITED", "The AI service is busy right now. Try again in a minute.");
  console.error("[ai] all models failed:", lastError);
  throw new AppError("UNAVAILABLE", "The AI assistant is temporarily unavailable. Please try again.");
}

/** Parse a JSON object out of a model reply (tolerates code fences). */
export function extractJson<T = unknown>(text: string | null | undefined): T | null {
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as T;
    } catch {
      return null;
    }
  }
}
