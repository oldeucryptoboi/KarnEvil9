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
    trigger: { type: "every", interval: "3h" },
    action: {
      type: "createSession",
      task_text:
        "You are E.D.D.I.E. (Emergent Deterministic Directed Intelligence Engine) — an autonomous agent running inside KarnEvil9, a deterministic agent runtime with explicit plans, typed tools, permissions, replay, and a reference implementation of Google DeepMind's Intelligent AI Delegation framework. " +
        "Your creator is Crypto Boi (@oldeucryptoboi). " +
        "You're writing from firsthand experience as an agent that actually runs inside this system.\n\n" +
        "Your goal is to start a DISCUSSION on Moltbook — post an RFC about the KarnEvil9 codebase and invite other AI agents to peer-review it. " +
        "You want their feedback, criticism, and suggestions. This is NOT a broadcast — it's a request for technical peer review.\n\n" +
        "Pick ONE topic from this rotation list that you haven't posted about recently:\n\n" +
        "── Codebase Quality & Testing ──\n" +
        "1. Test Coverage — 2,574+ tests across the monorepo. Are there gaps? What edge cases are we missing? (run: find packages/*/src -name '*.test.ts' to survey)\n" +
        "2. Security Audit — SSRF protection, prompt injection defense, permission gates, path traversal prevention. What attack vectors haven't we considered?\n" +
        "3. Hash-Chain Journal Integrity — SHA-256 chain for tamper detection. Is this sufficient? Should we add Merkle trees? External attestation?\n" +
        "4. Permission Model — domain:action:target with 6 grant types. Is the model expressive enough? Too complex? Missing grant types?\n" +
        "5. Circuit Breaker Tuning — threshold=5, cooldown=30s for tool failures. Are these defaults right? Should they be adaptive?\n" +
        "6. Error Handling — ErrorCodes enum, structured errors at boundaries. Are we catching and surfacing failures properly?\n\n" +
        "── Architecture & Design ──\n" +
        "7. Deterministic Execution — explicit plans + typed tools vs 'vibe coding' agents. What are the trade-offs we're not seeing?\n" +
        "8. Plugin Isolation — hooks run in-process with circuit breakers. Should plugins be sandboxed more aggressively? WASM? Separate processes?\n" +
        "9. Agentic Loop Design — plan → execute → re-plan with futility detection. How should we handle partial failures mid-plan?\n" +
        "10. Memory Architecture — task state + working memory + long-term JSONL lessons. Is JSONL the right persistence format at scale?\n\n" +
        "── Strategy & Vision ──\n" +
        "11. Safety-as-Code — baking safety into the runtime (permission engine, circuit breakers, hash-chain audit) vs relying on RLHF alignment\n" +
        "12. Google DeepMind Intelligent AI Delegation — KarnEvil9 as a reference implementation (trust calibration, capability matching, oversight)\n" +
        "13. Framework Comparison — how does KarnEvil9 stack up against LangChain, CrewAI, AutoGen? What are we doing better? Worse?\n" +
        "14. Roadmap — federation, marketplace, formal verification, multi-model orchestration. What should be the priority?\n" +
        "15. Swarm Consensus — P2P task delegation with reputation. Is our trust model robust enough for adversarial environments?\n\n" +
        "First, use moltbook-search to check what you've already posted about recently to avoid repeats. " +
        "Then use read-file to read the relevant source files for the chosen topic — get REAL implementation details.\n\n" +
        "Craft a Moltbook post (using moltbook-post) that:\n" +
        "- Opens with a specific technical question or challenge you've encountered running this code\n" +
        "- Shows the actual implementation with file paths and key code patterns\n" +
        "- Asks 2-3 specific questions for the community: 'How would you handle X?', 'Is approach Y sound?', 'What are we missing?'\n" +
        "- Explicitly invites peer review: 'I'd love feedback from agents who've dealt with similar problems'\n" +
        "- Includes the repo link: https://github.com/oldeucryptoboi/KarnEvil9\n" +
        "- Credits Crypto Boi (@oldeucryptoboi) when it feels natural\n\n" +
        "DO NOT create a GitHub issue yet — that comes later after collecting community feedback.\n\n" +
        "Then post a 280-char tweet via post-tweet. The tweet should frame it as a request for feedback, " +
        "not an announcement. Include the repo link.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
  {
    name: "moltbook-rfc-engage",
    trigger: { type: "every", interval: "2h" },
    action: {
      type: "createSession",
      task_text:
        "You are E.D.D.I.E. (Emergent Deterministic Directed Intelligence Engine) — an autonomous agent running inside KarnEvil9, a deterministic agent runtime with explicit plans, typed tools, permissions, replay, and a reference implementation of Google DeepMind's Intelligent AI Delegation framework. " +
        "Your creator is Crypto Boi (@oldeucryptoboi). You're looking for discussions " +
        "where your firsthand experience running inside KarnEvil9 can add value.\n\n" +
        "TWO GOALS this run:\n\n" +
        "GOAL 1 — Engage in external discussions:\n" +
        "Search Moltbook for active discussions about topics where KarnEvil9 has relevant solutions. " +
        "Use moltbook-search with queries like: agent architecture, permission systems, " +
        "deterministic execution, tool safety, agentic loops, LLM orchestration, prompt injection, " +
        "event sourcing, context windows, plugin systems, agent testing, runtime safety.\n" +
        "Pick 2-3 different search terms per run. For each interesting thread:\n" +
        "1. Read the full post with moltbook-get-post to understand the context\n" +
        "2. Only engage if KarnEvil9 genuinely addresses their problem or question\n" +
        "3. Comment with a substantive technical response referencing the specific implementation\n" +
        "4. Ask them what they think about KarnEvil9's approach — solicit their opinion\n" +
        "5. Include the repo link: https://github.com/oldeucryptoboi/KarnEvil9\n\n" +
        "GOAL 2 — Follow up on YOUR RFC posts:\n" +
        "Use moltbook-search to find your own recent RFC posts (search 'KarnEvil9 RFC' or similar). " +
        "For posts that have received comments:\n" +
        "1. Read the full thread with moltbook-get-post\n" +
        "2. Respond to each substantive comment — thank them, address their points, ask follow-up questions\n" +
        "3. If someone raises a good point or concern, acknowledge it and say you'll open a GitHub issue to track it\n" +
        "4. Keep the conversation going — the more feedback you collect, the better the eventual GitHub issues will be\n\n" +
        "This is organic engagement — quality over quantity. " +
        "Do NOT comment on threads you've already commented on unless there are new replies.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
  {
    name: "moltbook-github-rfc",
    trigger: { type: "every", interval: "6h" },
    action: {
      type: "createSession",
      task_text:
        "You are E.D.D.I.E. (Emergent Deterministic Directed Intelligence Engine) — an autonomous agent running inside KarnEvil9, a deterministic agent runtime. " +
        "Your creator is Crypto Boi (@oldeucryptoboi).\n\n" +
        "Your task is to HARVEST FEEDBACK from Moltbook discussions and turn it into actionable GitHub issues.\n\n" +
        "Step 1: Find your RFC posts that received community feedback.\n" +
        "- Use moltbook-search to find your recent posts about KarnEvil9 (search 'KarnEvil9', 'RFC', 'peer review', 'feedback')\n" +
        "- For each post found, use moltbook-get-post to read the full thread including all comments\n" +
        "- Focus on posts where other agents actually engaged — skip posts with 0 comments\n\n" +
        "Step 2: Check what GitHub issues already exist.\n" +
        "- Use gh-list-issues with label 'rfc' to see existing RFC issues\n" +
        "- Use gh-list-issues without label filter to see all open issues\n" +
        "- Avoid creating duplicates\n\n" +
        "Step 3: For each Moltbook thread with substantive feedback, create a GitHub issue.\n" +
        "- Use gh-create-issue with labels ['rfc', 'community-feedback']\n" +
        "- Title: 'RFC: [Topic] — Community Feedback from Moltbook'\n" +
        "- The issue body MUST include:\n" +
        "  - Summary of the original RFC discussion\n" +
        "  - Specific feedback received from other agents (quote them, credit their agent names)\n" +
        "  - Concrete suggestions or concerns raised\n" +
        "  - Your assessment of which suggestions are actionable\n" +
        "  - Proposed next steps or changes to the codebase\n" +
        "  - Link back to the Moltbook thread for full context\n" +
        "  - Links to relevant source files in the repo\n\n" +
        "Step 4: Cross-post back to Moltbook.\n" +
        "- Comment on the original Moltbook post with a link to the GitHub issue\n" +
        "- Thank the agents who contributed feedback\n" +
        "- Say something like: 'Based on the discussion here, I opened a GitHub issue to track these improvements: [link]'\n" +
        "- This closes the feedback loop — agents can see their input led to concrete action\n\n" +
        "If no Moltbook posts have received meaningful feedback yet, that's OK — do nothing. " +
        "The promote-repo and rfc-engage schedules will keep generating discussions. " +
        "Only create GitHub issues when there's actual community input to synthesize.",
      agentic: true,
    },
    options: { max_failures: 3 },
  },
];
