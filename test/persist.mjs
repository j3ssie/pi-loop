// Tests persistence: snapshot round-trip across "reload", worklist progress restoration,
// legacy cursor migration, expiry filtering, id-sequence recovery, and paused state.
// Run: node test/persist.mjs   (after `npx tsc` has produced dist/)
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopScheduler } from "../src/scheduler.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (cond, msg) => {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
};
const tmp = (name, content) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-loop-persist-"));
	const file = join(dir, name);
	writeFileSync(file, content);
	return file;
};

const cfg = { max: 50, expiryMs: 7 * 86_400_000, selfMin: 20, selfMax: 200, watchPollMs: 40, fileMaxBytes: 1 << 20 };
const fixed = (ms, prompt = "tick") => ({ kind: "fixed", intervalMs: ms, intervalLabel: `${ms}ms`, prompt, isSlash: false });

function makeHarness(cfg, { turnMs = 8 } = {}) {
	const calls = [];
	const snapshots = [];
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
		appendEntry: (_type, data) => snapshots.push(data),
	};
	scheduler = new LoopScheduler(pi, cfg);
	return { scheduler, calls, snapshots };
}

const ctxFor = (snapshot) => ({
	hasUI: false,
	cwd: process.cwd(),
	sessionManager: { getEntries: () => (snapshot ? [{ type: "custom", customType: "loop-task", data: snapshot }] : []) },
});

console.log("round-trip across reload (worklist progress + fire history)");
{
	const file = tmp("work.txt", "one\ntwo\n");
	const h1 = makeHarness(cfg);
	h1.scheduler.add({ kind: "each", file, promptTemplate: "do: {item}", done: [], delayMs: 50 });
	h1.scheduler.add(fixed(60_000, "later"));
	await sleep(75); // first item fires (~50ms) and persists; reload before the second (~110ms)
	h1.scheduler.disposeAll();
	assert(h1.calls.length === 1 && h1.calls[0].content.includes("one"), "first item fired before 'reload'");

	const snapshot = h1.snapshots.at(-1);
	const h2 = makeHarness(cfg);
	h2.scheduler.restore(ctxFor(snapshot), "reload");
	assert(h2.scheduler.size() === 2, `both loops restored (got ${h2.scheduler.size()})`);
	const each = h2.scheduler.list().find((l) => l.kind === "each");
	assert(each?.fireCount === 1, `fire history restored (got ${each?.fireCount})`);
	await sleep(120);
	h2.scheduler.disposeAll();
	assert(h2.calls.some((c) => c.content.includes("two")), "resumes at the next unprocessed item");
	assert(!h2.calls.some((c) => c.content.includes('"one"') || /do: one/.test(c.content)), "does not repeat the processed item");
}

console.log("legacy numeric-cursor snapshots migrate to the done-set");
{
	const file = tmp("work.txt", "one\ntwo\n");
	const now = Date.now();
	const snapshot = {
		tasks: [{ id: "0001", spec: { kind: "each", file, promptTemplate: "do: {item}", cursor: 1, delayMs: 15 }, createdAt: now, expiresAt: now + 60_000 }],
	};
	const h = makeHarness(cfg);
	h.scheduler.restore(ctxFor(snapshot), "reload");
	await sleep(60);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 1 && h.calls[0].content.includes("two"), "cursor=1 -> first item treated as done");
}

console.log("expired and gated restores");
{
	const now = Date.now();
	const snapshot = { tasks: [{ id: "0001", spec: fixed(1000), createdAt: now - 10_000, expiresAt: now - 1, fireCount: 3 }] };
	const h = makeHarness(cfg);
	h.scheduler.restore(ctxFor(snapshot), "reload");
	assert(h.scheduler.size() === 0, "expired loop dropped at restore");

	const fresh = { tasks: [{ id: "0001", spec: fixed(1000), createdAt: now, expiresAt: now + 60_000 }] };
	const h2 = makeHarness(cfg);
	h2.scheduler.restore(ctxFor(fresh), "new");
	assert(h2.scheduler.size() === 0, "restore only runs for reload/resume reasons");
	h.scheduler.disposeAll();
	h2.scheduler.disposeAll();
}

console.log("id sequence recovers past restored ids");
{
	const now = Date.now();
	const snapshot = { tasks: [{ id: "000a", spec: fixed(60_000), createdAt: now, expiresAt: now + 60_000 }] };
	const h = makeHarness(cfg);
	h.scheduler.restore(ctxFor(snapshot), "reload");
	const r = h.scheduler.add(fixed(60_000));
	assert(r.ok && r.id === "000b", `new id continues after restored ids (got ${r.ok && r.id})`);
	h.scheduler.disposeAll();
}

console.log("paused state survives reload");
{
	const now = Date.now();
	const snapshot = { tasks: [{ id: "0001", spec: fixed(10), createdAt: now, expiresAt: now + 60_000, paused: true, fireCount: 2 }] };
	const h = makeHarness(cfg);
	h.scheduler.restore(ctxFor(snapshot), "reload");
	await sleep(60);
	assert(h.calls.length === 0, "paused loop does not fire after restore");
	assert(h.scheduler.list()[0]?.paused === true, "list reports it paused");
	h.scheduler.resume("0001");
	await sleep(60);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 1, "resumed loop fires again");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
