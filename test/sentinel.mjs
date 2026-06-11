// Tests loop-control sentinel parsing (NEXT:/LOOP: lines in the final assistant message).
// Run: node test/sentinel.mjs   (after `npx tsc` has produced dist/)
import { finalAssistantText, parseControls } from "../src/sentinel.ts";

let failures = 0;
const assert = (cond, msg) => {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
};

console.log("parseControls");
{
	assert(parseControls("all quiet, nothing to do") === undefined, "no sentinel -> undefined");

	const next = parseControls("CI is still running.\nNEXT: 20m");
	assert(next?.nextMs === 1200000 && next.nextLabel === "20m", "NEXT: 20m -> 20 minutes");

	assert(parseControls("Everything merged.\nLOOP: done")?.stop === true, "LOOP: done -> stop");
	assert(parseControls("LOOP: stop")?.stop === true, "LOOP: stop -> stop");
	assert(parseControls("loop: NOW")?.now === true, "case-insensitive LOOP: now");
	assert(parseControls("  LOOP: retry  ")?.retry === true, "whitespace-tolerant LOOP: retry");

	const both = parseControls("status ok\nNEXT: 5m\nLOOP: now");
	assert(both?.now === true && both.nextMs === 300000, "multiple control lines all collected");

	assert(parseControls("I will print LOOP: done when finished") === undefined, "mid-line mention is not a control");
	assert(parseControls("NEXT: whenever") === undefined, "NEXT with unparseable interval ignored");
}

console.log("finalAssistantText");
{
	const messages = [
		{ role: "user", content: "tick" },
		{ role: "assistant", content: [{ type: "text", text: "first reply" }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool noise LOOP: done" }] },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "LOOP: done (should be ignored)" },
				{ type: "text", text: "all finished" },
				{ type: "text", text: "LOOP: done" },
			],
		},
	];
	const text = finalAssistantText(messages);
	assert(text === "all finished\nLOOP: done", "joins text blocks of the LAST assistant message only");
	assert(parseControls(text)?.stop === true, "end-to-end: messages -> stop control");
	assert(finalAssistantText([{ role: "user", content: "hi" }]) === "", "no assistant message -> empty string");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
