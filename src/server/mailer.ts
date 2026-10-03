/**
 * Minimal transactional mailer. Uses Resend's HTTP API when RESEND_API_KEY is set; otherwise
 * logs the message server-side (development) so flows like password reset remain testable.
 */
export async function sendEmail(msg: { to: string; subject: string; text: string }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM ?? "Kosh <no-reply@example.com>";
  if (!key) {
    if (process.env.NODE_ENV !== "production") console.info(`\n[mail:dev] To: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n`);
    else console.warn("[mail] RESEND_API_KEY not configured — email not sent:", msg.subject);
    return { delivered: false };
  }
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: msg.to, subject: msg.subject, text: msg.text }),
  });
  if (!r.ok) console.error("[mail] send failed", r.status);
  return { delivered: r.ok };
}

export const appUrl = () => (process.env.APP_URL ?? "http://localhost:3210").replace(/\/$/, "");
