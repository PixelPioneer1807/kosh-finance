/**
 * Cross-cutting security checks: cookie flags, redirect guard, route auth/origin checks,
 * receipt serving headers, cron authentication and CSV formula injection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createSession } from "@/server/auth/sessions";
import { saveReceipt } from "@/server/services/receipts";
import { notify } from "@/server/services/notifications";
import { listPushSubscriptions } from "@/server/services/push";
import { safeNext } from "@/lib/safe-redirect";
import { csvCell } from "@/lib/csv";
import { makeUser } from "./helpers";

// A fake request scope for next/headers: a cookie jar and request headers we control.
const scope = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  setCalls: [] as { name: string; value: string; options: Record<string, unknown> }[],
  headers: new Headers(),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (scope.cookies.has(name) ? { name, value: scope.cookies.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      scope.setCalls.push({ name, value, options });
      scope.cookies.set(name, value);
    },
  }),
  headers: async () => scope.headers,
}));
// Never reach real push services from tests.
vi.mock("web-push", () => {
  const sendNotification = vi.fn(async () => ({ statusCode: 201, body: "", headers: {} }));
  return { default: { sendNotification }, sendNotification };
});

const DEV_COOKIE = "kosh_session";

async function signInAs(userId: string) {
  const { token } = await createSession(userId);
  scope.cookies.clear();
  scope.cookies.set(DEV_COOKIE, token);
}

beforeEach(() => {
  scope.setCalls.length = 0;
  scope.headers = new Headers({ host: "localhost:3210", "user-agent": "vitest" });
});

describe("session cookie", () => {
  it("is httpOnly, SameSite=Lax, path=/ and expiring", async () => {
    const { setSessionCookie, clearSessionCookie } = await import("@/server/auth/current");
    const expires = new Date(Date.now() + 86_400_000);
    await setSessionCookie("token-value-xyz", expires);
    const call = scope.setCalls.at(-1)!;
    expect(call.name).toBe(DEV_COOKIE);
    expect(call.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", expires });
    await clearSessionCookie();
    expect(scope.setCalls.at(-1)!.options).toMatchObject({ httpOnly: true, maxAge: 0, path: "/" });
  });

  it("is Secure with the __Host- prefix in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    try {
      const prod = await import("@/server/auth/current");
      await prod.setSessionCookie("token-value-xyz", new Date(Date.now() + 1000));
      const call = scope.setCalls.at(-1)!;
      expect(call.name).toBe("__Host-kosh_session");
      expect(call.options).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax", path: "/" });
      expect(call.options).not.toHaveProperty("domain");
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe("post-login redirect guard (safeNext)", () => {
  it("allows same-origin relative paths", () => {
    expect(safeNext("/transactions?range=last_30#top")).toBe("/transactions?range=last_30#top");
    expect(safeNext("/budgets")).toBe("/budgets");
  });
  it.each([
    "//evil.example",
    "/\\evil.example",
    "/\\/evil.example",
    "https://evil.example/",
    "http:evil.example",
    "javascript:alert(1)",
    "/\t/evil.example",
    "/\n/evil.example",
    " /dashboard",
    "",
    "dashboard",
  ])("rejects %j", (v) => {
    expect(safeNext(v)).toBe("/dashboard");
  });
  it("rejects non-strings", () => {
    expect(safeNext(undefined)).toBe("/dashboard");
    expect(safeNext(["/x"])).toBe("/dashboard");
    expect(safeNext({ toString: () => "/x" })).toBe("/dashboard");
  });
});

describe("proxy (optimistic routing)", () => {
  it("redirects signed-out visitors to login, preserving a relative next", async () => {
    const { proxy } = await import("@/proxy");
    const res = proxy(new NextRequest("http://localhost:3210/admin/users?q=a"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/admin/users?q=a");
    expect(proxy(new NextRequest("http://localhost:3210/offline")).headers.get("location")).toBeNull();
  });
});

describe("receipt route", () => {
  let A: Awaited<ReturnType<typeof makeUser>>;
  let B: Awaited<ReturnType<typeof makeUser>>;
  let receiptId: string;
  beforeAll(async () => {
    A = await makeUser();
    B = await makeUser();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
    receiptId = (await saveReceipt(A.id, { name: '../../evil".png', bytes: png })).id;
  });

  it("serves the owner's file with nosniff and a sandboxing CSP", async () => {
    const { GET } = await import("@/app/api/receipts/[id]/route");
    await signInAs(A.id);
    const res = await GET(new Request(`http://localhost:3210/api/receipts/${receiptId}`), { params: Promise.resolve({ id: receiptId }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/(^|;\s*)sandbox(;|$)/);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("content-disposition")).not.toMatch(/\.\.|\/|"[^"]*"[^"]*"/);
  });

  it("returns 404 to other users and 401 when signed out", async () => {
    const { GET } = await import("@/app/api/receipts/[id]/route");
    await signInAs(B.id);
    const res = await GET(new Request(`http://localhost:3210/api/receipts/${receiptId}`), { params: Promise.resolve({ id: receiptId }) });
    expect(res.status).toBe(404);
    scope.cookies.clear();
    const anon = await GET(new Request(`http://localhost:3210/api/receipts/${receiptId}`), { params: Promise.resolve({ id: receiptId }) });
    expect(anon.status).toBe(401);
  });
});

describe("notification & push routes", () => {
  let A: Awaited<ReturnType<typeof makeUser>>;
  let B: Awaited<ReturnType<typeof makeUser>>;
  beforeAll(async () => {
    A = await makeUser();
    B = await makeUser();
    await notify(A.id, { type: "system", title: "A only", body: "secret", dedupeKey: "sec:1" });
  });
  const ctx = { params: Promise.resolve({}) };

  it("requires a session and only returns the caller's notifications", async () => {
    const { GET } = await import("@/app/api/notifications/route");
    scope.cookies.clear();
    expect((await GET(new Request("http://localhost:3210/api/notifications"), ctx)).status).toBe(401);
    await signInAs(B.id);
    const res = await GET(new Request("http://localhost:3210/api/notifications"), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.items.map((n: { title: string }) => n.title)).not.toContain("A only");
    await signInAs(A.id);
    const mine = await (await GET(new Request("http://localhost:3210/api/notifications"), ctx)).json();
    expect(mine.unread).toBe(1);
    expect(mine.items[0].title).toBe("A only");
  });

  it("blocks cross-site mutations (Origin check)", async () => {
    const { POST } = await import("@/app/api/notifications/route");
    const sub = await import("@/app/api/push/subscribe/route");
    await signInAs(A.id);
    const evil = { origin: "https://evil.example", host: "localhost:3210", "content-type": "application/json" };
    expect((await POST(new Request("http://localhost:3210/api/notifications", { method: "POST", headers: evil, body: "{}" }), ctx)).status).toBe(403);
    const body = JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/evil-123456", keys: { p256dh: "BNcRdreALRFXTkOOUHK1", auth: "tBHItJI5svbpez7K" } });
    expect((await sub.POST(new Request("http://localhost:3210/api/push/subscribe", { method: "POST", headers: evil, body }), ctx)).status).toBe(403);
    expect(await listPushSubscriptions(A.id)).toHaveLength(0);
    // Same-origin works.
    const ok = await sub.POST(
      new Request("http://localhost:3210/api/push/subscribe", { method: "POST", headers: { ...evil, origin: "http://localhost:3210" }, body }),
      ctx,
    );
    expect(ok.status).toBe(200);
    expect(await listPushSubscriptions(A.id)).toHaveLength(1);
    // Garbage input is a 400, not a 500.
    const bad = await sub.POST(
      new Request("http://localhost:3210/api/push/subscribe", { method: "POST", headers: { ...evil, origin: "http://localhost:3210" }, body: "{not json" }),
      ctx,
    );
    expect(bad.status).toBe(400);
  });
});

describe("cron endpoint", () => {
  const SECRET = "test-cron-secret-0123456789abcdef";
  const original = process.env.CRON_SECRET;
  beforeAll(() => {
    process.env.CRON_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.CRON_SECRET = original;
  });

  it.each([
    ["missing", undefined],
    ["wrong", `Bearer ${SECRET.slice(0, -1)}x`],
    ["different length", `Bearer ${SECRET}x`],
    ["no scheme", SECRET],
    ["lowercase scheme", `bearer ${SECRET}`],
  ])("rejects a %s secret", async (_label, header) => {
    const { GET } = await import("@/app/api/cron/tick/route");
    const res = await GET(new Request("http://localhost:3210/api/cron/tick", { headers: header ? { authorization: header } : {} }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("refuses to run when no secret is configured", async () => {
    const { GET } = await import("@/app/api/cron/tick/route");
    process.env.CRON_SECRET = "";
    try {
      const res = await GET(new Request("http://localhost:3210/api/cron/tick", { headers: { authorization: "Bearer " } }));
      expect(res.status).toBe(503);
    } finally {
      process.env.CRON_SECRET = SECRET;
    }
  });

  it("runs with the right secret and returns aggregate counts only", async () => {
    const u = await makeUser();
    const { GET } = await import("@/app/api/cron/tick/route");
    const res = await GET(new Request("http://localhost:3210/api/cron/tick", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.users).toBe("number");
    expect(typeof body.housekeeping.purgedTransactions).toBe("number");
    expect(JSON.stringify(body)).not.toContain(u.email);
    expect(JSON.stringify(body)).not.toContain(u.id);
  }, 120_000);
});

describe("CSV export formula injection", () => {
  // What a spreadsheet would see once the CSV quoting is removed.
  const unquote = (cell: string) => (cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell);
  it.each(['=HYPERLINK("http://evil.example","x")', "+1+2", "@SUM(A1)", "-2+3", "  =1", "\t=1", "\r=1", "=cmd|' /C calc'!A0"])("neutralises %j", (input) => {
    const value = unquote(csvCell(input));
    expect(value.startsWith("'")).toBe(true);
    expect(value.slice(1)).toBe(input);
  });
  it("leaves plain numbers and text alone", () => {
    expect(csvCell("-12.5000")).toBe("-12.5000");
    expect(csvCell("Coffee, large")).toBe('"Coffee, large"');
    expect(csvCell(42)).toBe("42");
  });
});
