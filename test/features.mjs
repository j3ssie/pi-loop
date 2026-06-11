// Tests the v2 feature set: FIFO fairness, the send watchdog, agent sentinels
// (LOOP: done/now/retry, NEXT:), --times, --batch, {index}, cmd loops, --on-change,
// directory watch, pause/resume/fire-now, and daily-time math.
// Run: node test/features.mjs   (after `npx tsc` has produced dist/)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";
import { msUntilDaily } from "../src/modes.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (cond, msg) => {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
};
const tmpDir = () => mkdtempSync(join(tmpdir(), "pi-loop-feat-"));
const tmp = (name, content) => {
	const file = join(tmpDir(), name);
	writeFileSync(file, content);
	return file;
};

const cfg = { max: 50, expiryMs: 7 * 86_400_000, selfMin: 20, selfMax: 200, watchPollMs: 30, watchDirPollMs: 30, fileMaxBytes: 1 << 20, cmdTimeoutMs: 5_000 };
const fixed = (ms, prompt = "tick", extra = {}) => ({ kind: "fixed", intervalMs: ms, intervalLabel: `${ms}ms`, prompt, isSlash: false, ...extra });

/**
 * Fake pi emulating a turn after each send. `respond(content, n)` returns the assistant's
 * final text for that turn (fed back through onAgentEnd as a real messages array).
 */
function makeHarness(cfg, { turnMs = 8, respond } = {}) {
	const calls = [];
	let scheduler;
	const pi = {
		sendUserMessage: (content, options) => {
			calls.push({ content, options, at: Date.now() });
			setTimeout(() => scheduler.setBusy(true), 0);
			setTimeout(() => {
				scheduler.setBusy(false);
				const text = respond?.(content, calls.length);
				scheduler.onAgentEnd(text === undefined ? undefined : [{ role: "assistant", content: [{ type: "text", text }] }]);
			}, turnMs);
		},
		appendEntry: () => {},
	};
	scheduler = new LoopScheduler(pi, cfg);
	return { scheduler, calls };
}

console.log("A. FIFO fairness: a tight loop cannot starve a slow one");
{
	const h = makeHarness(cfg, { turnMs: 30 });
	h.scheduler.add(fixed(10, "A"));
	h.scheduler.add(fixed(35, "B"));
	await sleep(500);
	h.scheduler.disposeAll();
	const a = h.calls.filter((c) => c.content === "A").length;
	const b = h.calls.filter((c) => c.content === "B").length;
	assert(a >= 2, `tight loop fired (A=${a})`);
	assert(b >= 2, `slow loop got its turns despite the tight loop (B=${b})`);
}

console.log("B. watchdog unsticks a send that never became a turn");
{
	const calls = [];
	const pi = { sendUserMessage: (c) => calls.push(c), appendEntry: () => {} }; // turn never starts
	const s = new LoopScheduler(pi, { ...cfg, watchdogMs: 25 });
	s.add(fixed(10));
	await sleep(150);
	s.disposeAll();
	assert(calls.length >= 2, `loops keep firing after a lost send (got ${calls.length})`);
}

console.log("C. LOOP: done stops the loop that fired the turn");
{
	const h = makeHarness(cfg, { respond: () => "all merged, nothing left\nLOOP: done" });
	h.scheduler.add(fixed(15));
	await sleep(150);
	h.scheduler.disposeAll();
	assert(h.calls.length === 1, `exactly one run (got ${h.calls.length})`);
	assert(h.scheduler.size() === 0, "loop removed itself");
}

console.log("D. LOOP: now re-fires immediately; /loop-now fires on demand");
{
	const h = makeHarness(cfg, { respond: () => "still failing, trying again\nLOOP: now" });
	h.scheduler.add(fixed(10_000, "go"));
	assert(h.scheduler.fireNow(h.scheduler.ids()[0]) === true, "fireNow accepted");
	await sleep(150);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 3, `re-fired without waiting for the 10s interval (got ${h.calls.length})`);
	assert(h.scheduler.fireNow("zzzz") === false, "fireNow refuses unknown ids");
}

console.log("E. NEXT: overrides the self-paced backoff (clamped to bounds)");
{
	const h = makeHarness(cfg, { respond: () => "quiet for now\nNEXT: 1s" }); // clamps to selfMax=200ms
	h.scheduler.add({ kind: "selfPaced", prompt: "check", isSlash: false });
	await sleep(140); // default doubling (20->40ms) would have fired again by now
	assert(h.calls.length === 1, `agent-chosen delay beat the backoff (got ${h.calls.length})`);
	await sleep(220);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 2, `fired again after the agent-chosen delay (got ${h.calls.length})`);
}

console.log("F. NEXT: also defers a fixed-interval loop's next run");
{
	const h = makeHarness(cfg, { respond: () => "NEXT: 1s" }); // fixed loops take it raw (min 1s)
	h.scheduler.add(fixed(30));
	await sleep(300);
	h.scheduler.disposeAll();
	assert(h.calls.length === 1, `30ms loop deferred to 1s by the sentinel (got ${h.calls.length})`);
}

