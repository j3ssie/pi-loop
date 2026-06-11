// Runtime test of the LoopScheduler core invariants, driven against a fake `pi` that
// emulates Pi's agent lifecycle (agent_start/agent_end) around each injected message.
// Run: node test/engine.mjs   (after `npx tsc` has produced dist/)
import { LoopScheduler } from "../dist/scheduler.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, msg) {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
}

const cfg = { max: 50, expiryMs: 7 * 86_400_000, selfMin: 20, selfMax: 200 };
const fixed = (ms, prompt = "tick") => ({ kind: "fixed", intervalMs: ms, intervalLabel: `${ms}ms`, prompt, isSlash: false });
const selfPaced = (prompt = "watch") => ({ kind: "selfPaced", prompt, isSlash: false });

/**
 * Fake pi that records sends and emulates a run of `turnMs` (agent_start -> agent_end) after
 * each send, exactly like a real injected user message. Tracks two safety invariants:
 *   - every send must pass deliverAs (else real Pi throws while streaming)
 *   - no send may happen while a run is active (would be "Agent is already processing")
 */
function makeHarness(cfg, { turnMs = 6 } = {}) {
	const calls = [];
	let runActive = false;
	let overlaps = 0;
	let badDelivery = 0;
	let scheduler;
	const pi = {
		sendUserMessage: (content, options) => {
			if (runActive) overlaps++;
			if (!options || options.deliverAs !== "followUp") badDelivery++;
			calls.push({ content, options });
			setTimeout(() => {
				runActive = true;
				scheduler.setBusy(true);
			}, 0);
			setTimeout(() => {
				runActive = false;
				scheduler.setBusy(false);
				scheduler.onAgentEnd();
			}, turnMs);
		},
		appendEntry: () => {},
	};
	scheduler = new LoopScheduler(pi, cfg);
	return {
		scheduler,
		calls,
		get overlaps() {
			return overlaps;
		},
		get badDelivery() {
			return badDelivery;
		},
		// Emulate an externally-started run (e.g. the user typing), of `ms`.
		externalRun: async (ms) => {
			runActive = true;
			scheduler.setBusy(true);
			await sleep(ms);
			runActive = false;
			scheduler.setBusy(false);
			scheduler.onAgentEnd();
		},
	};
}

// A: fixed loop fires repeatedly across simulated turns; never overlaps; always followUp.
async function testFixedRepeats() {
	console.log("A. fixed loop fires repeatedly, never overlapping a run");
	const h = makeHarness(cfg, { turnMs: 6 });
	h.scheduler.add(fixed(25));
	await sleep(135);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 2, `fired multiple times (got ${h.calls.length})`);
	assert(h.overlaps === 0, `no send during an active run (overlaps=${h.overlaps})`);
	assert(h.badDelivery === 0, `every send used deliverAs:followUp (bad=${h.badDelivery})`);
}

// B: a long external (user) run suppresses fires; missed intervals collapse to one.
// Inlined (not externalRun) so we can assert *while still busy*, before the post-run flush.
async function testCollapse() {
	console.log("B. external run suppresses fires; missed intervals collapse to one");
	const h = makeHarness(cfg, { turnMs: 6 });
	h.scheduler.add(fixed(20));
	h.scheduler.setBusy(true); // external run begins (e.g. the user typing)
	await sleep(85); // ~4 intervals elapse during the run
	assert(h.calls.length === 0, `no fire during the external run (got ${h.calls.length})`);
	h.scheduler.setBusy(false); // run ends -> exactly one collapsed fire is released
	h.scheduler.onAgentEnd();
	await sleep(12);
	assert(h.calls.length === 1, `exactly one fire after the run, not one-per-missed (got ${h.calls.length})`);
	assert(h.overlaps === 0, `still no overlap (overlaps=${h.overlaps})`);
	h.scheduler.disposeAll();
}

// C: intervals shorter than the turn must NOT pile up (inFlight collapse).
async function testNoStorm() {
	console.log("C. short interval + long turn does not storm");
	const h = makeHarness(cfg, { turnMs: 40 });
	h.scheduler.add(fixed(10)); // interval << turn
	await sleep(150);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 2 && h.calls.length <= 6, `bounded by turn duration, not interval (got ${h.calls.length})`);
	assert(h.overlaps === 0, `no overlap despite tight interval (overlaps=${h.overlaps})`);
}

// D: self-paced backs off and re-arms after each turn ends; no overlap.
async function testSelfPaced() {
	console.log("D. self-paced backs off across turns");
	const h = makeHarness(cfg, { turnMs: 6 });
	h.scheduler.add(selfPaced());
	await sleep(160);
	h.scheduler.disposeAll();
	assert(h.calls.length >= 2, `fired at least twice (got ${h.calls.length})`);
	assert(h.overlaps === 0, `no overlap (overlaps=${h.overlaps})`);
	assert(h.badDelivery === 0, `every send used deliverAs:followUp (bad=${h.badDelivery})`);
}

// E: max limit refuses extra loops.
async function testMax() {
	console.log("E. max concurrent loops enforced");
	const h = makeHarness({ ...cfg, max: 2 });
	const r1 = h.scheduler.add(fixed(1000));
	const r2 = h.scheduler.add(fixed(1000));
	const r3 = h.scheduler.add(fixed(1000));
	assert(r1.ok && r2.ok, "first two accepted");
	assert(!r3.ok, "third refused");
	assert(h.scheduler.size() === 2, `size capped at 2 (got ${h.scheduler.size()})`);
	h.scheduler.disposeAll();
}

// F: stop cancels timers (no further fires).
async function testStop() {
	console.log("F. stop cancels timers");
	const h = makeHarness(cfg, { turnMs: 6 });
	h.scheduler.add(fixed(20));
	const n = h.scheduler.stop("all");
	assert(n === 1, "stop('all') reports one stopped");
	await sleep(70);
	assert(h.calls.length === 0, `no fires after stop (got ${h.calls.length})`);
}

await testFixedRepeats();
await testCollapse();
await testNoStorm();
await testSelfPaced();
await testMax();
await testStop();

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
