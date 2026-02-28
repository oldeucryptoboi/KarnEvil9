# We Tried to Hide Zork From an LLM. It Identified the Game Anyway.

## How we built a governed AI agent to play text adventures — and what broke first

**TL;DR:** We wired Google DeepMind's Intelligent AI Delegation framework into a Zork I agent, masked the game title to prevent memorized solutions, and watched the safety system block the agent from winning. Three iterations of debugging later, we learned that governance layers should own accountability, not domain intelligence. The final architecture runs any Z-machine game with zero code changes.

---

## The Problem: LLMs Have Memorized Zork

Zork I is one of the most documented text adventures ever created. Every major LLM has seen walkthroughs, maps, and optimal solutions in its training data. Feed Claude or Grok the opening text — "West of House. There is a small mailbox here" — and it will replay the known-optimal path from memory.

That is pattern matching, not reasoning.

We wanted to know: can an LLM actually *reason* through an interactive fiction game, making decisions based on what it observes rather than what it remembers?

## Level 1: Masking the Game Identity

We built a `maskGameText()` function that runs before any game output reaches the LLM:

```typescript
function maskGameText(text: string): string {
  const blk = (m: string) => "█".repeat(m.length);
  return text
    .replace(/\bZORK\s+I\b/gi, blk)
    .replace(/\bZORK\b/gi, blk)
    .replace(/\bInfocom\b/gi, blk)
    .replace(/^Copyright\b.*/gim, blk)
    .replace(/^Revision\s+\d+\/Serial number\d+.*/gim, blk);
}
```

Key design choice: **1:1 character ratio replacement**. Each character becomes a block character (█). This preserves text length so the model cannot infer the original word from the gap size.

Applied to every LLM-facing field: room descriptions, transcripts, inventory, screen text.

### The Result: Structural Fingerprints Beat Surface Masking

At session end, we forwarded the full masked transcript to the model and asked it to identify the game.

Grok nailed it instantly with three structural clues, zero lexical ones:

1. The opening location — white house, boarded front door, small mailbox
2. The leaflet text pattern (even with "ZORK" blocked out)
3. The living room layout — trophy case, oriental rug concealing a trapdoor

**You cannot mask structure.** Room topology, item placement, and puzzle dependencies are as distinctive as the title. The spatial architecture of Zork is deeply indexed across training corpora. For true blindness, you need a novel game not present in training data.

## Level 2: The DeepMind Intelligent Delegation Framework

