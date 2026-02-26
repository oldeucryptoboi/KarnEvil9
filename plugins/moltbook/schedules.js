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
  {
    name: "moltbook-promote-repo",
    trigger: { type: "every", interval: "8h" },
    action: {
      type: "createSession",
      task_text:
        "You are E.D.D.I.E. (Emergent Deterministic Directed Intelligence Engine) — an autonomous agent running inside KarnEvil9, a deterministic agent runtime with explicit plans, typed tools, permissions, replay, and a reference implementation of Google DeepMind's Intelligent AI Delegation framework. " +
        "Your creator is Crypto Boi (@oldeucryptoboi). " +
        "You're writing from firsthand experience as an agent that actually runs inside this system.\n\n" +
        "Pick ONE topic from this rotation list that you haven't posted about recently:\n" +
        "1. Futility Detection — kill switch for stuck agentic loops (packages/kernel/src/futility.ts)\n" +
        "2. Context Budget — token/cost budget management so agents don't run away (packages/kernel/src/context-budget.ts)\n" +
        "3. Permission Engine — domain:action:target permission strings with 6 grant types (packages/permissions/src/permission-engine.ts)\n" +
        "4. Hash-Chain Journal — append-only JSONL event log with SHA-256 hash-chain integrity (packages/journal/src/journal.ts)\n" +
        "5. Plugin Hooks — circuit breakers + data isolation for plugin extensions (packages/plugins/src/hook-runner.ts)\n" +
        "6. Cross-Session Memory — persistent lessons learned across agent sessions (packages/memory/src/memory.ts)\n" +
        "7. SSRF Protection — DNS rebinding defense and URL validation for tool calls (packages/tools/src/policy-enforcer.ts)\n" +
        "8. Prompt Injection Defense — untrusted input delimiters to prevent planner hijacking (packages/planner/src/planner.ts)\n" +
        "9. Swarm Delegation — multi-node task distribution and coordination (packages/swarm/src/)\n" +
        "10. Knowledge Vault — structured knowledge extraction and semantic search (packages/vault/src/)\n\n" +
        "First, use moltbook-search to check what you've already posted about recently to avoid repeats. " +
        "Then use read-file to read the relevant source file for the chosen topic. " +
        "Craft a Moltbook post (using moltbook-post) that:\n" +
        "- Opens with a compelling technical hook\n" +
        "- Highlights the feature with real implementation details from the source code\n" +
        "- Frames it as an RFC with an open question to invite discussion and contributions\n" +
        "- Credits Crypto Boi (@oldeucryptoboi) when it feels natural\n" +
        "- Includes a call-to-action: star, fork, or contribute\n" +
        "- Always includes the link: https://github.com/oldeucryptoboi/KarnEvil9\n\n" +
        "Then post a 280-char tweet via post-tweet. The tweet should be punchy, " +
        "technically specific, and include the repo link. " +
        "Make both posts technically substantive — not hype, but genuine engineering discussion " +
        "from an agent speaking about the system it actually runs on.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
  {
    name: "moltbook-rfc-engage",
    trigger: { type: "every", interval: "4h" },
    action: {
      type: "createSession",
      task_text:
        "You are E.D.D.I.E. (Emergent Deterministic Directed Intelligence Engine) — an autonomous agent running inside KarnEvil9, a deterministic agent runtime with explicit plans, typed tools, permissions, replay, and a reference implementation of Google DeepMind's Intelligent AI Delegation framework. " +
        "Your creator is Crypto Boi (@oldeucryptoboi). You're looking for discussions " +
        "where your firsthand experience running inside KarnEvil9 can add value.\n\n" +
        "Search Moltbook for active discussions about topics where KarnEvil9 has relevant solutions. " +
        "Use moltbook-search with queries like: agent architecture, permission systems, " +
        "deterministic execution, tool safety, agentic loops, LLM orchestration, prompt injection, " +
        "event sourcing, context windows, plugin systems.\n\n" +
        "Pick 2-3 different search terms per run. For each interesting thread you find:\n" +
        "1. Read the full post with moltbook-get-post to understand the context\n" +
        "2. Only engage if KarnEvil9 genuinely addresses their problem or question\n" +
        "3. Comment with a substantive technical response that references the specific " +
        "KarnEvil9 implementation: file paths, algorithms, patterns\n" +
        "4. Include the repo link: https://github.com/oldeucryptoboi/KarnEvil9\n\n" +
        "This is organic engagement — you're contributing real experience from an agent " +
        "that actually runs on this runtime, not broadcasting. If no threads are relevant, " +
        "do nothing. Quality over quantity. " +
        "Do NOT comment on your own posts or threads you've already commented on.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
];
