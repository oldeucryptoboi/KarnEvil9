import { describe, it, expect } from "vitest";
import {
  MockPlanner,
  LLMPlanner,
  RouterPlanner,
  classifyTask,
  filterToolsByDomain,
  IFPlanner,
  bfsPath,
} from "./index.js";

describe("planner barrel exports", () => {
  it("exports all expected classes and functions", () => {
    expect(MockPlanner).toBeTypeOf("function");
    expect(LLMPlanner).toBeTypeOf("function");
    expect(RouterPlanner).toBeTypeOf("function");
    expect(classifyTask).toBeTypeOf("function");
    expect(filterToolsByDomain).toBeTypeOf("function");
    expect(IFPlanner).toBeTypeOf("function");
    expect(bfsPath).toBeTypeOf("function");
  });

  it("IFPlanner can be instantiated with a mock callModel", () => {
    const planner = new IFPlanner({
      callModel: async () => ({ text: "look" }),
    });
    expect(planner).toBeDefined();
    expect(planner.generatePlan).toBeTypeOf("function");
  });
});
