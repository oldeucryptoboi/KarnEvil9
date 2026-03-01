import { test, expect } from "../helpers/fixtures";

test.describe("Create Session dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("new-session-btn").click();
    await expect(
      page.getByRole("heading", { name: "New Session" }),
    ).toBeVisible();
  });

  test("dialog renders with all form elements", async ({ page }) => {
    await expect(
      page.getByPlaceholder("Describe the task..."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create Session" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel" }),
    ).toBeVisible();
  });

  test("Cancel button closes dialog", async ({ page }) => {
    await page.getByRole("button", { name: "Cancel" }).last().click();
    await expect(
      page.getByRole("heading", { name: "New Session" }),
    ).not.toBeVisible();
  });

  test("Escape key closes dialog", async ({ page }) => {
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("heading", { name: "New Session" }),
    ).not.toBeVisible();
  });

  test("backdrop click closes dialog", async ({ page }) => {
    // The backdrop uses onClick with e.target === backdropRef check.
    // Click at top-right corner (1200, 50) which is outside the centered dialog
    // but on the backdrop overlay (fixed inset-0 z-50).
    await page.mouse.click(1200, 50);
    await expect(
      page.getByRole("heading", { name: "New Session" }),
    ).not.toBeVisible();
  });

  test("valid task + submit creates session", async ({ page }) => {
    await page
      .getByPlaceholder("Describe the task...")
      .fill("Create session via Playwright");

    await page.getByRole("button", { name: "Create Session" }).click();

    // Should show success state with "Session Created" text
    await expect(page.getByText("Session Created")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("mode selector shows mock and live options", async ({ page }) => {
    // The mode select is the second <select> (first is template selector)
    const modeSelect = page.locator("select").nth(1);
    await expect(modeSelect).toBeVisible();
    await expect(modeSelect.locator("option[value='mock']")).toBeAttached();
    await expect(modeSelect.locator("option[value='live']")).toBeAttached();
  });

  test("agentic toggle works", async ({ page }) => {
    const toggle = page.getByRole("switch");
    await expect(toggle).toBeVisible();

    // Initially off
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Click to toggle on
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // Click again to toggle off
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("template selector dropdown is available", async ({ page }) => {
    // First <select> is the template selector
    const templateSelect = page.getByRole("combobox").first();
    await expect(templateSelect).toBeVisible();
  });
});
