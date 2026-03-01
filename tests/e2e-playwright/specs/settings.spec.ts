import { test, expect } from "../helpers/fixtures";

test.describe("Settings page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/settings");
  });

  test("page loads with Settings heading", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
  });

  test("server info section renders", async ({ page }) => {
    // Wait for health data to load — "SERVER INFO" heading is uppercase
    await expect(
      page.getByText("Server Info", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("subsystem health section renders", async ({ page }) => {
    await expect(
      page.getByText("Subsystem Health", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("notification or configuration section renders", async ({
    page,
  }) => {
    // Wait for the full page to load, then check for kernel configuration
    await expect(
      page.getByText("Kernel Configuration", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