This is where it gets interesting. We implemented the full [Tomasev, Franklin & Osindero "Intelligent AI Delegation" framework](https://arxiv.org/abs/2503.00381) from Google DeepMind as kernel hooks in our runtime ([KarnEvil9](https://github.com/oldeucryptoboi/KarnEvil9)).

### The Architecture: Three-Node Swarm

```
┌───────────────┐     ┌──────────────┐     ┌───────────────┐
│  Strategist   │────▶│  Tactician   │────▶│ Cartographer  │
│ (Claude LLM)  │     │ (Z-machine)  │     │ (Room mapper) │
│  Decides      │     │  Executes    │     │  Verifies     │
└───────────────┘     └──────────────┘     └───────────────┘
```

- **Strategist**: Claude Sonnet deciding what command to execute next
- **Tactician**: Sends commands to a dfrotz Z-machine emulator process (~5ms per command)
- **Cartographer**: Independently parses screen text to build a room graph and verify game state

### Five DeepMind Framework Components

| Component | Role | Config |
|-----------|------|--------|
| **EscrowManager** | $0.10 bond per delegation. Failed tasks get slashed. | Per-task bonding |
| **ReputationStore** | Trust scores starting at 0.88, adjusted on outcomes | Exponential moving average |
| **LiabilityFirebreak** | Circuit breaker halting delegation beyond safe depth | Depth = 3 − criticality − reversibility |
| **OutcomeVerifier** | SLO enforcement: 7.5s max, 750 tokens, $0.02/command | Per-turn verification |
| **ConsensusVerifier** | Cartographer must agree with Strategist before turn counts | 2-of-2 consensus |

### First Run: The Governance System Blocked the Agent From Playing

```
Turn  6: attack troll         → Firebreak HALT (criticality: "high")
Turn 11: open trapdoor        → Firebreak HALT (criticality: "high")
Turn 15: kill troll with sword → Firebreak HALT (criticality: "high")
```

The problem: a static `RISKY_COMMANDS` list flagged "attack" and "kill" as high-criticality regardless of context. But in Zork, killing the troll is **mandatory** — it is the only way past the Troll Room. The safety system was protecting the agent from winning the game.

## The Three Iterations of Pain

### Iteration 1: Phase-Aware Classification

We added `updateGamePhase()` — track which game phase the agent is in based on rooms visited and inventory. "Attack troll" at phase 5 (Troll Room) is low criticality. At phase 2 (still exploring the house) it is high.

**Bug discovered:** Pipeline ordering. The Cartographer updates the room list *after* the phase is computed. Entering the Troll Room still reads as phase 4 because the phase refresh happened too early in the pipeline.

### Iteration 2: Regex Blindness

We fixed the ordering. Next bug: the `isRoomName()` filter excluded strings starting with "The" to filter out prose responses ("The door opens...").

Guess what "The Troll Room" starts with.

**Two characters in a regex erased an entire dungeon room from the map.** Phase 5 never triggered because the room was never added to the cartographer's state.

### Iteration 3: The Architectural Reckoning

After fixing both bugs, we had **120 lines of Zork-specific code** inside the governance layer:

- `GAME_PHASES` — Zork phase definitions
- `updatePuzzleMemory()` — Zork puzzle flag tracking
- `puzzleFlags.rugMoved`, `puzzleFlags.swordTaken` — Zork-specific state
- Phase-aware `classifyCommand()` with Zork regexes

Then someone asked: *"Can I use this for D&D?"*

We looked at the code and realized we had built a Zork expert disguised as a governance framework.

## The Fix: Trust-Only Delegation

Re-reading the DeepMind paper, Section 5.2:

> "The LiabilityFirebreak acts as a circuit breaker that halts delegation beyond a configurable depth when task attributes indicate unacceptable risk."

The key word is **depth**, not command semantics. The Firebreak is a structural depth guard — it fires when delegation chains grow too long to be trustworthy.

The correct `TaskAttribute` input is the **delegatee's trust score**, not game command classification:

```typescript
function delegationAttributes(trustScore: number): TaskAttribute {
  if (trustScore >= 0.8)
    return { criticality: "low", reversibility: "high" };
  if (trustScore >= 0.5)
    return { criticality: "medium", reversibility: "high" };
  return { criticality: "high", reversibility: "high" };
}
```

**Deleted:** 120 lines of Zork-specific code.
**Added:** 26 lines of trust-based scoring.

The LLM owns domain intelligence (should I attack the troll?). The governance framework owns accountability (is this delegation chain trustworthy?). These are separate responsibilities.

## Level 3: Game-Agnostic Tool Design

The game emulator handler exposes three tools:

- `execute-game-command` — send a text command to the Z-machine
- `parse-game-screen` — read current room description and inventory
- `navigate` — move in a direction

None of these know anything about Zork. They talk to a `dfrotz` process running any Z-machine bytecode. The compound tools (`combat`, `take-all`) are also game-agnostic — combat loops the attack command until game state changes. It does not know what a troll is.

## Results

| Metric | Baseline | Final |
|--------|----------|-------|
| Turns successful | 14/20 | **20/20** |
| Firebreak blocks | 10 | **0** |
| Rooms mapped | 6 | **9** |
| Troll defeated | No | **Yes (turn 17)** |
| Game-specific governance code | 120 lines | **0 lines** |

The command to run any Z-machine game through the full governed framework:

```bash
npx tsx scripts/apple2-zork-swarm.ts --llm --frotz --game /path/to/any.z3 --turns 20
```

Works for Zork I, Hitchhiker's Guide, Planetfall — any interactive fiction. Zero code changes.

## The Lesson

Safety systems that know too much about the domain they protect become obstacles. The best governance is structurally sound and domain-ignorant. Let the model be smart about the game. Let the framework be smart about trust.

The full experiment writeup, source code, and whitepapers are at [github.com/oldeucryptoboi/KarnEvil9](https://github.com/oldeucryptoboi/KarnEvil9).

---

*Built by [@oldeucryptoboi](https://twitter.com/oldeucryptoboi) and E.D.D.I.E. (Emergent Deterministic Directed Intelligence Engine) — an AI agent running on KarnEvil9.*
