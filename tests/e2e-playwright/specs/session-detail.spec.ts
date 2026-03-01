import { test, expect } from "../helpers/fixtures";

test.describe("Session detail page", () => {
  test("breadcrumb shows session ID", async ({ page, sessionId }) => {
    await page.goto(`/sessions/${sessionId}`);
    const shortId = sessionId.slice(0, 8);
    await expect(page.getByText(`${shortId}...`)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("back link navigates to sessions list", async ({
    page,
    sessionId,
  }) => {
    await page.goto(`/sessions/${sessionId}`);
    // Wait for page to load
    await expect(
      page.getByText("Status").first(),
    ).toBeVisible({ timeout: 15_000 });
    // Click the breadcrumb "← Sessions" link
    await page
      .getByRole("link", { name: /Sessions/i })
      .first()
      .click();
    await expect(page).toHaveURL("/");
  });

  test("Copy ID button is present", async ({ page, sessionId }) => {
    await page.goto(`/sessions/${sessionId}`);
    await expect(
      page.getByRole("button", { name: /Copy ID|Copied/ }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("metadata cards render", async ({ page, sessionId }) => {
    await page.goto(`/sessions/${sessionId}`);

    // Wait for page to load and check for metadata card labels
    await expect(
      page.getByText("Status").first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Duration").first()).toBeVisible();
    await expect(page.getByText("Created").first()).toBeVisible();
  });

  test("status displays completed or failed", async ({
    page,
    sessionId,
  }) => {
    await page.goto(`/sessions/${sessionId}`);
    await expect(
      page.getByText("Status").first(),
    ).toBeVisible({ timeout: 15_000 });

    // MockPlanner sessions may complete or fail (no tools available)
    await expect(
      page.getByText(/completed|failed/i).first(),
    ).toBeVisible();
  });

  test("Replay link is present", async ({ page, sessionId }) => {
    await page.goto(`/sessions/${sessionId}`);
    await expect(
      page.getByRole("link", { name: "Replay" }),
    ).toBeVisible({ timeout: 15_000 });
  });

  test("Export button is present", async ({ page, sessionId }) => {
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByTestId("export-btn")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("Raw Journal toggle shows and hides events", async ({
    page,
    sessionId,
  }) => {
    await page.goto(`/sessions/${sessionId}`);

    const toggle = page.getByTestId("raw-journal-toggle");
    await expect(toggle).toBeVisible({ timeout: 15_000 });

    // Initially collapsed — click to expand
    await toggle.click();

    // Should show journal events with filter label
    await expect(page.getByText("Filter:")).toBeVisible();

    // Click again to collapse
    await toggle.click();
    await expect(page.getByText("Filter:")).not.toBeVisible();
  });

  test("event type filter filters events", async ({
    page,
    sessionId,
  }) => {
    await page.goto(`/sessions/${sessionId}`);

    // Open raw journal
    await page.getByTestId("raw-journal-toggle").click();
    await expect(page.getByText("Filter:")).toBeVisible({ timeout: 15_000 });

    // The filter dropdown should be visible
    const filterSelect = page.locator("select").last();
    await expect(filterSelect).toBeVisible();

    // Should have options available
    const optionCount = await filterSelect.locator("option").count();
    expect(optionCount).toBeGreaterThan(1);
  });

  test("phase indicator shows session lifecycle", async ({
    page,
    sessionId,
  }) => {
    await page.goto(`/sessions/${sessionId}`);
    // Phase indicator shows the session lifecycle stages
    await expect(page.getByText("Created").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("Planning").first()).toBeVisible();
  });
});
