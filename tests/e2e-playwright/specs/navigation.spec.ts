import { test, expect } from "../helpers/fixtures";

test.describe("Sidebar navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("sidebar renders KarnEvil9 branding", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "KarnEvil9" })).toBeVisible();
    await expect(page.getByText("Dashboard")).toBeVisible();
  });

  test("sidebar renders all nav items", async ({ page }) => {
    const navLabels = [
      "Sessions",
      "Approvals",
      "Journal",
      "Schedules",
      "Tools",
      "Plugins",
      "Vault",
      "Swarm",
      "Metrics",
      "Settings",
    ];

    for (const label of navLabels) {
      await expect(
        page.getByTestId(`nav-${label.toLowerCase()}`),
      ).toBeVisible();
    }
  });

  test("Sessions nav link navigates to home page", async ({ page }) => {
    await page.getByTestId("nav-sessions").click();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await expect(page).toHaveURL("/");
  });

  test("Schedules nav link navigates to schedules page", async ({ page }) => {
    await page.getByTestId("nav-schedules").click();
    await expect(
      page.getByRole("heading", { name: "Schedules" }),
    ).toBeVisible();
    await expect(page).toHaveURL("/schedules");
  });

  test("Plugins nav link navigates to plugins page", async ({ page }) => {
    await page.getByTestId("nav-plugins").click();
    await expect(
      page.getByRole("heading", { name: "Plugins" }),
    ).toBeVisible();
    await expect(page).toHaveURL("/plugins");
  });

  test("Journal nav link navigates to journal page", async ({ page }) => {
    await page.getByTestId("nav-journal").click();
    await expect(
      page.getByRole("heading", { name: "Journal Explorer" }),
    ).toBeVisible();
    await expect(page).toHaveURL("/journal");
  });

  test("Settings nav link navigates to settings page", async ({ page }) => {
    await page.getByTestId("nav-settings").click();
    await expect(
      page.getByRole("heading", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL("/settings");
  });

  test("active nav item is highlighted on current page", async ({ page }) => {
    // Navigate to schedules
    await page.getByTestId("nav-schedules").click();
    await expect(page).toHaveURL("/schedules");

    // The schedules nav link should have the active styling
    const schedulesLink = page.getByTestId("nav-schedules");
    await expect(schedulesLink).toHaveClass(/text-\[var\(--accent\)\]/);
  });
});
