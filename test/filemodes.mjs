// Tests the three file-loop modes: fileutil helpers, parser flags, and scheduler integration
// (watch / worklist / re-read) against real temp files.
// Run: node test/filemodes.mjs   (after `npx tsc` has produced dist/)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCapped, readItems, injectFile } from "../src/fileutil.ts";
import { parseLoopArgs } from "../src/parse.ts";
import { LoopScheduler } from "../src/scheduler.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (cond, msg) => {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
};
const tmp = (name, content) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-loop-fm-"));
	const file = join(dir, name);
	writeFileSync(file, content);
	return file;
};

const cfg = { max: 50, expiryMs: 7 * 86_400_000, selfMin: 20, selfMax: 200, watchPollMs: 40, fileMaxBytes: 1 << 20 };

// Fake pi that records sends and emulates a run (agent_start -> agent_end) after each send.
function makeHarness(cfg, { turnMs = 8 } = {}) {
	const calls = [];
	let scheduler;
	const pi = {
		sendUserMessage: (content, options) => {
			calls.push({ content, options });
			setTimeout(() => scheduler.setBusy(true), 0);
			setTimeout(() => {
				scheduler.setBusy(false);
				scheduler.onAgentEnd();
			}, turnMs);
		},
		appendEntry: () => {},
	};
	scheduler = new LoopScheduler(pi, cfg);
	return { scheduler, calls };
}

console.log("fileutil");
{
	const items = tmp("todo.txt", "alpha\n\n# a comment\n  beta  \ngamma\n");
	assert(JSON.stringify(readItems(items)) === JSON.stringify(["alpha", "beta", "gamma"]), "readItems skips blanks/# and trims");
	assert(readItems("/no/such/file") .length === 0, "readItems on missing file -> []");

	assert(readCapped("/no/such/file", 100).startsWith("(file not found"), "readCapped missing -> marker");
	assert(readCapped(tmp("e.txt", "   "), 100) === "(file is empty)", "readCapped empty -> marker");
	const capped = readCapped(tmp("big.txt", "x".repeat(500)), 100);
	assert(capped.includes("truncated at 100 bytes"), "readCapped truncates large files");

	assert(injectFile("f.md", "BODY", "do X").startsWith('<file path="f.md" untrusted="true">'), "injectFile prepends <file> block by default");
	assert(injectFile("f.md", "BODY", "use {contents} now") === "use BODY now", "injectFile substitutes {contents}");
}

console.log("parser flags");
{
	const w = parseLoopArgs("--watch ./notes.md react to it", "10m", "DEF").spec;
	assert(w.kind === "watch" && w.file === "./notes.md" && w.prompt === "react to it", "--watch parsed");

	const e = parseLoopArgs("--each ./todo.txt fix {item}", "10m", "DEF").spec;
	assert(e.kind === "each" && e.file === "./todo.txt" && e.promptTemplate === "fix {item}" && e.done.length === 0 && e.delayMs === 3000, "--each parsed (default delay)");

	const e2 = parseLoopArgs("30s --each ./todo.txt go", "10m", "DEF").spec;
	assert(e2.kind === "each" && e2.delayMs === 30000, "--each with leading interval -> per-item delay");

	const f = parseLoopArgs("5m --file ./n.md summarize", "10m", "DEF").spec;
	assert(f.kind === "fileInterval" && f.file === "./n.md" && f.intervalMs === 300000 && f.promptTemplate === "summarize", "--file with interval parsed");

	const f2 = parseLoopArgs("--file ./n.md", "10m", "DEF").spec;
	assert(f2.kind === "fileInterval" && f2.intervalLabel === "10m" && f2.promptTemplate === "DEF" && f2.usesDefaultPrompt === true, "--file without interval -> default interval + prompt");
}

console.log("scheduler: re-read (fileInterval)");
{
	const file = tmp("notes.md", "ALPHA contents");
	const h = makeHarness(cfg, { turnMs: 8 });
	h.scheduler.add({ kind: "fileInterval", file, intervalMs: 45, intervalLabel: "45ms", promptTemplate: "summarize what changed" });
	await sleep(70);
	assert(h.calls.some((c) => c.content.includes("ALPHA contents")), "first fire includes current file contents");
	writeFileSync(file, "BETA contents now");
	await sleep(90);
	assert(h.calls.some((c) => c.content.includes("BETA contents now")), "later fire reflects the edited file");
	assert(h.calls.every((c) => c.options?.deliverAs === "followUp"), "all sends crash-safe (followUp)");
	h.scheduler.disposeAll();
}

console.log("scheduler: worklist (each)");
{
	const file = tmp("work.txt", "task-one\ntask-two\ntask-three\n");
	const h = makeHarness(cfg, { turnMs: 8 });
	h.scheduler.add({ kind: "each", file, promptTemplate: "do: {item}", done: [], delayMs: 25 });
	await sleep(400);
	const sent = h.calls.map((c) => c.content);
	assert(sent.length === 3, `fired once per item (got ${sent.length})`);
	assert(sent[0] === "do: task-one" && sent[1] === "do: task-two" && sent[2] === "do: task-three", "items processed in order");
	assert(h.scheduler.size() === 0, "worklist auto-stops when exhausted");
}

console.log("scheduler: watch (fires on change)");
{
	const file = tmp("watched.json", '{"v":1}');
	const h = makeHarness(cfg, { turnMs: 8 });
	h.scheduler.add({ kind: "watch", file, prompt: "triage the change" });
	await sleep(120);
	assert(h.calls.length === 0, "no fire while the file is unchanged");
	writeFileSync(file, '{"v":2,"new":"stuff"}');
	await sleep(150);
	assert(h.calls.length >= 1, "fires after the file changes");
	assert(h.calls.some((c) => c.content.includes('"new":"stuff"')), "fire includes the changed contents");
	assert(h.calls.some((c) => c.content.includes("triage the change")), "fire includes the task prompt");
	h.scheduler.disposeAll();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
