import { expect, test } from "@playwright/test";
import { addExpense, createInvite, PASSWORD, registerAndSkipOnboarding } from "./helpers";

test("invite-only: registration without a valid code fails", async ({ page }) => {
  await page.goto("/register");
  await page.fill("#inviteCode", "ZZZZ-ZZZZ-ZZZZ");
  await page.fill("#email", `nobody-${Date.now()}@example.com`);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await expect(page.getByRole("alert").first()).toContainText(/isn't valid/);
});

test("used invite codes are rejected", async ({ page, browser }) => {
  const code = createInvite();
  await page.goto("/register");
  await page.fill("#inviteCode", code);
  await page.fill("#email", `first-${Date.now()}@example.com`);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/onboarding");
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto("/register");
  await p2.fill("#inviteCode", code);
  await p2.fill("#email", `second-${Date.now()}@example.com`);
  await p2.fill("#password", PASSWORD);
  await p2.click("button[type=submit]");
  await expect(p2.getByRole("alert").first()).toContainText(/already been used/);
  await other.close();
});

test("signed-out users are redirected to login", async ({ page }) => {
  await page.goto("/transactions");
  await expect(page).toHaveURL(/\/login/);
});

test("add, find, edit and delete an expense; data survives logout/login", async ({ page }) => {
  const { email } = await registerAndSkipOnboarding(page);
  await addExpense(page, "123.45", "E2E Coffee House");
  await page.goto("/transactions?q=coffee house");
  await expect(page.getByText("E2E Coffee House")).toBeVisible();
  await expect(page.getByText(/123\.45/).first()).toBeVisible();

  // Edit amount
  await page.getByText("E2E Coffee House").click();
  await page.waitForSelector("#amount");
  await page.fill("#amount", "150");
  await page.click("button:has-text('Save changes')");
  await expect(page.getByText(/150\.00/).first()).toBeVisible();

  // Logout → login → still there
  await page.click("[aria-label='Account menu']");
  await page.click("text=Sign out");
  await page.waitForURL("**/login");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL("**/dashboard");
  await page.goto("/transactions");
  await expect(page.getByText("E2E Coffee House")).toBeVisible();

  // Delete
  await page.getByText("E2E Coffee House").click();
  await page.click("button:has-text('Delete')");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Transaction deleted")).toBeVisible();
});

test("user B cannot open user A's transaction by id", async ({ browser }) => {
  const a = await browser.newContext();
  const pa = await a.newPage();
  await registerAndSkipOnboarding(pa, "Alice");
  await addExpense(pa, "999", "Alice Private Store");
  // Grab A's transaction id from global search results (same API the palette uses)
  const search = await pa.request.get("/api/search?q=alice private");
  const { results } = await search.json();
  const txnId = results.find((r: { kind: string }) => r.kind === "transaction").id as string;

  const b = await browser.newContext();
  const pb = await b.newPage();
  await registerAndSkipOnboarding(pb, "Bob");
  await pb.goto(`/transactions?open=${txnId}`);
  await expect(pb.getByText("Transaction not found")).toBeVisible();
  const bSearch = await (await pb.request.get("/api/search?q=alice")).json();
  expect(bSearch.results).toHaveLength(0);
  const receipt = await pb.request.get(`/api/receipts/${txnId}`);
  expect(receipt.status()).toBe(404);
  await a.close();
  await b.close();
});

test("API rejects cross-site mutations and unauthenticated access", async ({ request }) => {
  expect((await request.get("/api/search?q=test")).status()).toBe(401);
  const r = await request.post("/api/receipts", { headers: { Origin: "https://evil.example" }, multipart: { file: { name: "x.png", mimeType: "image/png", buffer: Buffer.from("x") } } });
  expect([401, 403]).toContain(r.status());
});
