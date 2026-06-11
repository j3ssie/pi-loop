// Tests the live widget: countdown text + ticker start/stop lifecycle.
// Run: node test/widget.mjs   (after `npx tsc` has produced dist/)
import { LoopScheduler } from "../src/scheduler.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const assert = (cond, msg) => {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
};

const cfg = { max: 50, expiryMs: 7 * 86_400_000, selfMin: 20, selfMax: 200 };
const fixed = (ms, label, prompt = "echo tick") => ({ kind: "fixed", intervalMs: ms, intervalLabel: label, prompt, isSlash: false });

function makeCtx() {
	const widget = [];
	const status = [];
	return {
		ctx: { hasUI: true, ui: { setWidget: (_k, v) => widget.push(v), setStatus: (_k, v) => status.push(v) } },
		widget,
		status,
	};
}
const fakePi = { sendUserMessage: () => {}, appendEntry: () => {} };

console.log("live widget");

// Countdown text + status, and the ticker updates it over time.
{
	const { ctx, widget, status } = makeCtx();
	const s = new LoopScheduler(fakePi, cfg);
	s.add(fixed(5000, "5s"));
	s.renderWidget(ctx);

	const first = widget.at(-1);
	assert(Array.isArray(first) && first.length === 1, "widget has one line");
	assert(/◷ \w+ · every 5s · next in \ds · echo tick/.test(first[0]), `line shows countdown (got: ${first[0]})`);
	assert(status.at(-1) === "◷ 1 loop", `status shows count (got: ${status.at(-1)})`);

	const countAfterRender = widget.length;
	await sleep(1100); // ticker should redraw at least once
	assert(widget.length > countAfterRender, "ticker redrew the widget after ~1s");

	const secs = (line) => Number(/next in (\d+)s/.exec(line[0])?.[1]);
	assert(secs(widget.at(-1)) < secs(first), `countdown decreased (${secs(first)}s -> ${secs(widget.at(-1))}s)`);

	// Stopping the last loop clears the widget and stops the ticker.
	s.stop("all");
	s.renderWidget(ctx);
	assert(widget.at(-1) === undefined, "widget cleared when no loops remain");
	const afterStop = widget.length;
	await sleep(1100);
	assert(widget.length === afterStop, "ticker stopped after the last loop was removed");

	s.disposeAll();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
