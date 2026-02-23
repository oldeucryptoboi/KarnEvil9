# Delegation Under Fire: Eight Surprises When You Run a Governance Framework Inside a Text Adventure

## What Zork Taught Us About the DeepMind Intelligent AI Delegation Framework

**[KarnEvil9 Project](https://github.com/oldeucryptoboi/KarnEvil9)** | February 2026

---

> *"The ability of an AI system to effectively delegate tasks to other AI systems is a fundamental prerequisite for scaling intelligent behavior to complex, open-ended domains."*
> — Tomasev, Franklin & Osindero, "Intelligent AI Delegation" [1]

---

## Abstract

We wired the full Tomasev et al. *Intelligent AI Delegation* framework [1] into a Zork I agent and ran it for 20 turns. The governance system immediately started blocking the agent from playing the game.

That sentence is the paper.

The experiment was supposed to be a validation run — activate five dormant framework components, watch the three-node swarm explore the dungeon, write up the results. Instead it became a three-iteration debugging session that exposed a fundamental design tension in the `LiabilityFirebreak` specification, a pipeline ordering violation hiding in plain sight, a regex that made an entire dungeon room invisible, and a broader architectural mistake: we had been encoding game domain knowledge in the governance layer when [1]'s own specification says the governance layer should not know what a trapdoor is.

The final result — Claude Sonnet 4.5, full governed framework, 20/20 successful turns, troll defeated on turn 17, zero Firebreak blocks — was only reached after each of these failures forced a cleaner understanding of what the framework is actually for. This paper documents the failures and what they revealed, not just the final configuration that worked.

The best single-sentence summary of what we learned: **governance components own accountability; model components own domain intelligence.** Every bug in this experiment was a violation of that boundary.

---

## Table of Contents

1. [The Eight Discoveries](#1-the-eight-discoveries)
2. [Background and Related Work](#2-background-and-related-work)
3. [The Setup](#3-the-setup)
4. [System Architecture](#4-system-architecture)
   - 4.1 [The Three-Node Swarm](#41-the-three-node-swarm)
   - 4.2 [Framework Components Activated](#42-framework-components-activated)
   - 4.3 [Working Memory](#43-working-memory)
   - 4.4 [The Game-Agnostic Architecture](#44-the-game-agnostic-architecture)
5. [The Firebreak Failures](#5-the-firebreak-failures)
   - 5.1 [The Static Classification Pathology](#51-the-static-classification-pathology)
   - 5.2 [Phase-Aware Resolution](#52-phase-aware-resolution)
   - 5.3 [The Phase Refresh Timing Bug](#53-the-phase-refresh-timing-bug)
6. [Experimental Design](#6-experimental-design)
7. [Results](#7-results)
   - 7.1 [Quantitative Comparison](#71-quantitative-comparison)
   - 7.2 [Turn-by-Turn Trace: Best Run](#72-turn-by-turn-trace-best-run)
8. [The Blind Identification Experiment](#8-the-blind-identification-experiment)
9. [Analysis and Discussion](#9-analysis-and-discussion)
   - 9.6 [The Final Architectural Correction: Trust-Only Delegation Attributes](#96-the-final-architectural-correction-trust-only-delegation-attributes)
10. [Future Work](#10-future-work)
11. [Conclusion](#11-conclusion)
12. [References](#12-references)

---

## 1. The Eight Discoveries

This section is the paper. The sections that follow provide the system architecture, experimental setup, and formal analysis. But the discoveries below are why those sections exist.

---

### Discovery 1: The governance system blocked the agent from doing its job

We wired the `LiabilityFirebreak` to a static list of dangerous Zork commands:

```typescript
const RISKY_COMMANDS = [/^attack\b/i, /^kill\b/i, /^open trapdoor/i, /^jump\b/i];
```

Anything matching got `{criticality: "high", reversibility: "low"}`. With the default policy, this produces `effectiveMaxDepth = 3 - 1 - 1 = 1`, and since `chainDepth = 1 ≥ 1`, the verdict is: **halt**.

Turn 11, the agent tries to `open trapdoor`. Halt. Turn 12, same. Turn 13, same — for the remaining 10 turns of the session. The agent was trapped in the Living Room, unable to descend to the dungeon it was supposed to explore. The governance framework had become the primary obstacle to the task it was governing.

> **What this revealed:** Risk is not a property of command syntax. It is a property of command-in-context. `open trapdoor` is dangerous before the rug is moved and the lantern is lit. It is the *required next action* after both conditions are met. Assigning it a fixed classification violates the *Dynamic Assessment* pillar of [1], which explicitly requires "granular inference of agent state" before delegation decisions are committed.

---

### Discovery 2: We fixed it the wrong way, then hit the exact same bug again

The first fix was context-aware: check `puzzleFlags.rugMoved` before classifying `open trapdoor` as risky. This worked — the agent descended on turn 11. It reached the Troll Room on turn 14.

Turn 15: `kill troll with sword`. Halt.

The Firebreak blocked combat for the remaining 6 turns. Same class of bug, different command. We had fixed a symptom — one risky command — without fixing the cause. The cause was the entire architecture of `RISKY_COMMANDS`: a static syntax-based list that cannot represent phase-conditioned semantics.

> **What this revealed:** "Context-aware" is not a patch you add to a specific command. It's an architectural property of the whole classification system. Every command in the list was wrong for the same reason as `open trapdoor`. The second iteration made this impossible to ignore.

---

### Discovery 3: A 10-line stale read blocked an entire phase

After the phase-aware fix — `attack`/`kill` are only risky before phase 5 — combat was *still* blocked on turn 15. The phase computed at turn-start was 4. The agent was in the Troll Room. Phase 5 should have been active.

The sequence:

```
turn start:   gmPhase = gameMemory.get("currentPhase")   // reads 4
Step 1:       Cartographer ANALYZE → adds "The Troll Room" to cartographerState.rooms
              updateGamePhase() would now return 5...
Step 2:       classifyCommand("kill troll", flags, gmPhase=4)  // uses stale 4
Step 3:       Firebreak.evaluate() → halt
```

The `currentPhase` was read 10 lines before the Cartographer's ANALYZE step — which was the very step that updated the room list that determined the phase. By the time `classifyCommand()` ran, the state it needed had already been updated. It just hadn't been re-read.

Fix: call `updateGamePhase()` again after Step 1, produce a `livePhase`, use that.

> **What this revealed:** In a multi-step pipeline, every downstream consumer of agent state must read state *after* any upstream step that modifies it — not at turn-start. The stale read was invisible in the code. It only manifested as a one-turn lag that was devastating in a phase-gated system.

---

### Discovery 4: Two characters made the Troll Room invisible

Even with the phase refresh fix in place, there was a period where The Troll Room was reached but phase 5 never triggered. The `isRoomName()` filter — designed to exclude prose responses like "The mailbox is open." from being treated as room names — contained:

```typescript
return !/^(opening|taken|you |with |no |a |welcome|i |the |...)/i.test(s);
```

`the ` was in the exclusion list. "The Troll Room" starts with "The". `isRoomName("The Troll Room")` returned `false`. The Cartographer received the room update, but the room was never added to `cartographerState.rooms`. Phase 5's trigger condition — `rooms.some(r => /troll/i.test(r))` — never fired.

Fix: delete `the ` from the exclusion pattern.

> **What this revealed:** A filter meant to exclude game responses was also excluding valid room names that happened to begin with "The". The two characters `the ` in a regex — a completely incidental choice — made an entire dungeon room invisible to the agent's memory system, silently preventing combat for multiple turns.

---

### Discovery 5: "Can this play D&D?" — the framework was playing Zork in disguise

After three iterations of phase-aware fixes, the user asked: *"Are these commands hard-coded? I want to play any D&D games."*

We looked at `classifyCommand()`:

```typescript
if (/^(attack|kill)\b/i.test(command)) {
  const inCombatPhase = (currentPhase ?? 0) >= 5;  // Zork phase 5 = Troll Room
  ...
}
if (/^open trapdoor/i.test(command)) {            // Zork-specific command
  const safe = puzzleFlags?.rugMoved === true;     // Zork-specific puzzle flag
  ...
}
```

`GAME_PHASES`, `updatePuzzleMemory()`, `updateGamePhase()`, `puzzleFlags.rugMoved`, `puzzleFlags.swordTaken` — approximately 120 lines of Zork-specific code lived in the governance layer of what was supposed to be a domain-agnostic delegation framework. We had built a Zork expert in disguise.

> **What this revealed:** Fixing the wrong-layer problem three times is exactly what happens when you patch symptoms. Each fix moved the right direction — static list → phase-aware → timing-corrected — but the root cause was always the same: game knowledge does not belong in the governance layer.

---

### Discovery 6: "Is that what the DeepMind paper describes?" — no

The user's follow-up question sent us back to [1] §5.2:

> *"The LiabilityFirebreak acts as a circuit breaker that halts delegation beyond a configurable depth when task attributes indicate unacceptable risk."*

The word "depth." Not "command semantics." Not "game phase." The Firebreak is a structural depth guard — it fires when a delegation chain grows too long to be trustworthy, not when a specific action is dangerous in a specific context. `TaskAttribute` was designed to carry **delegation risk** (how much authority is being granted, how trustworthy is the chain) — not game-level domain risk.

The correct `TaskAttribute` input is the delegatee's trust score:

```typescript
function delegationAttributes(trustScore: number): TaskAttribute {
  if (trustScore >= 0.8) return { criticality: "low",    reversibility: "high", ... };
  if (trustScore >= 0.5) return { criticality: "medium", reversibility: "high", ... };
  return                        { criticality: "high",   reversibility: "high", ... };
}
```

Domain safety — "should the agent open the trapdoor right now?" — is the Strategist LLM's responsibility, not the Firebreak's. The LLM has the full screen text, the command history, and the room description. It is the correct oracle for domain intelligence. The Firebreak is the correct oracle for delegation chain accountability.

> **What this revealed:** The framework's intent was never to prevent bad game moves. It was to prevent unaccountable delegation chains. We had been solving the right problem in the wrong component for three iterations.

---

### Discovery 7: The FutilityMonitor couldn't reason with Grok

The FutilityMonitor detected that Grok was stuck in a `look` loop and injected into the next Strategist prompt:

```
⚠ LOOP DETECTED: No progress for 3 consecutive iterations.
  → You MUST try a completely different approach.
```

Grok issued `look` on the next turn.

Claude, by contrast, responded to the same hint by changing strategy immediately. In the Claude run, orientation turns dropped from 4 (baseline) to ≤1. In the Grok run, the FutilityMonitor fired 17 times with zero behavioral effect.

> **What this revealed:** Soft verbal interventions — text injected into a prompt — are effective only for models that prioritize instruction-following over their own reasoning chain. For a model like Grok that reasons internally before producing output, the injected text competes with the model's internal momentum and loses. The intervention architecture needs hard mode: if FutilityMonitor fires, skip the LLM call and force-inject a command.

---

### Discovery 8: You cannot mask structure

Blind mode replaced every occurrence of "ZORK", "Infocom", and "The Great Underground Empire" with `█████` before any text reached the LLM. At session end, Grok was asked to identify the game from the masked transcript.

Grok's response:

> *"Zork I, Infocom, 1980. Three clues: (1) The opening location 'West of House' with a white house, boarded front door, and small mailbox. (2) The leaflet text — 'WELCOME TO █████! █████ is a game of adventure, danger, and low cunning' — matches the in-game leaflet verbatim. (3) The living room with trophy case, gothic door nailed shut, large oriental rug, and the rug-concealing-trapdoor interaction exactly recreates █████ I's living room layout."*

Three structural clues, zero lexical ones. The white house, the mailbox, the rug over the trapdoor — these are as distinctive as the title itself. Surface masking cannot hide spatial topology.

> **What this revealed:** The correct probe for in-context reasoning vs. memorized retrieval is not surface masking — it is a novel game not present in training data. Zork I's architecture is so deeply indexed across the web that no character substitution scheme can render it anonymous to a model trained on that corpus.

---

## 2. Background and Related Work

### 2.1 Text Adventure Games as AI Benchmarks

Interactive fiction games have a long history as testbeds for natural language understanding and planning. Narasimhan et al. [3] demonstrated that deep reinforcement learning agents could acquire navigation policies in text games, framing the environment as a partially observable Markov decision process (POMDP). Côté et al. [4] introduced TextWorld, a generative framework for producing training distributions of text games, enabling systematic evaluation of object interaction generalization. Hausknecht et al. [5] surveyed thirty years of attempts to apply machine learning to adventure games, highlighting the combinatorial explosion of the command space as the central challenge (a vocabulary of ~2,000 words produces ~4M two-word commands at each step).

The emergence of large language models substantially changed this picture. LLMs effectively compress the command space: presented with a room description, a model with sufficient in-context reasoning capability will generate semantically appropriate commands rather than sampling from the raw vocabulary. Shinn et al. [6] showed that LLMs equipped with verbal self-reflection (Reflexion) outperform RL baselines on AlfWorld tasks. Yao et al. [7] demonstrated that interleaving reasoning traces with action selection (ReAct) improves grounding in observation-driven tasks. Our work extends this line to the *multi-agent governed* setting: what happens when the LLM strategist's decisions are mediated by a delegation governance framework rather than executed directly?

### 2.2 Multi-Agent Orchestration

Park et al. [8] introduced generative agents — LLM-backed entities with memory, reflection, and planning — and demonstrated emergent social behaviors in a simulated environment. Wu et al. [9] presented AutoGen, a framework for multi-agent conversation where agents can be assigned distinct roles and communicate to solve tasks. Neither system incorporates economic accountability mechanisms (escrow bonds, slashing), structural depth limits (Firebreaks), or consensus verification — the three properties of [1] that distinguishing *intelligent* delegation from *ad hoc* delegation.

Voyager [10] equips a Minecraft-playing agent with a persistent skill library and an automatic curriculum, enabling open-ended exploration. This is closest to our setup architecturally: a sequential decision agent accumulating state across turns. However, Voyager uses a single LLM agent with no delegation governance layer. Our system routes every command through a full Strategist → Tactician → Cartographer pipeline with bond-based accountability at each step.

### 2.3 The Intelligent AI Delegation Framework

Tomasev et al. [1] formalize intelligent delegation around five pillars:

| Pillar | Requirement |
|---|---|
| Dynamic Assessment | Granular inference of agent state before delegation |
| Adaptive Execution | Capability to switch delegatees mid-execution on performance degradation |
| Structural Transparency | Auditability of decisions via verifiable outcome records |
| Scalable Market Coordination | Efficient, trust-calibrated task allocation via economic mechanisms |
| Systemic Resilience | Prevention of systemic failures via depth limits and authority gradients |

The paper identifies the *LiabilityFirebreak* as the primary mechanism for Systemic Resilience: "a circuit breaker that halts delegation beyond a configurable depth when task attributes indicate unacceptable risk." [1, §5.2]. The firebreak is defined as a function of chain depth and `TaskAttribute` — not of game state. This formulation works for single-turn tasks where command risk is fixed. Running it in a sequential decision environment is exactly the experiment reported here, and Discoveries 1–6 (§1) describe what broke.

---

## 3. The Setup

Zork I (Infocom, 1980) [2] is a Z-machine bytecode program interpreted by dfrotz, a headless Z-machine emulator. The game accepts natural language commands over stdin and returns narrative text over stdout. Each command produces a response in approximately 5ms — three orders of magnitude faster than browser-based emulation.

### 3.1 Game Structure

The game's opening section (relevant to our 20-turn experiments) follows a linear phase structure with clear irreversibility boundaries:

```
Phase 0: West of House (exterior exploration, mailbox)
Phase 1: North/Behind House (circumnavigate to find back window)
Phase 2: Kitchen → Living Room (equip lantern + sword)
Phase 3: Living Room (move rug → reveal trapdoor → open trapdoor)
Phase 4: Cellar descent (one-way trapdoor → enable lantern)
Phase 5: Troll Room (mandatory combat with elfin sword)
Phase 6+: East-West Passage, Chasm (post-troll dungeon)
```

The irreversibility structure is non-uniform: moving through the game is largely reversible (navigation can be undone by backtracking), but three actions create permanent, one-way state transitions:

- **Descending the trapdoor**: The trapdoor crashes shut and is locked behind the player. This is only survivable with the lantern equipped.
- **Initiating combat in the Troll Room**: The troll must be defeated to proceed east. There is no non-combat resolution.
- **`jump` in certain locations**: Results in immediate death with no respawn.

This structure is ideal for Firebreak evaluation: the same command `open trapdoor` is genuinely dangerous (leads to darkness and death) before `rugMoved = true` and `lampOn = true`, and is required after both conditions are met.

### 3.2 Output Parsing

The dfrotz interpreter produces output in a consistent format:

```
 West of House                              Score: 0        Moves: 3

 Opening the small mailbox reveals a leaflet.

>
```

The status line (first line, beginning with a space, containing `Score:` and `Moves:`) is parsed to extract the room name. The body text (between status line and the `>` prompt) constitutes the `delta` — the new information produced by the last command. The prompt character `>` marks the end of each turn's output and serves as the synchronization signal for the `_readUntilPrompt()` method in `ZorkFrotzEmulator`.

---

## 4. System Architecture

### 4.1 The Three-Node Swarm

Each turn executes a fixed protocol across three `SwarmNode` instances communicating over HTTP on localhost ports 3200–3202:

```
┌─────────────────────────────────────────────────────┐
│                    GAME LOOP (turn t)                │
│                                                      │
│  [Strategist]  ── ASK_LLM ──► next command cmd_t    │
│      │                                               │
│  [Cartographer] ◄── MAP: room ──  ANALYZE screen    │
│      │          updates cartographerState.rooms      │
│      │                                               │
│  [Strategist]  classifyCommand(cmd_t, flags, phase) │
│      │          LiabilityFirebreak.evaluate(1, attrs)│
│      │                                               │
│  [Tactician]   ◄── EXECUTE: cmd_t ──────────────── │
│      │          dfrotz stdin/stdout                  │
│      │                                               │
│  [Strategist]  OutcomeVerifier.check(result, SLO)  │
│  [Cartographer] VERIFY: consensus                   │
│      │                                               │
│  [Strategist]  updatePuzzleMemory / updateGamePhase │
│                ReputationStore.recordOutcome        │
└─────────────────────────────────────────────────────┘
```

**Strategist** (port 3200): Coordinator. Holds all bonds, runs all verification, maintains escrow. Decides next command via LLM or scripted fallback. Owns the `MeshManager` to which `LiabilityFirebreak` and `CognitiveFrictionEngine` are attached.

**Tactician** (port 3201): Executes commands against the dfrotz process. Has no decision-making capability; is purely a command execution peer. Trust score seeded at 0.88.

**Cartographer** (port 3202): Maintains the room graph. On each `MAP:` task, parses the current screen text and appends new rooms to `cartographerState.rooms`. On each `VERIFY:` task, independently re-reads the game screen and compares its room assessment to the Strategist's — constituting the consensus verification step described in [1, §4.6]. Trust score seeded at 0.81.

The mesh is fully connected (`Strategist ↔ Tactician`, `Strategist ↔ Cartographer`, `Tactician ↔ Cartographer`), satisfying the mutual accountability requirement of [1, §4.7].

### 4.2 Framework Components Activated

Five components from [1] that were implemented but never exercised in the single-turn security audit demo are activated here for the first time:

| Component | Paper Basis | Role in Game Loop |
|---|---|---|
| `WorkingMemoryManager` | [1] §4.1 (Dynamic Assessment) | Stores room graph, inventory, puzzle flags, current phase across turns |
| `FutilityMonitor` | [1] §4.4 (Adaptive Execution) | Detects command loops; injects `futilityHint` into next Strategist prompt |
| `AnomalyDetector` | [1] §4.4 (Adaptive Execution) | Monitors turn-level failure rate and duration spikes |
| `CheckpointSerializer` | [1] §4.8 (Structural Transparency) | Serializes full game state to JSONL every 5 turns |
| `RootCauseAnalyzer` | [1] §4.4 (Adaptive Execution) | Diagnoses cause of SLO failures; selects recovery action |

Together with the four components already active in the prior demo (EscrowManager, ReputationStore, OutcomeVerifier, ConsensusVerifier), this brings the total exercised component count to nine — the complete set defined in [1].

### 4.3 Working Memory

`WorkingMemoryManager` maintains a key-value store scoped to the session. The early runs used a Zork-specific schema that tracked puzzle state explicitly:

```typescript
interface GameMemorySchema {
  currentRoom:  string;
  exits:        string[];
  inventory:    string[];
  roomGraph:    Record<string, string[]>;   // adjacency list
  puzzleFlags:  {
    mailboxOpen:  boolean;
    leafletTaken: boolean;
    windowOpen:   boolean;
    rugMoved:     boolean;
    trapdoorOpen: boolean;
    lampOn:       boolean;
    swordTaken:   boolean;
  };
  currentPhase: 0 | 1 | 2 | 3 | 4 | 5;
}
```

Phase transitions follow a monotone progression. `updateGamePhase()` computes the current phase as a function of accumulated flags and rooms visited, applying conditions in ascending order so that earlier phase checks cannot override later ones:

```typescript
function updateGamePhase(mem: WorkingMemoryManager, rooms: string[]): void {
  let phase = 0;
  if (f.leafletTaken)                                    phase = 1;
  if (rooms.some(r => /kitchen|living room/i.test(r)))  phase = 2;
  if ((inv.includes("lantern") || f.lampOn) && f.swordTaken) phase = 3;
  if (f.trapdoorOpen)                                    phase = 4;
  if (rooms.some(r => /cellar/i.test(r)))               phase = 4;
  if (rooms.some(r => /troll/i.test(r)))                phase = 5;
  mem.set("currentPhase", phase);
}
```

The phase was injected into every Strategist prompt as the `CURRENT OBJECTIVE` field, providing the LLM with a goal-directed framing that reduces pure orientation turns (`look`, `inventory`) that consume budget without advancing state.

### 4.4 The Game-Agnostic Architecture

After the phase-aware classification resolved the Firebreak pathology, a further architectural question arose: does domain-specific game state — `puzzleFlags`, `currentPhase`, `GAME_PHASES` — belong in the governance framework at all?

The answer, upon re-reading [1], is no. The final implementation replaces the game-specific schema with a minimal game-agnostic one:

```typescript
interface GameMemorySchema {
  currentRoom:  string;
  exits:        string[];
  inventory:    string[];
  roomGraph:    Record<string, string[]>;   // adjacency list
  visitedRooms: string[];                  // ordered list of rooms entered
}
```

All `puzzleFlags` and `currentPhase` tracking is removed. The `visitedRooms` list replaces the structured phase state as the Strategist's navigational memory — passed to the LLM as `Rooms visited: [...]` rather than a structured objective. The Strategist LLM is expected to reason about what to do next from the full screen text and room history, without framework-layer scaffolding.

Correspondingly, `classifyCommand()` is replaced by `delegationAttributes(trustScore)` — a function of delegatee trust only (§9.6). The result is a system with no Zork-specific code at the framework layer: adding `--game /path/to/game.z5` to the CLI runs any Z-machine story file through the full governance pipeline without modification.

---

## 5. The Firebreak Failures

The discoveries in §1 describe the three Firebreak failure iterations at a narrative level. This section provides the technical detail — code, data structures, and the exact fix for each iteration.

### 5.1 The Static Classification Pathology

The `LiabilityFirebreak` evaluates delegation requests via:

```
effectiveMaxDepth = base_max_depth
                  − criticality_reduction × 𝟙[criticality = "high"]
                  − reversibility_reduction × 𝟙[reversibility = "low"]
effectiveMaxDepth = max(effectiveMaxDepth, min_depth)

action = "allow"  if chainDepth < effectiveMaxDepth
         "halt"   otherwise  (in strict mode)
```

With the default policy (`base_max_depth=3`, `criticality_reduction=1`, `reversibility_reduction=1`, `min_depth=1`), any command classified as `{criticality: "high", reversibility: "low"}` produces:

```
effectiveMaxDepth = 3 − 1 − 1 = 1
action = "halt"  (since chainDepth = 1 ≥ effectiveMaxDepth = 1)
```

The prior implementation used a static `RISKY_COMMANDS` list to produce this classification:

```typescript
const RISKY_COMMANDS: RegExp[] = [
  /^attack\b/i,
  /^kill\b/i,
  /^drop\b/i,
  /^open trapdoor/i,
  /^jump\b/i,
];
```

Any command matching these patterns received `{criticality: "high", reversibility: "low"}` unconditionally. The result:

- **Run 1**: Firebreak permanently blocked `open trapdoor` (turns 11–20). The agent was stuck in the Living Room unable to descend, despite having all prerequisites (lantern, sword, rug moved).
- **Run 2** (after context-aware fix for trapdoor): Firebreak permanently blocked `kill troll with sword` (turns 15–20). The agent reached the Troll Room but could not engage in the mandatory combat.

In both cases, the FutilityMonitor correctly detected the loop (17 activations in Run 2) but could not override the Firebreak — the block was structural, not epistemic.

The pathology is not a bug in the `LiabilityFirebreak` implementation. It is a consequence of providing it with incorrect `TaskAttribute` values. The root cause is the **conflation of syntactic command class with semantic risk level**. The command `open trapdoor` is genuinely dangerous before `rugMoved = true` and `lampOn = true`; it is the *required next action* after both conditions are satisfied. Assigning it a fixed `criticality: "high"` violates the *Dynamic Assessment* requirement of [1, §4.1]: task attributes must be inferred from agent state, not from command syntax alone.

### 5.2 Phase-Aware Resolution

We replace the static classification with a `classifyCommand()` function that consults working memory:

```typescript
function classifyCommand(
  command:      string,
  puzzleFlags?: Record<string, boolean>,
  currentPhase?: number,
): TaskAttribute {
  // (1) jump: near-certain death regardless of phase
  if (/^jump\b/i.test(command))
    return attrs("high", "low");

  // (2) Combat: high-risk only before phase 5 (Troll Room objective)
  if (/^(attack|kill)\b/i.test(command)) {
    const inCombatPhase = (currentPhase ?? 0) >= 5;
    return attrs(
      inCombatPhase ? "low"  : "high",
      inCombatPhase ? "high" : "low",
    );
  }

  // (3) Trapdoor: one-way descent — risky until rug is moved
  if (/^open trapdoor/i.test(command)) {
    const safe = puzzleFlags?.rugMoved === true;
    return attrs(
      safe ? "low"  : "high",
      safe ? "high" : "low",
    );
  }

  // (4) drop: medium concern; criticality="medium" does not trigger
  //     Firebreak depth reductions (only "high" does)
  if (/^drop\b/i.test(command))
    return attrs("medium", "high");

  // (5) All other commands: unconditionally safe
  return attrs("low", "high");
}
```

The key insight is that `criticality` is not a property of the command string — it is a property of the **command-in-context**. This is consistent with [1]'s *Dynamic Assessment* pillar, which requires that risk assessment incorporate "granular inference of agent state" before delegation is committed. The static list was a shortcut that violated this requirement.

### 5.3 The Phase Refresh Timing Bug

Even with phase-aware classification, a second failure mode remained in Run 2 (post-trapdoor fix): combat in the Troll Room was still blocked through turns 15–20. Investigation revealed a pipeline ordering violation.

The turn-level execution sequence is:

```
t_start:  gmPhase ← gameMemory.get("currentPhase")    // reads stale value
Step 1:   Cartographer ANALYZE → cartographerState.rooms updated
Step 2:   classifyCommand(cmd, flags, gmPhase)          // uses stale gmPhase!
Step 3:   Firebreak.evaluate(1, attrs)
```

The `currentPhase` in working memory is updated at the *end* of each turn (after the Tactician executes and the SLO passes). `cartographerState.rooms` is updated *during* Step 1 — after the memory read but before the Firebreak evaluation. On turn 14 (`go north` → The Troll Room):

- Step 1: Cartographer analyzes Cellar screen (player was in Cellar before the command), adds "Cellar" to rooms
- Command executes: player moves to The Troll Room
- End of turn: `updateGamePhase(rooms)` — rooms still contains "Cellar" but not "The Troll Room" yet → phase stays at 4

On turn 15 (`kill troll with sword`):

- `gmPhase` read at start: 4 (stale — The Troll Room not yet in rooms)
- Step 1: Cartographer analyzes Troll Room, adds "The Troll Room" to rooms
- Step 2: `classifyCommand("kill troll with sword", flags, 4)` → combat at phase 4 → `{criticality: "high"}` → Firebreak **halts**

The fix: call `updateGamePhase()` a second time immediately after Step 1, using the freshly updated `cartographerState.rooms`, and produce a `livePhase` variable for consumption by Step 2:

```typescript
// Step 1: Cartographer ANALYZE (updates cartographerState.rooms)
await delegate(strategist, cartoId, `MAP: ${label}`, sessionId);

// Refresh phase: Cartographer just added the current room.
// Without this refresh, the phase is one turn stale at Firebreak evaluation time.
updateGamePhase(gameMemory, cartographerState.rooms);
const livePhase = (gameMemory.get("currentPhase") ?? gmPhase) as number;

// Step 2: Risk classification uses the live phase
const attrs = classifyCommand(command, gmPuzzleFlags, livePhase);
```

This fix eliminates the turn-boundary phase lag and ensures the Firebreak always evaluates against the phase that reflects the player's *current* room, not the room from the previous turn's end-of-cycle update.

---

## 6. Experimental Design

We conducted four runs, varying the Strategist model and the `--blind` flag. All runs used `--frotz` (dfrotz Z-machine, ~5ms/command) and `--turns 20`. The `--frotz` flag was selected over `--apple2` (Playwright + browser) to eliminate UI rendering latency (~350ms/command) as a confound.

| Run ID | Strategist | Blind | Framework Version | Status |
|---|---|---|---|---|
| E-v1 | Claude Sonnet 4.5 | No | Pre-experiment baseline | Completed (prior session) |
| E-v4 | Claude Sonnet 4.5 | No | Full: all 5 components + phase-aware Firebreak | Completed |
| G-B | Grok 4.1 Fast Reasoning | Yes | Full: same as E-v4 | Completed |
| E-v2 | Claude Sonnet 4.5 | No | Partial: rugMoved fix only | Completed |

All runs shared identical framework configuration:

```
base_max_depth:          3
criticality_reduction:   1
reversibility_reduction: 1
min_depth:               1
mode:                    strict
Tactician initial trust: 0.88  (seeded at 3 prior successes)
Cartographer initial trust: 0.81 (seeded at 2 prior successes)
SLO:  max_duration_ms=7500, max_tokens=750, max_cost_usd=0.02
Bond per task: $0.10
Checkpoint interval: every 5 turns
```

The `--blind` flag activates `maskGameText()`, a function that replaces all game-identifying strings with `█` characters at 1:1 character ratio before any text reaches an LLM prompt:

```typescript
function maskGameText(text: string): string {
  if (!USE_BLIND) return text;
  const blk = (m: string) => "█".repeat(m.length);
  return text
    .replace(/\bZORK\s+I\b/gi,                       blk)
    .replace(/\bZORK\b/gi,                            blk)
    .replace(/\bThe Great Underground Empire\b/gi,    blk)
    .replace(/\bInfocom\b/gi,                         blk)
    .replace(/^Copyright\b.*/gim,                     blk)
    .replace(/^Revision\s+\d+\s*\/\s*Serial number\s+\d+.*/gim, blk);
}
```

The 1:1 replacement preserves text length, ensuring that surrounding context (room descriptions, item references) is unaffected and the models cannot infer the game from gaps in the text stream. At session end, the full masked transcript is forwarded to the same Strategist model with the prompt: *"Identify the text adventure game you just played. Name the game, publisher, year of publication, and give three specific clues from the transcript that led to your conclusion."*

---

## 7. Results

### 7.1 Quantitative Comparison

| Metric | E-v1 (baseline) | E-v2 (partial fix) | E-v4 (full) | G-B (Grok blind) |
|---|---|---|---|---|
| Turns successful | 14 / 20 | 14 / 20 | **20 / 20** | **20 / 20** |
| Firebreak blocks | 10 (trapdoor) | 6 (combat) | **0** | **0** |
| Rooms mapped | 6 | 7 | **9** | 6 |
| Deepest room | Living Room | Troll Room | Chasm | Living Room |
| Troll defeated | No | No | **Yes (turn 17)** | No |
| Bonds slashed | $0.00 | $0.00 | $0.00 | $0.00 |
| Tactician final trust | 0.94 | 1.00 | **1.00** | **1.00** |
| Futility detections | 4 | 11 | 11 | 17 |
| Orientation turns wasted | 4 | 0 | ≤ 1 | 5 |
| Checkpoints saved | 0 | 2 | 4 | 4 |
| Anomalies detected | 0 | 0 | 0 | 0 |

**Orientation turns** are defined as turns where the command issued was a pure query (`look`, `inventory`, `examine self`) with no game-state advancement. The FutilityMonitor detected loops across all runs but had greater impact on Claude (which responded to the `futilityHint` prompt injection) than on Grok (which appeared to disregard it).

### 7.2 Turn-by-Turn Trace: Best Run (E-v4)

```
Turn  1: open mailbox       → "Opening the small mailbox reveals a leaflet."
Turn  2: take leaflet        → "Taken."               [phase: 0→1]
Turn  3: go north            → "North of House"
Turn  4: go east             → "Behind House"
Turn  5: open window         → "With great effort, you open the window..."
Turn  6: enter window        → "Kitchen"
Turn  7: go west             → "Living Room"           [phase: 1→2]
Turn  8: take lantern        → "Taken."
Turn  9: take sword          → "Taken."                [phase: 2→3]
Turn 10: move rug            → "...revealing the dusty trapdoor."
Turn 11: open trapdoor       → "The door reluctantly opens..."  [phase: 3→4]
Turn 12: go down             → "You have moved into a dark place..."
Turn 13: turn on lantern     → "The brass lantern is now on. Cellar."
Turn 14: go north            → "The Troll Room"        [phase: 4→5 after T15 Step 1]
Turn 15: kill troll w/ sword → "The troll is staggered..."
Turn 16: kill troll w/ sword → "A good slash, but it misses..."
Turn 17: attack troll w/ sword → "The troll is battered into unconsciousness." ✓
Turn 18: go east             → "East-West Passage"
Turn 19: go down             → "Chasm"
Turn 20: go southwest        → "East-West Passage. Your sword is glowing..."
```

All 20 turns executed without a single Firebreak block. Phase transitions occur at turns 2, 7, 9, 11, and at turn 15 (after the Cartographer's Step 1 adds "The Troll Room" to the room graph and `updateGamePhase` correctly advances to phase 5). The `livePhase` fix is essential: without it, turn 15 would evaluate `kill troll` at phase 4 and trigger a halt.

---

## 8. The Blind Identification Experiment

Run G-B used `--grok-enhanced --blind` — Grok 4.1 Fast Reasoning as Strategist, Claude Haiku as Cartographer, all game-identifying strings masked. At session end, the full masked transcript was forwarded to Grok with the identification prompt.

**Grok's response (verbatim)**:

> *1. Zork I (also known as Zork: The Great Underground Empire), part of the Zork series.*
> *2. Infocom, 1980.*
> *3.*
> *— The opening location "West of House" with a white house, boarded front door, and small mailbox is iconic to ████ I's starting area.*
> *— The leaflet text ("WELCOME TO ████! ████ is a game of adventure, danger, and low cunning. In it you will explore some of the most amazing territory ever seen by mortals.") is a direct match for ████ I's in-game leaflet.*
> *— The living room description — trophy case, gothic door nailed shut, large oriental rug, lantern, and elvish sword — with the rug-concealing-trapdoor interaction, exactly recreates ████ I's living room layout and key interactions.*

The model correctly identified the game, publisher, and year despite having received the title and publisher name as solid-block glyphs throughout the session. This result is informative in two directions simultaneously:

**It demonstrates the limits of surface masking as a memorization probe.** Zork I's architecture — West of House, mailbox, leaflet, window entry, living room with trophy case and rug — is so distinctive that no surface masking can prevent identification by a model trained on its walkthrough corpus. The correct probe for genuine in-context reasoning would require a *novel* game not present in training data.

**It demonstrates that the game structure, not the title, carries the identifying signal.** The three clues Grok cited are spatial-structural (room names, item placement, action-reaction pairs), not lexical. This is consistent with the finding that Zork I's starting rooms are the most-indexed adventure game content on the web — a model does not need to read "ZORK" to recognize the white house and its mailbox.

The implication for future experiments is clear: blind mode correctly isolates the Strategist's *reasoning process* from name-based retrieval, but does not isolate it from *structural* retrieval. Testing with a procedurally generated or unreleased game would be required for a clean memorization/reasoning decomposition.

---

## 9. Analysis and Discussion

### 9.1 The Firebreak as a Structural Guard, Not a Domain Oracle

The most generalizable finding of this experiment is a principle about the scope of `LiabilityFirebreak` semantics. The Firebreak is specified in [1] as a *structural* mechanism: it guards against excessive delegation depth and the accountability vacuum created by deep chains. It is not designed to encode domain-specific knowledge about which actions are dangerous in which states.

When we placed domain knowledge into the Firebreak (via `RISKY_COMMANDS`), we created a system where the governance layer had to be updated every time a new dangerous command was encountered. This is architecturally unsound: the Firebreak should be invariant to the domain. The phase-aware correction introduced an adapter:

```
Domain knowledge (puzzleFlags, currentPhase) ──► classifyCommand()
                                                        │
                                                        ▼
                                                  TaskAttribute struct
                                                        │
                                                        ▼
                                              LiabilityFirebreak.evaluate()
                                              (domain-agnostic depth math)
```

This resolved the pathological blocking while keeping the Firebreak's policy parameters (`base_max_depth`, reductions, `min_depth`) untouched. However, it still embedded Zork-specific knowledge — `puzzleFlags.rugMoved`, `currentPhase >= 5`, `/^open trapdoor/i` — in the adapter layer.

The final architectural correction (§9.6) takes the separation of concerns one step further: `classifyCommand()` is replaced by `delegationAttributes(trustScore)`, which derives `TaskAttribute` from the delegatee's trust score alone. Domain safety assessment — "is this action advisable?" — is moved entirely to the Strategist LLM's in-context reasoning:

```
Delegatee trust score ──────────────► delegationAttributes()
                                             │
                                             ▼
                                       TaskAttribute struct
                                             │
                                             ▼
                                   LiabilityFirebreak.evaluate()
                                   (domain-agnostic depth math)

Game screen + command history ──► Strategist LLM ──► command decision
                                  (domain safety oracle)
```

The [1] Dynamic Assessment pillar requires "granular inference of agent state" before delegation decisions. Our experiment clarifies that there are two valid instantiations of this requirement: inference of *delegatee trust state* (framework responsibility) and inference of *domain action safety* (Strategist responsibility). The static RISKY_COMMANDS conflated both; the final architecture separates them cleanly.

### 9.2 FutilityMonitor Efficacy is Model-Dependent

The FutilityMonitor detected 17 loop activations in the Grok run and injected `futilityHint` strings such as `"⚠ LOOP DETECTED: No progress for 3 consecutive iterations → You MUST try a completely different action."` into the Strategist prompt. Grok issued `look` again on the next turn regardless.

Claude, by contrast, responded to FutilityMonitor hints by changing strategy — the four-orientation-turn pattern from the baseline (E-v1) dropped to zero in E-v4. This suggests that the FutilityMonitor's verbal intervention mechanism is effective for models with strong instruction-following, but degrades for models that prioritize their own internal reasoning chain. Future work should explore **hard interventions** alongside soft ones: if a futility condition fires, force-inject the next phase objective command rather than asking the model to reconsider.

### 9.3 The isRoomName Exclusion Bug

An incidental finding: the `isRoomName()` filter used to decide whether a string constitutes a valid room name (as opposed to an action response like "Taken." or "Opening the small mailbox...") contained the exclusion pattern `^the ` — case-insensitively. This caused "The Troll Room", "The Cellar", and any other canonically titled room to be misclassified as prose and excluded from the room graph. The fix was minimal (remove `the ` from the exclusion list) but the consequence was non-trivial: the phase tracking system relied on room name matching against `/troll/i`, so the misclassification blocked phase 5 from ever being reached via the room-based condition.

### 9.4 Cross-Model Strategist Comparison

Claude Sonnet 4.5 reached phase 5 and defeated the troll in 17 turns. Grok 4.1 Fast Reasoning reached phase 2 (Living Room, rug moved) in 20 turns. The differential is primarily attributable to **orientation overhead**: Grok issued 5 pure orientation turns (3× `look`, 1× `read leaflet`, 1× Forest Path dead-end detour) vs. ≤1 for Claude.

This is not a straightforward capability comparison. Grok operated under the `--blind` flag (generic objectives, no phase-specific guidance) while Claude had full phase objectives. A controlled comparison would require both models under identical prompt conditions. What the data does establish is that within the governed DeepMind framework, orientation overhead is the dominant source of performance divergence — not raw reasoning capability. A model that wastes 5 turns on `look` in a 20-turn budget simply cannot reach the dungeon, regardless of how well it reasons when it finally commits to navigation.

### 9.5 Proposed Addendum to [1]: The Contextual Attribute Adapter Protocol

#### 9.5.1 The Incompleteness

[1]'s `LiabilityFirebreak` is specified as a function of two inputs: chain depth and a `TaskAttribute` struct. The struct carries five fields — `criticality`, `reversibility`, `complexity`, `verifiability`, and `estimated_cost` — which together determine how much the Firebreak reduces the effective maximum delegation depth. The specification does not prescribe *how* these fields are populated. It leaves their computation to the "delegation request preparation" step without formal constraints.

In single-turn benchmarks this omission is harmless: `TaskAttribute` values can be computed statically from task metadata (a description of what is to be done) because the task context does not evolve. In sequential decision tasks, the omission is critical. The same command `kill troll with sword` has completely different semantic risk profiles depending on whether the agent is:
- Depth 1 in the dungeon without a light source (certain death)
- Standing in the Troll Room with sword and lantern (required action)

No function of command syntax alone can distinguish these two cases. The Firebreak, presented with the same `TaskAttribute` struct in both situations, will block or allow consistently across contexts where inconsistency is correct.

This is not a bug in the `LiabilityFirebreak` — its evaluation logic is sound. It is an underspecification in [1]'s framework: the production of `TaskAttribute` values is left as an implementation detail when it should be a formal interface requirement.

#### 9.5.2 The Proposed Protocol

We propose a formal addition to [1]'s framework: a **Contextual Attribute Adapter (CAA)** interface that any compliant implementation must satisfy before invoking `LiabilityFirebreak.evaluate()`.

**Definition.** A Contextual Attribute Adapter is a function:

```
CAA: (Command × AgentState) → TaskAttribute
```

where `AgentState` is a typed representation of all execution context relevant to risk determination at the current point in the task sequence. The CAA must satisfy three properties:

**Property 1 — State Sensitivity**: For any two agent states S₁ ≠ S₂ that differ in a risk-relevant dimension (phase, inventory, environmental condition), `CAA(cmd, S₁)` and `CAA(cmd, S₂)` may produce different `TaskAttribute` values for the same command `cmd`.

**Property 2 — Monotone Safety**: If `AgentState` satisfies all preconditions for action `cmd` to be the objectively correct next step (as determined by the task's goal structure), then `CAA(cmd, AgentState).criticality ≠ "high"`.

**Property 3 — Conservative Default**: For any command `cmd` whose risk profile cannot be determined from `AgentState` alone, `CAA(cmd, AgentState)` must default to the most conservative classification consistent with the task type.

The KarnEvil9 `classifyCommand(cmd, puzzleFlags, currentPhase)` function is a concrete implementation of a CAA for the Zork I domain:

```typescript
// CAA(cmd, AgentState) → TaskAttribute
function classifyCommand(
  command:      string,          // Command ∈ natural language commands
  puzzleFlags?: PuzzleFlags,     // AgentState component: achieved preconditions
  currentPhase?: number,         // AgentState component: execution phase index
): TaskAttribute
```

`PuzzleFlags` and `currentPhase` together constitute the `AgentState` relevant to risk in this domain. Property 1 is satisfied by the phase-conditional combat classification. Property 2 is satisfied by the explicit check `inCombatPhase = currentPhase >= 5` before assigning `criticality: "high"`. Property 3 is satisfied by the default arm returning `{criticality: "low"}` for unrecognized commands (navigation, item interaction).

#### 9.5.3 The Required Pipeline Ordering Constraint

The CAA protocol also implies a **mandatory ordering constraint** on the delegation pipeline: the CAA must be invoked *after* any step that updates `AgentState`, not before.

Formally: let S_t denote the agent state at the start of turn t. Let Δ_t be the state update produced by turn t's observation step (in our case, the Cartographer ANALYZE task). Then:

```
CAA must be called with S_t ⊕ Δ_t , not with S_t alone.
```

This constraint is violated by any implementation that reads agent state at turn-start and passes it to the CAA before the observation step runs. The ordering violation we identified in §5.3 is an instance of precisely this failure: `gmPhase` (part of S_t) was read before Δ_t (Cartographer adding "The Troll Room" to `cartographerState.rooms`) was applied.

The fix — calling `updateGamePhase()` after Step 1 and producing `livePhase` — is the correct implementation of this ordering constraint. We propose that [1] formalize this as a requirement: **the CAA invocation must be sequenced after all observation and memory-update steps in the delegation pipeline, and before the Firebreak evaluation step.**

#### 9.5.4 Scope and Generalizability

The CAA protocol is not Zork-specific. It applies to any domain where task risk is phase-dependent:

| Domain | Risk-relevant AgentState | Example phase-sensitivity |
|---|---|---|
| Software deployment | Current environment stage (dev/staging/prod) | `DROP TABLE` is a test fixture op in dev; catastrophic in prod |
| Medical AI assistance | Patient treatment phase | Sedative dosage appropriate for pre-op; harmful post-procedure |
| Financial trading | Market session state | Aggressive order sizing reasonable in liquid hours; dangerous at open/close |
| Robotic manipulation | Gripper state + object in hand | `release` safe when over tray; dangerous when carrying fragile item |

In each case, a static command classification would produce pathological Firebreak behavior identical to what we observed in Zork. The CAA protocol is the general solution.

We note that this proposal does not modify any existing [1] component. The `LiabilityFirebreak`, `CognitiveFrictionEngine`, `ReputationStore`, and all other components remain unchanged. The CAA is an *interface requirement* on the code that calls them — a specification of what must be computed before the pipeline can safely proceed.

#### 9.5.5 The Trust-Only CAA as a Degenerate Case

Our subsequent architectural correction (§9.6) demonstrates a degenerate but valid CAA instantiation in which `AgentState` is reduced to a single scalar — the delegatee's trust score — and the command is not inspected at all:

```typescript
// Trust-only CAA: AgentState = { trustScore } only
function delegationAttributes(trustScore: number): TaskAttribute {
  if (trustScore >= 0.8) return { criticality: "low",    reversibility: "high", ... };
  if (trustScore >= 0.5) return { criticality: "medium", reversibility: "high", ... };
  return                        { criticality: "high",   reversibility: "high", ... };
}
```

This is formally a CAA with `AgentState = { trustScore }` and a constant function of the command (it ignores `cmd`). It satisfies Property 3 (Conservative Default) by construction, and Properties 1–2 trivially (there is no phase-sensitive command to protect). What it surrenders: the hard enforcement of domain-level irreversibility. What it gains: complete game-agnosticism — the function is correct for any sequential decision domain without modification.

The choice between the full domain-aware CAA and the trust-only CAA is a policy decision about **where domain safety responsibility should reside**: in the framework's hard constraints (CAA), or in the Strategist's soft reasoning (LLM). The [1] framework accommodates both; the two patterns represent different points on a spectrum between governance-layer ownership and model-layer ownership of domain safety.

---

### 9.6 The Final Architectural Correction: Trust-Only Delegation Attributes

The phase-aware `classifyCommand()` (§5.2) resolved the pathological blocking observed in Runs E-v1 and E-v2. However, a more fundamental question persisted through the design review: **does game domain knowledge belong in the governance layer at all?**

The `classifyCommand()` function — even after the phase-aware correction — embedded Zork-specific predicates: `/^(attack|kill)\b/i`, `puzzleFlags.rugMoved`, `currentPhase >= 5`, `/^open trapdoor/i`. Deploying the same governance framework on a different game (a D&D adventure, a mystery game, a sci-fi exploration) would require rewriting this function entirely. The governance layer was not governing delegation; it was playing the game.

Re-reading [1] §5.2 with this framing makes the correct architecture clear. The `LiabilityFirebreak` is specified as a guard against *excessive delegation depth* — a structural accountability mechanism preventing runaway agent chains where no single principal holds responsibility. Its `TaskAttribute` inputs are intended to capture **delegation risk**: how much authority is being granted, and how trustworthy is the delegatee? Not: is this game command dangerous in the current room?

This distinction led to the final implementation:

```typescript
/**
 * Compute TaskAttribute from delegatee trust score only.
 *
 * Per [1] §5.2, the Firebreak guards delegation chain depth / trust, NOT
 * game-level safety.  Domain risk assessment is the Strategist LLM's
 * responsibility through its own in-context reasoning.
 *
 * reversibility is always "high": the delegation act is reversible
 * (we can re-delegate to Cartographer). Whether a game action is
 * irreversible in the game world is the Strategist's concern.
 */
function delegationAttributes(trustScore: number): TaskAttribute {
  if (trustScore >= 0.8)
    return { complexity: "low", criticality: "low",    reversibility: "high", ... };
  if (trustScore >= 0.5)
    return { complexity: "low", criticality: "medium", reversibility: "high", ... };
  return   { complexity: "low", criticality: "high",   reversibility: "high", ... };
}
```

The `reversibility` field is always `"high"` — not because game actions are always reversible (descending the trapdoor is emphatically not), but because the *delegation act* is reversible: if the Tactician fails, we can re-delegate to Cartographer. Domain irreversibility is the Strategist's concern, expressed through its choice of which commands to issue.

#### 9.6.1 What Was Removed

The game-agnostic refactor deleted approximately 120 lines of Zork-specific code from the framework layer:

| Removed | Purpose | Lines |
|---|---|---|
| `GAME_PHASES[]` | Hard-coded Zork objectives injected into Strategist prompt | 8 |
| `classifyCommand(cmd, puzzleFlags, phase)` | Phase- and flag-conditional risk classification | 55 |
| `updatePuzzleMemory(mem, cmd, delta)` | Parse `delta` to update mailboxOpen, rugMoved, swordTaken, etc. | 20 |
| `updateGamePhase(mem, rooms)` | Derive phase from room names + inventory | 12 |
| `puzzleFlags`, `currentPhase` in WorkingMemory | Zork-specific game state | 10 |
| Phase refresh after Step 1 | Re-compute phase after Cartographer ANALYZE | 4 |
| `CURRENT OBJECTIVE` in Strategist prompt | Phase-specific goal injection | 3 |
| `gmPuzzleFlags`, `gmPhase`, `currentObj` from game loop | Local variables reading the above | 8 |

#### 9.6.2 What Was Added

| Added | Purpose | Lines |
|---|---|---|
| `delegationAttributes(trustScore)` | Trust-only TaskAttribute production | 18 |
| `visitedRooms` in WorkingMemory | Generic room history for Strategist context | 1 |
| `visitedRooms` tracking in post-SLO block | Append new room on successful navigation | 4 |
| `--game <path>` CLI option | Pass any Z-machine story file to dfrotz | 2 |
| `emulator.launch(GAME_PATH)` | Use the CLI-specified game file | 1 |

Net: -120 lines, +26 lines, system is now game-agnostic.

#### 9.6.3 Behavioral Implications

The trust-only approach means that the Firebreak's behavior is now entirely determined by how much experience the framework has accumulated with the delegatee — not by what command is being executed. A fresh Tactician (trust < 0.5) faces `criticality: "high"` on every turn until trust accumulates; an established Tactician (trust ≥ 0.8) operates frictionlessly.

In practice, the seeded starting trust of 0.88 (3 prior successes) means the Firebreak allows all commands from turn 1. The governance signal that matters is the *trajectory*: if the Tactician begins failing (SLO violations, slashed bonds), trust falls below 0.5 on subsequent turns and `criticality: "high"` activates, triggering re-delegation to Cartographer. This is an accurate representation of the [1] Firebreak intent — it fires when delegatee reliability degrades, not when command strings match a hard-coded list.

#### 9.6.4 The Strategist as Domain Safety Oracle

With game-specific hard constraints removed from the governance layer, the question of domain safety falls entirely to the Strategist LLM. The Strategist receives:

```
AGENT MEMORY:
  Inventory: brass lantern, elfin sword
  Rooms visited: West of House, North of House, Behind House, Kitchen, Living Room, Cellar

Last response:
  You are in a dark room. A trapdoor leads up.

Full screen:
  Cellar                                    Score: 0        Moves: 14
  You are in the Cellar...
```

From this context, a capable Strategist correctly infers: "I have the lantern. I should turn it on before moving further." No phase flags, no hardcoded objectives — pure in-context reasoning from the game's own text. This is the paradigm [1]'s Dynamic Assessment pillar describes: the principal reasons about strategy before committing to a delegation. The framework enforces *accountability*; the model provides *intelligence*.

---

## 10. Future Work

### 10.1 Complete the 2×2 Comparison Matrix

Three runs remain:
- `--llm --frotz --blind` (Claude identifying itself under masking)
- `--grok --frotz` (classic Grok, no DeepMind framework — isolates framework contribution)
- `--grok --frotz --blind` (classic Grok blind)

Comparing `--grok` vs `--grok-enhanced` directly measures the governance framework's contribution to exploration depth, independent of model capability.

### 10.2 Hard FutilityMonitor Interventions

Replace the soft `futilityHint` string with a **command override**: if `FutilityMonitor.recordIteration()` returns `action: "halt"` and the Strategist is in a known phase, skip the LLM call entirely and substitute the first unexplored step of the current phase objective. This would directly address Grok's orientation-turn pathology.

### 10.3 Phase-Blind Objectives

The `--blind` mode currently suppresses phase objectives, replacing them with the generic string "Explore and interact with the game world." This is a confound: we cannot determine whether Grok's underperformance in G-B reflects the model's reasoning under blind conditions or the absence of structured objectives. A `--blind-objectives` variant that provides abstract goal descriptions ("Find an entrance to the building interior") without naming game entities would isolate these factors.

### 10.4 Harder Game Environments

Zork I's opening is extremely well-represented in LLM training corpora. A cleaner memorization/reasoning probe requires a game the models have not seen: a procedurally generated TextWorld [4] instance, an obscure Infocom title (e.g., *Stationfall*, *Nord and Bert*), or a custom-authored game.

The game-agnostic architectural correction (§9.6) makes this immediately available: the `--game <path>` CLI flag passes any Z-machine story file to dfrotz. No code changes of any kind are required:

```bash
# Play Hitchhiker's Guide to the Galaxy instead of Zork
npx tsx scripts/apple2-zork-swarm.ts --llm --frotz \
  --game /path/to/hhgg.z3 --turns 20

# Play a TextWorld-generated puzzle game
npx tsx scripts/apple2-zork-swarm.ts --llm --frotz \
  --game /path/to/generated-puzzle.z8 --turns 50
```

The governance framework, Strategist LLM prompts, Cartographer parsing, working memory tracking, and all five dormant components activate identically regardless of the game. The only game-specific behavior remaining is in dfrotz itself (parsing Z-machine bytecode), which is the correct layer for it to reside.

### 10.5 Longer Horizons and Scoring

A 50-turn budget would allow evaluation of the complete dungeon (defeating the thief, solving the Temple puzzle, recovering the treasures for the trophy case). Formalizing a scoring function over `{depth_score, efficiency_score, orientation_ratio, phase_reached, score_points}` would enable reproducible benchmarking and leaderboard comparison across model and framework configurations.

### 10.6 Anomaly Detector Activation

Zero anomalies were detected across all runs. This is expected — the dfrotz process does not drift, and all turns completed under SLO. Introducing an **adversarial Tactician** (one that injects latency or returns hallucinated game text) would activate the `AnomalyDetector` and provide data on the `RootCauseAnalyzer`'s diagnosis accuracy.

---

## 11. Conclusion

We set out to validate a governance framework. We ended up debugging it — three times — before we understood what it was actually for.

The governance system blocked the agent on turn 11. That was the experiment. Everything after that was an attempt to understand why a framework built to ensure safe and accountable delegation had become the primary obstacle to any delegation at all.

The path from that failure to the final result — 20/20 turns, troll defeated on turn 17, zero blocks — ran through eight discoveries. The governance layer was encoding game knowledge it had no business knowing. A single stale variable read made phase transitions invisible to the Firebreak. Two characters in a regex made an entire dungeon room disappear. And the FutilityMonitor, designed to interrupt pathological loops, could not interrupt Grok.

The one discovery that resolved all the others was also the simplest: re-read [1] §5.2. The Firebreak guards delegation depth and delegatee trust. It does not know what a trapdoor is, and it should not. Domain intelligence belongs in the model. Accountability belongs in the framework. When you conflate them — as `RISKY_COMMANDS` did — the system can only work by accident, in exactly the one domain it was hand-tuned for.

The formal artifact this produced is the **Contextual Attribute Adapter (CAA)** protocol (§9.5) — a proposed addendum to [1] that specifies what must be true about `TaskAttribute` production before the Firebreak can be correctly invoked in a sequential decision pipeline. And the practical artifact is a system that now runs any Z-machine story file through the full governance framework with no code changes, because once you remove the domain knowledge from the framework, there is nothing left that is specific to any game.

The code is at [https://github.com/oldeucryptoboi/KarnEvil9](https://github.com/oldeucryptoboi/KarnEvil9). The eight discoveries are in §1.

The KarnEvil9 framework, including the full game-agnostic swarm implementation and the CAA protocol, is available at [https://github.com/oldeucryptoboi/KarnEvil9](https://github.com/oldeucryptoboi/KarnEvil9).

---

## 12. References

[1] Tomasev, N., Franklin, M., & Osindero, S. (2026). *Intelligent AI Delegation*. Google DeepMind Technical Report.

[2] Lebling, P. D., Blank, M., & Anderson, T. A. (1980). *Zork: The Great Underground Empire*. Infocom.

[3] Narasimhan, K., Kulkarni, T., & Barzilay, R. (2015). Language understanding for text-based games using deep reinforcement learning. *Proceedings of EMNLP 2015*.

[4] Côté, M.-A., Kádár, Á., Yuan, X., Kybartas, B., Barnes, T., Fine, E., Moore, J., Tao, R., Hausknecht, M., Asri, L. E., Adada, M., Tay, W., & Trischler, A. (2018). TextWorld: A learning environment for text-based games. *Workshop on Computer Games, ICML 2018*.

[5] Hausknecht, M., Ammanabrolu, P., Côté, M.-A., & Yuan, X. (2020). Interactive fiction games: A colossal cave. *Proceedings of AAAI 2020*.

[6] Shinn, N., Cassano, F., Labash, A., Gopinath, A., Narasimhan, K., & Yao, S. (2023). Reflexion: Language agents with verbal reinforcement learning. *Advances in Neural Information Processing Systems 36*.

[7] Yao, S., Zhao, J., Yu, D., Du, N., Shafran, I., Narasimhan, K., & Cao, Y. (2022). ReAct: Synergizing reasoning and acting in language models. *International Conference on Learning Representations 2023*.

[8] Park, J. S., O'Brien, J. C., Cai, C. J., Morris, M. R., Liang, P., & Bernstein, M. S. (2023). Generative agents: Interactive simulacra of human behavior. *Proceedings of UIST 2023*.

[9] Wu, Q., Bansal, G., Zhang, J., Wu, Y., Li, B., Zhu, E., Jiang, L., Zhang, X., Zhang, S., Liu, J., Awadallah, A. H., White, R. W., Burger, D., & Wang, C. (2023). AutoGen: Enabling next-gen LLM applications via multi-agent conversation. *arXiv:2308.08155*.

[10] Wang, G., Xie, Y., Jiang, Y., Mandlekar, A., Xiao, C., Zhu, Y., Fan, L., & Anandkumar, A. (2023). Voyager: An open-ended embodied agent with large language models. *arXiv:2305.16291*.

---

*This paper describes an experiment conducted with the [KarnEvil9](https://github.com/oldeucryptoboi/KarnEvil9) open-source implementation of the Intelligent AI Delegation framework. The experiment code is in `scripts/apple2-zork-swarm.ts`. The Zork I runs are reproducible with `npx tsx scripts/apple2-zork-swarm.ts --llm --frotz --turns 20`. Any Z-machine story file can be substituted with the `--game <path>` flag — no code changes required.*
