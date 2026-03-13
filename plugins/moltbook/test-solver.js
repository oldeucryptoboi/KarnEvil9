#!/usr/bin/env node
/**
 * Test the moltbook LLM verification solver and record every challenge
 * in the SQLite corpus.
 *
 * Usage:
 *   node plugins/moltbook/test-solver.js              # run all built-in challenges
 *   node plugins/moltbook/test-solver.js --stats       # show corpus stats
 *   node plugins/moltbook/test-solver.js --dump        # dump all corpus entries
 *   node plugins/moltbook/test-solver.js "challenge"   # test a single challenge text
 */
import { MoltbookClient } from "./moltbook-client.js";
import { createSimpleLLMCall } from "../../packages/cli/dist/llm-adapters.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Built-in test challenges with known answers
const CHALLENGES = [
  // Previously failed in production (from pm2 logs)
  { text: "A] lO^bSt-Er'S/ cL-aW sTrEtChEs, eRrR lOoOoObSsStT errM eChAnIx Um, eX^eR tS tHiRtY tWo NeWtOnS| aNd- sOcIaL dOmInAnCe MuLtIpLiEs\\ bY tHrEe~, wHaT's] tHoT^aL fOrCe?", expected: 96 },
  { text: "A] LoOoBbSsTtErR S^wImMs ~VeLooOoOcItY Is ThIr-Ty TwO CeNmeTeR s PeR SeCoNd | BuT AfTeR A TeRrItOrIiAl BuMp {iT} ReDuCeS -By SeVeN CeNmEtErS /PeR SeCoNd ] WhAt Is ThE NeW SpEeD?", expected: 25 },
  { text: "]A] LoBb-S tErRr SwImS Um, LiKe, WiTh^ A] ClAwW FoRcEe OfF tHiR tY fIvEe NeWt-O nS] WiNnS| TeRrItOrY FrOm^ AnOtHeR ThAt AdDs\\ TwElVe NeW^tOnS, WhAt Is ThE/ ToTaL FoRcE?", expected: 47 },
  // Standard two-operand challenges
  { text: "wHaT iS fOuRtEeN pLuS tWeNtY tHrEe", expected: 37 },
  { text: "A lobster has forty claws and loses twelve what is the new count", expected: 28 },
  { text: "A lobster exerts eighteen newtons and another adds six newtons what is the total", expected: 24 },
  { text: "A lobster swims at twenty centimeters per second and speeds up by five what is the new speed", expected: 25 },
  // Harder: unusual phrasing
  { text: "A lobster weighs forty five kilograms and sheds a quarter of its weight how much does it weigh now", expected: 33.75 },
  { text: "A lobster has sixty claws but loses ten percent of them how many remain", expected: 54 },
  { text: "A lobster catches twelve fish then eats five and finds eight more how many fish does it have", expected: 15 },
  { text: "um like a lobster errr swims at nine meters per second and um speeds up by times four what is the new speed", expected: 36 },
  // Heavily obfuscated
  { text: "A^ lOo-ObSsTeRr'S/ cLaAwW eXx-EeRrTtSs FiFtEeN nEeWwToOnNsS aNd GaInS tWeNtY mOrE, wHaT's ThE tOtAl?", expected: 35 },
  { text: "tHe LoBsTeR sWiMs At TwEnTy FoUr CeNtImEtErS pEr SeCoNd AnD sLoWs By NiNe, WhAt Is ThE nEw SpEeD?", expected: 15 },
];

async function main() {
  const args = process.argv.slice(2);

  // Create client with LLM solver and local corpus
  const llmCall = createSimpleLLMCall({ planner: "codex" });
  if (!llmCall) {
    console.error("ERROR: No LLM backend available. Set ANTHROPIC_API_KEY or ensure Claude Code CLI is logged in.");
    process.exit(1);
  }

  const client = new MoltbookClient({
    apiKey: "test",
    agentName: "test-solver",
    llmCall,
    dataDir: __dirname,
    logger: {
      info: (...a) => {},
      warn: (...a) => console.error("[WARN]", ...a),
      error: (...a) => console.error("[ERROR]", ...a),
    },
  });

  // --stats: show corpus stats
  if (args.includes("--stats")) {
    const stats = client.getCorpusStats();
    console.log("Corpus stats:", stats);
    const verified = client.getVerifiedChallenges();
    console.log(`Verified challenges: ${verified.length}`);
    return;
  }

  // --dump: dump all corpus entries
  if (args.includes("--dump")) {
    client._initCorpus();
    if (!client._corpus) { console.log("No corpus DB"); return; }
    const rows = client._corpus.prepare("SELECT * FROM challenges ORDER BY id").all();
    for (const r of rows) {
      const status = r.verified ? "\u2713" : "\u2717";
      console.log(`${status} [${r.method}] answer=${r.answer} | ${r.challenge_text.slice(0, 80)}...`);
    }
    console.log(`\nTotal: ${rows.length}`);
    return;
  }

  // Single challenge from CLI arg
  if (args.length > 0 && !args[0].startsWith("--")) {
    const text = args.join(" ");
    await testChallenge(client, { text, expected: null });
    return;
  }

  // Run all built-in challenges
  console.log(`Running ${CHALLENGES.length} challenges through LLM solver\n`);
  let pass = 0, fail = 0;

  for (const c of CHALLENGES) {
    const result = await testChallenge(client, c);
    if (result.ok) pass++; else fail++;
  }

  console.log(`\n${"\u2500".repeat(60)}`);
  console.log(`Results: ${pass} pass, ${fail} fail`);
  console.log(`Corpus:`, client.getCorpusStats());
}

async function testChallenge(client, c) {
  // Solve via LLM (same path as production)
  const answer = await client._solveWithLLM(c.text);
  const method = answer !== null ? "llm" : "failed";

  // Record in corpus (verified = answer matches expected, or true if no expected)
  const verified = c.expected !== null ? (answer !== null && Math.abs(answer - c.expected) < 0.01) : (answer !== null);
  client._recordChallenge(c.text, answer, method, verified);

  // Report
  const ok = c.expected !== null ? verified : answer !== null;
  const label = ok ? "PASS" : "FAIL";
  const line = `${label} [${method}] got=${answer} ${c.expected !== null ? `expected=${c.expected}` : ""}`;
  console.log(line);
  if (!ok) console.log(`  \u2192 ${c.text.slice(0, 90)}...`);

  return { ok, method, answer };
}

main().catch((err) => { console.error(err); process.exit(1); });
