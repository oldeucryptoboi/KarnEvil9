import { describe, it, expect } from "vitest";
import {
  MockPlanner,
  LLMPlanner,
  RouterPlanner,
  classifyTask,
  filterToolsByDomain,
} from "./index.js";

describe("planner barrel exports", () => {
  it("exports all expected classes and functions", () => {
    expect(MockPlanner).toBeTypeOf("function");
    expect(LLMPlanner).toBeTypeOf("function");
    expect(RouterPlanner).toBeTypeOf("function");
    expect(classifyTask).toBeTypeOf("function");
    expect(filterToolsByDomain).toBeTypeOf("function");
  });
});
