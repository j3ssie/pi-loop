// Tests the architecture-pass behaviors: the steering-hint footer (#5) and the
// non-TUI notify → .pi/loop.log fallback (#6).
// Run: node test/improvements.mjs   (after `npx tsc` has produced dist/)
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (cond, msg) => {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
};

const base = { max: 50, expiryMs: 7 * 86_400_000, selfMin: 20, selfMax: 200, watchPollMs: 30, watchDirPollMs: 30, fileMaxBytes: 1 << 20, cmdTimeoutMs: 5_000 };
const fixed = (ms, prompt) => ({ kind: "fixed", intervalMs: ms, intervalLabel: `${ms}ms`, prompt, isSlash: false });

function makeHarness(cfg) {
	const calls = [];
	let scheduler;
	const pi = {
		sendUserMessage: (content, options) => {
			calls.push({ content, options });
			setTimeout(() => scheduler.setBusy(true), 0);
			setTimeout(() => {
				scheduler.setBusy(false);
				scheduler.onAgentEnd();
			}, 8);
		},
		appendEntry: () => {},
	};
	scheduler = new LoopScheduler(pi, cfg);
	return { scheduler, calls };
}

console.log("#5 steering hint");
{
	// Opt-in (off by default): when enabled, a plain prompt gets the NEXT:/LOOP: hint appended.
	const h = makeHarness({ ...base, steerHint: true });
	h.scheduler.add(fixed(15, "do the work"));
	await sleep(40);
	h.scheduler.disposeAll();
	assert(h.calls[0]?.content.startsWith("do the work"), "original prompt preserved");
	assert(/LOOP:\s*done/i.test(h.calls[0]?.content ?? "") && /NEXT:/i.test(h.calls[0]?.content ?? ""), "steering hint appended");
}
{
	// Skip when the prompt already teaches the sentinels (no duplicate).
	const h = makeHarness({ ...base, steerHint: true });
	h.scheduler.add(fixed(15, "status check\nNEXT: 5m"));
	await sleep(40);
	h.scheduler.disposeAll();
	assert(h.calls[0]?.content === "status check\nNEXT: 5m", "prompt already mentions NEXT: -> left untouched");
}
{
	// Off: nothing appended.
	const h = makeHarness({ ...base, steerHint: false });
	h.scheduler.add(fixed(15, "do the work"));
	await sleep(40);
	h.scheduler.disposeAll();
	assert(h.calls[0]?.content === "do the work", "hint disabled -> prompt sent verbatim");
}

console.log("#6 non-TUI notify → .pi/loop.log");
{
	const dir = mkdtempSync(join(tmpdir(), "pi-loop-log-"));
	const work = join(dir, "work.txt");
	writeFileSync(work, "only-item\n");
	const h = makeHarness({ ...base, steerHint: false });
	// Headless context: no UI, but a real cwd — notifications should fall back to a log file.
	h.scheduler.renderWidget({ hasUI: false, cwd: dir });
	h.scheduler.add({ kind: "each", file: work, promptTemplate: "do: {item}", done: [], delayMs: 15 });
	await sleep(220); // fire the item, then exhaust -> "complete" notification
	h.scheduler.disposeAll();
	const logPath = join(dir, ".pi", "loop.log");
	assert(existsSync(logPath), "loop.log created in <cwd>/.pi");
	const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";
	assert(/complete/i.test(log), "completion notice written to the log");
	assert(/^\d{4}-\d\d-\d\dT/.test(log), "log line is timestamped");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
