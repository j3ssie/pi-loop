/**
 * Loop-control sentinels — how the agent steers its own loop.
 *
 * After a loop-fired turn ends, the final assistant message is scanned for control lines
 * (each on its own line, case-insensitive):
 *
 *   NEXT: 20m     set the delay before this loop's next run
 *   LOOP: done    stop the loop ("LOOP: stop" also accepted)
 *   LOOP: now     run again immediately (as soon as the agent is idle)
 *   LOOP: retry   worklist loops: re-run the current item(s) instead of advancing
 *
 * Controls only apply to the loop that initiated the turn — a user-typed turn that happens
 * to contain "LOOP: done" affects nothing, because no loop is attributed to it.
 */

import { parseInterval } from "./parse.js";

export interface LoopControl {
	stop?: boolean;
	now?: boolean;
	retry?: boolean;
	nextMs?: number;
	nextLabel?: string;
}

/** Extract the text blocks of the last assistant message from an agent_end `messages` array. */
export function finalAssistantText(messages: unknown[]): string {
	let last: { content?: unknown } | undefined;
	for (const m of messages) {
		const msg = m as { role?: string; content?: unknown };
		if (msg?.role === "assistant") last = msg;
	}
	if (!last || !Array.isArray(last.content)) return "";
	return last.content
		.filter((c): c is { type: string; text: string } => (c as { type?: string })?.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/** Parse control lines out of an assistant message. Returns undefined when none are present. */
export function parseControls(text: string): LoopControl | undefined {
	let ctl: LoopControl | undefined;
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*(LOOP|NEXT)\s*:\s*(.+?)\s*$/i.exec(line);
		if (!m) continue;
		const arg = m[2]!.toLowerCase();
		if (m[1]!.toUpperCase() === "NEXT") {
			const iv = parseInterval(arg);
			if (iv) ctl = { ...ctl, nextMs: iv.ms, nextLabel: iv.label };
		} else if (arg === "done" || arg === "stop") {
			ctl = { ...ctl, stop: true };
		} else if (arg === "now") {
			ctl = { ...ctl, now: true };
		} else if (arg === "retry") {
			ctl = { ...ctl, retry: true };
		}
	}
	return ctl;
}
