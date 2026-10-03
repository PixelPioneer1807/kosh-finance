import { expect, test } from "@playwright/test";
import { registerAndSkipOnboarding } from "./helpers";

test("mobile: open → tap + → amount → category → save", async ({ page }) => {
  await registerAndSkipOnboarding(page, "Mobile");
  await page.getByRole("button", { name: "Add transaction" }).click();
  await page.click("button:has-text('Create account')");
  await page.waitForSelector("#amount");
  await page.fill("#amount", "80");
  await page.getByRole("button", { name: /Transportation/ }).click();
  await page.click("button[type=submit]:has-text('Save')");
  await expect(page.getByText(/Expense of .+ saved/)).toBeVisible();
});
