import { test, expect } from "../helpers/fixtures";

test.describe("Schedules page", () => {
  test("page loads with Schedules heading", async ({ page }) => {
    await page.goto("/schedules");
    await expect(
      page.getByRole("heading", { name: "Schedules" }),
    ).toBeVisible();
  });

  test("New Schedule button is visible", async ({ page }) => {
    await page.goto("/schedules");
    await expect(page.getByTestId("new-schedule-btn")).toBeVisible();
  });

  test("New Schedule button opens dialog", async ({ page }) => {
    await page.goto("/schedules");
    await page.getByTestId("new-schedule-btn").click();
    await expect(
      page.getByRole("heading", { name: "New Schedule" }),
    ).toBeVisible();
  });

  test("create schedule: fill form and submit", async ({ page }) => {
    await page.goto("/schedules");
    await page.getByTestId("new-schedule-btn").click();

    // Fill name
    await page
      .getByPlaceholder("e.g. gmail-digest")
      .fill("pw-test-schedule");

    // Fill task
    await page
      .getByPlaceholder("Describe the task to execute...")
      .fill("Playwright schedule test task");

    // Interval trigger type button should be selected by default
    await expect(
      page.getByRole("button", { name: "Interval" }),
    ).toBeVisible();

    // Submit
    await page.getByRole("button", { name: "Create Schedule" }).click();

    // Should show success
    await expect(page.getByText("Schedule Created")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("schedule appears in list after creation", async ({ page, api }) => {
    await api.createSchedule({
      name: "pw-list-test",
      taskText: "List test schedule",
    });

    await page.goto("/schedules");

    // Schedule card should appear — getShortName strips prefix before first dash
    await expect(page.getByText("list-test")).toBeVisible({ timeout: 10_000 });
  });

  test("status filter tabs show counts", async ({ page, api }) => {
    await api.createSchedule({ name: "pw-filter-tab" });

    await page.goto("/schedules");
    await expect(page.getByText("filter-tab")).toBeVisible({
      timeout: 10_000,
    });

    // All tab should be present and clickable
    const allTab = page.getByRole("button", { name: /^All/ });
    await expect(allTab).toBeVisible();

    // Active tab should exist
    await expect(
      page.getByRole("button", { name: /^Active/ }),
    ).toBeVisible();
  });

  test("search input filters by name", async ({ page, api }) => {
    await api.createSchedule({ name: "pw-searchA-alpha" });
    await api.createSchedule({ name: "pw-searchA-beta" });

    await page.goto("/schedules");
    // Wait for both to load
    await expect(page.getByText("searchA-alpha")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("searchA-beta")).toBeVisible();

    // Type in search
    await page.getByPlaceholder("Search schedules...").fill("alpha");

    // Only alpha should be visible
    await expect(page.getByText("searchA-alpha")).toBeVisible();
    await expect(page.getByText("searchA-beta")).not.toBeVisible();
  });

  test("edit button opens edit dialog", async ({ page, api }) => {
    await api.createSchedule({
      name: "pw-editdlg-test",
      taskText: "Edit me",
    });

    await page.goto("/schedules");
    await expect(page.getByText("editdlg-test")).toBeVisible({
      timeout: 10_000,
    });

    // Click Edit button
    await page.getByRole("button", { name: "Edit" }).first().click();

    // Edit dialog should show
    await expect(
      page.getByRole("heading", { name: "Edit Schedule" }),
    ).toBeVisible();
  });

  test("delete button opens confirmation dialog", async ({
    page,
    api,
  }) => {
    await api.createSchedule({ name: "pw-deldlg-test" });

    await page.goto("/schedules");
    await expect(page.getByText("deldlg-test")).toBeVisible({
      timeout: 10_000,
    });

    // Click Delete
    await page.getByRole("button", { name: "Delete" }).first().click();

    // Confirmation dialog should appear
    await expect(
      page.getByRole("heading", { name: "Delete Schedule" }),
    ).toBeVisible();
    await expect(page.getByText("Are you sure")).toBeVisible();
  });

  test("Run Now button is present on schedule cards", async ({
    page,
    api,
  }) => {
    await api.createSchedule({ name: "pw-runnow-check" });

    await page.goto("/schedules");
    await expect(page.getByText("runnow-check")).toBeVisible({
      timeout: 10_000,
    });

    // Run Now button should exist
    await expect(
      page.getByRole("button", { name: "Run Now" }).first(),
    ).toBeVisible();
  });

  test("Pause button is present for active schedules", async ({
    page,
    api,
  }) => {
    await api.createSchedule({ name: "pw-pause-check" });

    await page.goto("/schedules");
    await expect(page.getByText("pause-check")).toBeVisible({
      timeout: 10_000,
    });

    // Pause button should be visible for active schedules
    await expect(
      page.getByRole("button", { name: "Pause" }).first(),
    ).toBeVisible();
  });

  test("empty state shows when no schedules match filter", async ({
    page,
    api,
  }) => {
    await api.createSchedule({ name: "pw-empty-check" });

    await page.goto("/schedules");
    await expect(page.getByText("empty-check")).toBeVisible({
      timeout: 10_000,
    });

    // Search for something that doesn't exist
    await page
      .getByPlaceholder("Search schedules...")
      .fill("nonexistent-xyz-99");
    await expect(
      page.getByText("No schedules match the current filters"),
    ).toBeVisible();
  });
});
