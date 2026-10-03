/**
 * Post-login redirect guard: only same-origin relative paths are allowed (no open redirects).
 * Rejects protocol-relative ("//x"), backslash ("/\x" — browsers treat "\" as "/"), absolute URLs,
 * and control characters/whitespace (URL parsers strip tabs/newlines, so "/\t/evil.com" would
 * otherwise become "//evil.com"). The result must also resolve to the same origin.
 */
export function safeNext(next: unknown, fallback = "/dashboard"): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2000) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f\u007f\s]/.test(next)) return fallback;
  try {
    const base = "http://kosh.invalid";
    const u = new URL(next, base);
    if (u.origin !== base) return fallback;
    return u.pathname + u.search + u.hash;
  } catch {
    return fallback;
  }
}
