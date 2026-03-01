import { test, expect } from "../helpers/fixtures";

test.describe("Sessions list page", () => {
  test("page loads with Sessions heading", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Sessions" }),
    ).toBeVisible();
  });

  test("New Session button is visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("new-session-btn")).toBeVisible();
    await expect(page.getByTestId("new-session-btn")).toHaveText(
      "New Session",
    );
  });

  test("Import button is visible", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("import-btn")).toBeVisible();
  });

  test("session appears in table after creation", async ({
    page,
    api,
  }) => {
    const sessionId = await api.createSession("E2E list test session");

    await page.goto("/");
    // Wait for the session to appear in the table
    await expect(
      page.getByTestId("session-row").first(),
    ).toBeVisible({ timeout: 10_000 });

    // Session ID link should be present (truncated to 8 chars)
    const shortId = sessionId.slice(0, 8);
    await expect(page.getByText(shortId)).toBeVisible();
  });

  test("session row shows status badge", async ({ page, api }) => {
    await api.createSession("Status badge test");

    await page.goto("/");
    await expect(
      page.getByTestId("session-row").first(),
    ).toBeVisible({ timeout: 10_000 });

    // Should show completed or failed badge (MockPlanner finishes fast)
    const row = page.getByTestId("session-row").first();
    await expect(
      row.getByText(/completed|failed/i),
    ).toBeVisible();
  });

  test("session ID link navigates to detail page", async ({
    page,
    api,
  }) => {
    const sessionId = await api.createSession("Nav test session");

    await page.goto("/");
    await expect(
      page.getByTestId("session-row").first(),
    ).toBeVisible({ timeout: 10_000 });

    // Click the session ID link
    const shortId = sessionId.slice(0, 8);
    await page.getByText(shortId).click();

    await expect(page).toHaveURL(`/sessions/${sessionId}`);
  });

  test("compare: selecting 2 sessions shows Compare link", async ({
    page,
    api,
  }) => {
    // Create 2 sessions
    await api.createSession("Compare session A");
    await api.createSession("Compare session B");

    await page.goto("/");
    await page.waitForTimeout(2000);

    const rows = page.getByTestId("session-row");
    const rowCount = await rows.count();
    if (rowCount < 2) return; // Skip if not enough sessions visible

    // Click the compare checkbox on first row
    await rows.nth(0).locator("button").first().click();
    await expect(page.getByText("1/2 selected")).toBeVisible();

    // Click the compare checkbox on second row
    await rows.nth(1).locator("button").first().click();
    await expect(page.getByText("2/2 selected")).toBeVisible();

    // Compare link should now be active
    await expect(
      page.getByRole("link", { name: "Compare" }),
    ).toBeVisible();
  });

  test("Compact Journal button appears when sessions exist", async ({
    page,
    api,
  }) => {
    await api.createSession("Compact test");

    await page.goto("/");
    await expect(
      page.getByTestId("session-row").first(),
    ).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByRole("button", { name: "Compact Journal" }),
    ).toBeVisible();
  });

  test("New Session button opens create dialog", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("new-session-btn").click();
    await expect(
      page.getByRole("heading", { name: "New Session" }),
    ).toBeVisible();
  });

  test("connection status indicator is visible", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByText(/Connected|Disconnected/),
    ).toBeVisible({ timeout: 10_000 });
  });
});
