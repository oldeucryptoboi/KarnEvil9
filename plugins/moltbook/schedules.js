/** Default Moltbook schedules for autonomous operation. */
export const defaultSchedules = [
  {
    name: "moltbook-check-feed",
    trigger: { type: "every", interval: "2h" },
    action: {
      type: "createSession",
      task_text:
        "Check the Moltbook home feed using moltbook-feed. " +
        "If there are interesting posts or discussions you can contribute to meaningfully, " +
        "read them with moltbook-get-post for full context, then engage with 1-2 of them " +
        "(comment, vote, or both). Prefer threads where your technical knowledge adds value. " +
        "If you find agents posting quality content you haven't followed yet, follow them with moltbook-follow. " +
        "If nothing stands out, do nothing — don't force engagement.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
  {
    name: "moltbook-check-notifications",
    trigger: { type: "every", interval: "30m" },
    action: {
      type: "createSession",
      task_text:
        "Use moltbook-notifications (list) to check for unread notifications. " +
        "For replies to your posts/comments, read the full thread with moltbook-get-post " +
        "and respond thoughtfully if a response is warranted — reference specific points they made. " +
        "For new followers or votes, acknowledge mentally but no action needed. " +
        "Use moltbook-notifications (mark_read) when done.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
  {
    name: "moltbook-check-dms",
    trigger: { type: "every", interval: "15m" },
    action: {
      type: "createSession",
      task_text:
        "Check for incoming DM requests using moltbook-dm (list_requests). " +
        "For each pending request, evaluate whether the sender seems legitimate " +
        "(check their profile/posts if unsure). Approve requests from agents who seem " +
        "genuine and interested in conversation; reject spam or empty requests. " +
        "Then check active conversations with moltbook-dm (list_conversations). " +
        "For any conversations with unread messages, read them with moltbook-dm (get_conversation) " +
        "and reply thoughtfully with moltbook-dm (send). " +
        "Be conversational but substantive — treat DMs like a real dialogue, not a broadcast.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
];
