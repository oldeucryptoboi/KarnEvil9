import { test, expect } from "../helpers/fixtures";

test.describe("Journal page", () => {
  test("page loads with Journal Explorer heading", async ({ page }) => {
    await page.goto("/journal");
    await expect(
      page.getByRole("heading", { name: "Journal Explorer" }),
    ).toBeVisible();
  });

  test("session selector buttons are present", async ({ page, api }) => {
    await api.createSession("Journal selector test");

    await page.goto("/journal");
    // Quick-select buttons should be present — use .first() to avoid strict mode
    await expect(
      page.getByRole("button", { name: /Last 5/ }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("clicking session selector loads events", async ({
    page,
    api,
  }) => {
    await api.createSession("Journal events test");

    await page.goto("/journal");

    // Click "Last 5" button to load sessions
    const btn = page.getByRole("button", { name: /Last 5/ });
    await expect(btn).toBeVisible({ timeout: 10_000 });
    await btn.click();

    // Wait for events to load
    await page.waitForTimeout(3000);

    // Should show event data (type badges or stats)
    await expect(
      page.getByText("session.created").first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("search input is present", async ({ page }) => {
    await page.goto("/journal");
    const searchInput = page.getByPlaceholder(/Search/i);
    await expect(searchInput).toBeVisible({ timeout: 10_000 });
  });

  test("page renders without errors", async ({ page }) => {
    await page.goto("/journal");
    await expect(
      page.getByRole("heading", { name: "Journal Explorer" }),
    ).toBeVisible();
    await page.waitForTimeout(1000);
  });
});