console.log("G. LOOP: retry re-runs the same worklist item");
{
	const file = tmp("work.txt", "alpha\nbeta\n");
	const h = makeHarness(cfg, { respond: (_c, n) => (n === 1 ? "flaky, run it again\nLOOP: retry" : "ok") });
	h.scheduler.add({ kind: "each", file, promptTemplate: "do: {item}", done: [], delayMs: 15 });
	await sleep(350);
	h.scheduler.disposeAll();
	const sent = h.calls.map((c) => c.content);
	assert(sent.length === 3, `alpha retried once, then beta (got ${sent.length}: ${sent.join(" | ")})`);
	assert(sent[0] === "do: alpha" && sent[1] === "do: alpha" && sent[2] === "do: beta", "retry repeats the item before advancing");
	assert(h.scheduler.size() === 0, "worklist still auto-stops when exhausted");
}

console.log("H. --times stops the loop after N runs");
{
	const h = makeHarness(cfg);
	h.scheduler.add(fixed(15, "tick", { maxRuns: 2 }));
	await sleep(200);
	h.scheduler.disposeAll();
	assert(h.calls.length === 2, `exactly two runs (got ${h.calls.length})`);
	assert(h.scheduler.size() === 0, "loop removed after its quota");
}

console.log("I. pause/resume");
{
	const h = makeHarness(cfg);
	const r = h.scheduler.add(fixed(25));
	assert(h.scheduler.pause(r.id) === 1, "pause accepted");
	await sleep(120);
	assert(h.calls.length === 0, "no fires while paused");
	assert(h.scheduler.resume(r.id) === 1, "resume accepted");
	await sleep(120);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 1, `fires again after resume (got ${h.calls.length})`);
}

console.log("J. --batch groups worklist items; {index} substitutes");
{
	const file = tmp("work.txt", "alpha\nbeta\ngamma\n");
	const h = makeHarness(cfg);
	h.scheduler.add({ kind: "each", file, promptTemplate: "fix #{index}: {item}", done: [], delayMs: 15, batch: 2 });
	await sleep(250);
	h.scheduler.disposeAll();
	assert(h.calls.length === 2, `three items in two batches (got ${h.calls.length})`);
	assert(h.calls[0].content === "fix #0: alpha\nbeta", "first batch carries two items and the start index");
	assert(h.calls[1].content === "fix #2: gamma", "second batch carries the remainder");
	assert(h.scheduler.size() === 0, "auto-stops when exhausted");
}

console.log("K. cmd loop injects command output");
{
	const h = makeHarness(cfg);
	h.scheduler.add({ kind: "cmd", command: "echo hello-cmd-output", intervalMs: 40, intervalLabel: "40ms", promptTemplate: "review it" });
	await sleep(300);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 1, `cmd loop fired (got ${h.calls.length})`);
	assert(h.calls[0]?.content.includes("hello-cmd-output"), "output injected");
	assert(h.calls[0]?.content.includes('<command-output command="echo hello-cmd-output" untrusted="true">'), "wrapped in a command-output block");
	assert(h.calls[0]?.content.endsWith("review it"), "template appended");
}

console.log("L. cmd --on-change skips identical output");
{
	const h = makeHarness(cfg);
	h.scheduler.add({ kind: "cmd", command: "echo same-output", intervalMs: 35, intervalLabel: "35ms", promptTemplate: "react", onChange: true });
	await sleep(350);
	h.scheduler.disposeAll();
	assert(h.calls.length === 1, `identical output fired once, then skipped (got ${h.calls.length})`);
}

console.log("M. --file --on-change skips unchanged contents, fires on edit");
{
	const file = tmp("notes.md", "version one");
	const h = makeHarness(cfg);
	h.scheduler.add({ kind: "fileInterval", file, intervalMs: 35, intervalLabel: "35ms", promptTemplate: "summarize", onChange: true });
	await sleep(200);
	assert(h.calls.length === 1, `unchanged file fired once (got ${h.calls.length})`);
	writeFileSync(file, "version two now");
	await sleep(150);
	h.scheduler.disposeAll();
	assert(h.calls.length === 2 && h.calls[1].content.includes("version two now"), `edit triggered the next fire (got ${h.calls.length})`);
}

console.log("N. watching a directory fires with the changed file");
{
	const dir = tmpDir();
	writeFileSync(join(dir, "a.txt"), "baseline");
	const h = makeHarness(cfg);
	h.scheduler.add({ kind: "watch", file: dir, prompt: "triage the change" });
	await sleep(100);
	assert(h.calls.length === 0, "no fire while the directory is unchanged");
	writeFileSync(join(dir, "b.txt"), "fresh-stuff");
	await sleep(200);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 1, `fires after a new file appears (got ${h.calls.length})`);
	assert(h.calls.some((c) => c.content.includes("fresh-stuff") && c.content.includes("b.txt")), "injects the changed file's path and contents");
}

console.log("O. daily-time math");
{
	const at8 = new Date(2026, 0, 1, 8, 0, 0, 0);
	assert(msUntilDaily("09:00", at8) === 3_600_000, "09:00 from 08:00 -> 1h");
	assert(msUntilDaily("08:00", at8) === 86_400_000, "08:00 from 08:00 -> tomorrow");
	assert(msUntilDaily("07:30", at8) === 84_600_000, "07:30 from 08:00 -> 23.5h");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
