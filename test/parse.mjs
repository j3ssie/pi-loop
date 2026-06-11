// Tests the /loop argument grammar: quoting, head-anchored flags, new flags, error cases.
// Run: node test/parse.mjs   (after `npx tsc` has produced dist/)
import { parseLoopArgs } from "../src/parse.ts";

let failures = 0;
const assert = (cond, msg) => {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
};
const parse = (raw) => parseLoopArgs(raw, "10m", "DEF");

console.log("base grammar");
{
	const f = parse("5m do the thing");
	assert(f.ok && f.spec.kind === "fixed" && f.spec.intervalMs === 300000 && f.spec.prompt === "do the thing", "interval + prompt -> fixed");

	const s = parse("do the thing");
	assert(s.ok && s.spec.kind === "selfPaced" && s.spec.prompt === "do the thing", "prompt only -> selfPaced");

	const d = parse("");
	assert(d.ok && d.spec.kind === "fixed" && d.spec.prompt === "DEF" && d.spec.usesDefaultPrompt === true, "bare -> default prompt, usesDefaultPrompt");

	const d2 = parse("15m");
	assert(d2.ok && d2.spec.kind === "fixed" && d2.spec.intervalLabel === "15m" && d2.spec.usesDefaultPrompt === true, "interval only -> default prompt on that interval");
}

console.log("flags are head-anchored; prompt text is verbatim");
{
	const p = parse("5m explain what --watch does");
	assert(p.ok && p.spec.kind === "fixed" && p.spec.prompt === "explain what --watch does", "flag-like word inside the prompt is not a flag");

	const u = parse("--weird thing");
	assert(!u.ok && /Unknown flag --weird/.test(u.error), "unknown leading flag -> explicit error");

	const q = parse('--watch "my notes.md" react to it');
	assert(q.ok && q.spec.kind === "watch" && q.spec.file === "my notes.md" && q.spec.prompt === "react to it", "quoted path with spaces");

	const v = parse("--watch");
	assert(!v.ok && /--watch needs a value/.test(v.error), "value flag without value -> error");
}

console.log("mode exclusivity and modifier scoping");
{
	const two = parse("--watch ./a --each ./b go");
	assert(!two.ok && /can't be combined/.test(two.error), "two mode flags -> error");

	const oc = parse("--on-change do X");
	assert(!oc.ok && /--on-change only applies/.test(oc.error), "--on-change without --file/--cmd -> error");

	const b = parse("--batch 3 do X");
	assert(!b.ok && /--batch only applies/.test(b.error), "--batch without --each -> error");
}

console.log("new flags");
{
	const c = parse('1m --cmd "gh pr checks 123" --on-change summarize failures');
	assert(c.ok && c.spec.kind === "cmd" && c.spec.command === "gh pr checks 123" && c.spec.intervalMs === 60000 && c.spec.onChange === true && c.spec.promptTemplate === "summarize failures", "--cmd with quoting, interval, --on-change");

	const t = parse("5m --times 3 check the deploy");
	assert(t.ok && t.spec.kind === "fixed" && t.spec.maxRuns === 3, "--times on a fixed loop");

	const tb = parse("--times zero do X");
	assert(!tb.ok && /--times expects a positive integer/.test(tb.error), "--times non-integer -> error");

	const e = parse("--each ./todo.txt --batch 2 --times 4 fix: {item}");
	assert(e.ok && e.spec.kind === "each" && e.spec.batch === 2 && e.spec.maxRuns === 4, "--each with --batch and --times");

	const fc = parse("5m --file ./n.md --on-change summarize");
	assert(fc.ok && fc.spec.kind === "fileInterval" && fc.spec.onChange === true, "--file --on-change");

	const a = parse("--at 09:00 standup summary");
	assert(a.ok && a.spec.kind === "at" && a.spec.time === "09:00" && a.spec.prompt === "standup summary", "--at parsed");

	const ab = parse("--at 25:00 do X");
	assert(!ab.ok && /--at expects a 24h clock time/.test(ab.error), "--at invalid time -> error");

	const ai = parse("5m --at 09:00 do X");
	assert(!ai.ok && /can't be combined/.test(ai.error), "--at plus interval -> error");

	const am = parse("--at 09:00 --watch ./x do X");
	assert(!am.ok && /can't be combined/.test(am.error), "--at plus mode flag -> error");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
