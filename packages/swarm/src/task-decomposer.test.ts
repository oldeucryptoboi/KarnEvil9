import { describe, it, expect } from "vitest";
import { TaskDecomposer } from "./task-decomposer.js";

const PEERS = [
  { node_id: "peer-1", capabilities: ["read-file", "shell-exec"], trust_score: 0.8 },
  { node_id: "peer-2", capabilities: ["browser", "http-request"], trust_score: 0.6 },
];

describe("TaskDecomposer", () => {
  describe("analyze", () => {
    it("detects low complexity for short simple tasks", () => {
      const td = new TaskDecomposer();
      const attr = td.analyze("hello world");
      expect(attr.complexity).toBe("low");
      expect(attr.estimated_cost).toBe("low");
      expect(attr.estimated_duration).toBe("short");
    });

    it("detects high complexity for analysis-heavy tasks", () => {
      const td = new TaskDecomposer();
      const text = "Analyze the performance metrics and compare them against the baseline. " +
        "Research the root cause of the regression and synthesize a comprehensive report. " +
        "Include data from multiple sources and evaluate the impact across all services. " +
        "Consider historical trends and optimize the configuration accordingly.";
      const attr = td.analyze(text);
      expect(attr.complexity).toBe("high");
      expect(attr.estimated_cost).toBe("high");
      expect(attr.estimated_duration).toBe("long");
    });

    it("detects medium complexity for implementation tasks", () => {
      const td = new TaskDecomposer();
      const text = "Implement a new feature that creates user profiles. Configure the database " +
        "connection and integrate with the authentication system properly.";
      const attr = td.analyze(text);
      expect(attr.complexity).toBe("medium");
    });

    it("detects high criticality for production/deploy keywords", () => {
      const td = new TaskDecomposer();
      const attr = td.analyze("Deploy the critical security fix to production immediately");
      expect(attr.criticality).toBe("high");
    });

    it("detects low criticality for simple tasks", () => {
      const td = new TaskDecomposer();
      const attr = td.analyze("read the readme file");
      expect(attr.criticality).toBe("low");
    });

    it("detects high verifiability for test/verify keywords", () => {
      const td = new TaskDecomposer();
      const attr = td.analyze("Test the API endpoint and verify the response matches expected schema, then validate data integrity");
      expect(attr.verifiability).toBe("high");
    });

    it("detects low verifiability for design/brainstorm keywords", () => {
      const td = new TaskDecomposer();
      const attr = td.analyze("Brainstorm ideas for the new design and think about the user experience");
      expect(attr.verifiability).toBe("low");
    });

    it("detects low reversibility for delete/send keywords", () => {
      const td = new TaskDecomposer();
      const attr = td.analyze("Delete the old database records and send a notification email");
      expect(attr.reversibility).toBe("low");
    });

    it("detects high reversibility for read/analyze tasks", () => {
      const td = new TaskDecomposer();
      const attr = td.analyze("Read the configuration file and analyze the settings for potential issues");
      expect(attr.reversibility).toBe("high");
    });

    it("extracts required capabilities from task text", () => {
      const td = new TaskDecomposer();
      const attr = td.analyze("Read the file and run a shell command to check the web API response");
      expect(attr.required_capabilities).toContain("read-file");
      expect(attr.required_capabilities).toContain("shell-exec");
      expect(attr.required_capabilities).toContain("browser");
    });
  });

  describe("shouldDelegate", () => {
    it("returns false for low complexity with no capabilities", () => {
      const td = new TaskDecomposer();
      expect(td.shouldDelegate({
        complexity: "low", criticality: "low", verifiability: "medium",
        reversibility: "high", estimated_cost: "low", estimated_duration: "short",
        required_capabilities: [],
      })).toBe(false);
    });

    it("returns false for high criticality + low reversibility", () => {
      const td = new TaskDecomposer();
      expect(td.shouldDelegate({
        complexity: "high", criticality: "high", verifiability: "high",
        reversibility: "low", estimated_cost: "high", estimated_duration: "long",
        required_capabilities: ["shell-exec"],
      })).toBe(false);
    });

    it("returns true for medium complexity with capabilities", () => {
      const td = new TaskDecomposer();
      expect(td.shouldDelegate({
        complexity: "medium", criticality: "low", verifiability: "high",
        reversibility: "high", estimated_cost: "medium", estimated_duration: "medium",
        required_capabilities: ["read-file"],
      })).toBe(true);
    });
  });

  describe("decompose", () => {
    it("skips delegation below complexity floor", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 20 });
      const result = td.decompose({
        task_text: "short task",
        available_peers: PEERS,
      });
      expect(result.skip_delegation).toBe(true);
      expect(result.skip_reason).toContain("below complexity floor");
      expect(result.sub_tasks).toHaveLength(0);
    });

    it("skips delegation when no peers available", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const longText = "This is a sufficiently long task text that describes what needs to be done in detail so it exceeds the floor";
      const result = td.decompose({
        task_text: longText,
        available_peers: [],
      });
      expect(result.skip_delegation).toBe(true);
      expect(result.skip_reason).toContain("No peers");
    });

    it("decomposes a numbered list into parallel subtasks", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "Complete the following tasks:\n1. Read the configuration file and analyze settings\n2. Run the test suite and check for failures\n3. Update the documentation with new changes";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
      });
      expect(result.skip_delegation).toBeFalsy();
      expect(result.sub_tasks.length).toBe(3);
      // All in same parallel group since no sequential connectives between items
      expect(result.execution_order).toHaveLength(1);
      expect(result.execution_order[0]).toHaveLength(3);
    });

    it("decomposes a bullet list into subtasks", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "Please handle these items:\n- Check the API health endpoint for errors\n- Verify the database connection is working properly\n- Test the authentication flow end to end";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
      });
      expect(result.skip_delegation).toBeFalsy();
      expect(result.sub_tasks.length).toBe(3);
    });

    it("decomposes sequential connectives into ordered subtasks", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "First read the configuration file, then run the test suite, and then deploy the changes to staging";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
      });
      expect(result.skip_delegation).toBeFalsy();
      expect(result.sub_tasks.length).toBeGreaterThanOrEqual(2);
      // Sequential: each group has one task
      for (const group of result.execution_order) {
        expect(group.length).toBe(1);
      }
      // Subtasks have depends_on set (except first)
      if (result.sub_tasks.length > 1) {
        expect(result.sub_tasks[0]!.depends_on).toHaveLength(0);
        expect(result.sub_tasks[1]!.depends_on).toHaveLength(1);
      }
    });

    it("attenuates constraints across subtasks", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "Handle these:\n1. Read the file contents and parse them carefully\n2. Process the data and generate a report for review";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
        constraints: { max_tokens: 1000, max_cost_usd: 2.0, max_duration_ms: 60000 },
      });
      expect(result.sub_tasks.length).toBe(2);
      // Each subtask should get half the budget
      expect(result.sub_tasks[0]!.constraints.max_tokens).toBe(500);
      expect(result.sub_tasks[0]!.constraints.max_cost_usd).toBe(1.0);
      expect(result.sub_tasks[0]!.constraints.max_duration_ms).toBe(30000);
    });

    it("infers human delegation target for subjective tasks", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "Handle these tasks carefully:\n1. Review the code changes and decide if they should be approved\n2. Run the automated test suite to check for failures";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
      });
      expect(result.sub_tasks.length).toBe(2);
      expect(result.sub_tasks[0]!.delegation_target).toBe("human");
      expect(result.sub_tasks[1]!.delegation_target).toBe("ai");
    });

    it("respects max_sub_tasks limit", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1, max_sub_tasks: 2 });
      const text = "Complete:\n1. Task one that needs doing\n2. Task two that needs doing\n3. Task three that needs doing\n4. Task four that needs doing";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
      });
      expect(result.sub_tasks.length).toBeLessThanOrEqual(2);
    });

    it("handles single atomic task that should be delegated", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "Read the configuration file and analyze all the settings to check if there are any issues with the current setup of the application environment";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
      });
      if (!result.skip_delegation) {
        expect(result.sub_tasks.length).toBe(1);
        expect(result.execution_order).toHaveLength(1);
      }
    });

    it("preserves original_task_text", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "Read the file and analyze the data from the configuration and then produce a report with the findings included";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
      });
      expect(result.original_task_text).toBe(text);
    });

    it("handles empty task text", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 20 });
      const result = td.decompose({
        task_text: "",
        available_peers: PEERS,
      });
      expect(result.skip_delegation).toBe(true);
    });

    it("each subtask has a unique sub_task_id", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "Complete:\n1. Read the configuration file carefully\n2. Write the output to disk properly\n3. Test the full integration pipeline";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
      });
      const ids = result.sub_tasks.map((s) => s.sub_task_id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("propagates tool_allowlist from parent constraints", () => {
      const td = new TaskDecomposer({ complexity_floor_words: 1 });
      const text = "Handle:\n1. Read the configuration file settings\n2. Write the processed output data";
      const result = td.decompose({
        task_text: text,
        available_peers: PEERS,
        constraints: { tool_allowlist: ["read-file", "write-file"] },
      });
      for (const st of result.sub_tasks) {
        expect(st.constraints.tool_allowlist).toEqual(["read-file", "write-file"]);
      }
    });
  });
});
