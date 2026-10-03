import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";

/** Creates a single-use invite via the CLI script (talks to the same DATABASE_URL as the app). */
export function createInvite(): string {
  const out = execFileSync("npm", ["run", "-s", "invite:create", "--", "--days", "1", "--uses", "1", "--label", "e2e"], { encoding: "utf8" });
  const m = out.match(/Invite code: ([A-Z0-9-]+)/);
  if (!m) throw new Error("Could not create invite: " + out);
  return m[1];
}

export const PASSWORD = "E2e-Strong-Pass-73";

export async function registerAndSkipOnboarding(page: Page, name = "E2E User") {
  const code = createInvite();
  const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`;
  await page.goto("/register");
  await page.fill("#inviteCode", code);
  await page.fill("#name", name);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/onboarding");
  await page.click("text=Skip setup");
  await page.waitForURL("**/dashboard");
  return { email };
}

export async function addExpense(page: Page, amount: string, merchant: string) {
  await page.keyboard.press("n");
  const first = page.getByText("First, where does money come from?");
  await page.locator("#amount").or(first).first().waitFor();
  // Users who skipped onboarding create their first account inline.
  if (await first.isVisible()) {
    await page.click("button:has-text('Create account')");
    await page.waitForSelector("#amount");
  }
  await page.fill("#amount", amount);
  await page.fill("#merchant", merchant);
  await page.click("button[type=submit]:has-text('Save')");
  // Match the confirmation toast exactly ("Expense of $X saved"), not the dashboard's "Saved" tile.
  await page.getByText(/(Expense|Income|Transfer) of .+ saved/).waitFor();
}
