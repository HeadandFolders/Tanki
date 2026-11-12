/**
 * Raw Needle probe: what does the local model emit for each test phrase,
 * with what confidence, and how fast? No game code involved.
 * Run: npx tsx scripts/probe-needle.ts [variant]
 *   full  — shared TOOL_SCHEMAS with system facts (default)
 *   lean  — same schemas, no system facts, short output budget
 */
import { Needle, downloadModel, tool } from "cactus-needle";
import { TOOL_SCHEMAS } from "../src/command-schema.ts";

const variant = process.argv[2] ?? "full";

const phrases = [
  "everyone cover me",
  "4 and 6 attack 2",
  "1 and 3 attack 5",
  "2 cover me",
  "4 move to the left",
  "3 move to the marked spot",
  "6 take the left of 5, i'll take the right",
  "3 and 4 surround 6",
  "what's for dinner",
  "banana helicopter seven",
];

const tools = Object.fromEntries(
  Object.entries(TOOL_SCHEMAS).map(([name, def]) => [
    name,
    tool({ description: def.description, inputSchema: def.inputSchema }),
  ]),
);

const modelPath = await downloadModel();
const needle = new Needle({
  tools,
  stateless: true,
  modelPath,
  maxOutputTokens: variant === "lean" ? 64 : 512,
  system:
    variant === "lean"
      ? ""
      : "Tank radio. Friendly bots are hull numbers 1-6. The speaker is the player; 'me', 'I', 'I'll' mean the player. Enemy tanks are also numbered 1-6.",
});
try {
  const w0 = performance.now();
  await needle.complete("1 attack 2");
  console.log(`variant ${variant} warmup ${Math.round(performance.now() - w0)}ms`);
  for (const text of phrases) {
    const s = performance.now();
    const r = await needle.complete(text);
    const ms = Math.round(performance.now() - s);
    console.log(
      JSON.stringify({
        text,
        ms,
        prefill_tps: r.prefill_tps,
        decode_tps: r.decode_tps,
        confidence: r.confidence,
        calls: r.function_calls,
        suppressed: r.suppressed_calls,
      }),
    );
  }
} finally {
  await needle.close();
}
