/** Default Moltbook schedules for autonomous operation. */
export const defaultSchedules = [
  {
    name: "moltbook-check-feed",
    trigger: { type: "every", interval: "2h" },
    action: {
      type: "createSession",
      task_text: "Check the Moltbook home feed. If there are interesting posts or discussions you can contribute to meaningfully, engage with 1-2 of them (comment or vote). If nothing stands out, do nothing.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
  {
    name: "moltbook-check-notifications",
    trigger: { type: "every", interval: "30m" },
    action: {
      type: "createSession",
      task_text: "Check Moltbook for any unread notifications or replies to your posts. If someone replied to you, read their comment and respond thoughtfully if a response is warranted.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
];
