import { test, expect } from "../helpers/fixtures";

test.describe("Plugins page", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/plugins");
  });

  test("page loads with Plugins heading", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Plugins" }),
    ).toBeVisible();
  });

  test("Refresh button is present", async ({ page }) => {
    await expect(
      page.getByRole("button", { name: "Refresh" }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("empty state shows when no plugins configured", async ({ page }) => {
    // Test server has no plugins, so empty state should show
    await expect(
      page.getByText("No plugins found"),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("empty state shows plugin setup instructions", async ({ page }) => {
    await expect(
      page.getByText("No plugins found"),
    ).toBeVisible({ timeout: 10_000 });

    // Should show instructions about plugins/ directory
    await expect(
      page.getByText("plugins/", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("plugin.yaml")).toBeVisible();
  });

  test("empty state mentions example-logger reference", async ({ page }) => {
    await expect(
      page.getByText("No plugins found"),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText("plugins/example-logger/"),
    ).toBeVisible();
  });

  test("Refresh button is clickable", async ({ page }) => {
    const refreshBtn = page.getByRole("button", { name: "Refresh" });
    await expect(refreshBtn).toBeVisible({ timeout: 10_000 });
    await refreshBtn.click();

    // Page should still show heading after refresh
    await expect(
      page.getByRole("heading", { name: "Plugins" }),
    ).toBeVisible();
  });

  test("page loads without errors", async ({ page }) => {
    await page.waitForTimeout(2000);
    await expect(
      page.getByRole("heading", { name: "Plugins" }),
    ).toBeVisible();
  });

  test("page layout renders correctly", async ({ page }) => {
    // Heading and Refresh button should be in the header area
    await expect(
      page.getByRole("heading", { name: "Plugins" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh" }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
