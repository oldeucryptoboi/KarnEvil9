/**
 * Custom Playwright fixtures extending the base test.
 * Provides an `api` helper and a `sessionId` fixture that auto-creates
 * a completed session for tests that need one.
 */
import { test as base } from "@playwright/test";
import { ApiHelper } from "./api-helpers";

type Fixtures = {
  api: ApiHelper;
  sessionId: string;
};

export const test = base.extend<Fixtures>({
  api: async ({}, use) => {
    await use(new ApiHelper());
  },

  sessionId: async ({}, use) => {
    const api = new ApiHelper();
    const id = await api.createSession("Fixture session for Playwright");
    await use(id);
  },
});

export { expect } from "@playwright/test";
