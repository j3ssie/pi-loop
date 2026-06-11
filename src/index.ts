/**
 * pi-loop — a /loop slash command for the Pi coding agent.
 *
 * Re-runs a prompt (or the default maintenance prompt) on an interval inside the current
 * session — "agentic cron for the session you already have open". Fires between turns,
 * never mid-response, and dies with the session.
 *
 *   /loop 5m check the deploy and summarize what changed   (fixed interval)
 *   /loop check whether CI passed and fix new comments      (self-paced)
 *   /loop            /  /loop 15m                            (default maintenance prompt)
 *   /loop --watch ./runs triage new findings                 (file or directory watch)
 *   /loop --each ./todo.txt fix the lint: {item}             (worklist)
 *   /loop 1m --cmd "gh pr checks 123" --on-change …          (command output loop)
 *   /loop --at 09:00 give me a standup summary               (daily clock time)
 *   /loop-list  /  /loop-stop  /  /loop-pause  /  /loop-resume  /  /loop-now
 *
 * Place at .pi/extensions/loop/index.ts (project) or ~/.pi/agent/extensions/loop/index.ts
 * (global), or run with: pi -e ./src/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_INTERVAL, parseInterval, parseLoopArgs } from "./parse.js";
import { loadDefaultPrompt } from "./defaultPrompt.js";
import { resolveSlashTarget } from "./slash.js";
import { statSafe, readItems } from "./fileutil.js";
import { LoopScheduler } from "./scheduler.js";

const DAY_MS = 86_400_000;

/** registerFlag only supports "boolean" | "string"; numeric flags are stored as strings. */
function numberFlag(pi: ExtensionAPI, name: string, fallback: number): number {
	const n = Number(pi.getFlag(name) ?? fallback);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read a duration flag (e.g. "1m") as milliseconds, falling back if unset/unparseable. */
function durationFlag(pi: ExtensionAPI, name: string, fallbackMs: number): number {
	const raw = pi.getFlag(name);
	return (typeof raw === "string" ? parseInterval(raw)?.ms : undefined) ?? fallbackMs;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("loop-max", { type: "string", default: "50", description: "Max concurrent loops in a session" });
	pi.registerFlag("loop-default-interval", { type: "string", default: DEFAULT_INTERVAL, description: "Interval used by bare /loop" });
	pi.registerFlag("loop-expiry-days", { type: "string", default: "7", description: "Days before a loop expires" });
	pi.registerFlag("loop-self-min", { type: "string", default: "1m", description: "Self-paced minimum delay" });
	pi.registerFlag("loop-self-max", { type: "string", default: "1h", description: "Self-paced maximum delay" });
	pi.registerFlag("loop-watch-interval", { type: "string", default: "1s", description: "How often --watch polls a file for changes" });
	pi.registerFlag("loop-watch-dir-interval", { type: "string", default: "2s", description: "How often --watch rescans a directory (a full tree walk)" });
	pi.registerFlag("loop-file-max-kb", { type: "string", default: "16", description: "Max KB of file/command contents injected into prompts" });
	pi.registerFlag("loop-cmd-timeout", { type: "string", default: "30s", description: "Timeout for --cmd command runs" });
	pi.registerFlag("loop-steer-hint", { type: "boolean", default: false, description: "Append a NEXT:/LOOP: steering hint to loop-fired prompts (off by default — literal models may misread `LOOP: done` as task completion)" });

	const scheduler = new LoopScheduler(pi, {
		max: numberFlag(pi, "loop-max", 50),
		expiryMs: numberFlag(pi, "loop-expiry-days", 7) * DAY_MS,
		selfMin: durationFlag(pi, "loop-self-min", 60_000),
		selfMax: durationFlag(pi, "loop-self-max", 3_600_000),
		watchPollMs: durationFlag(pi, "loop-watch-interval", 1_000),
		watchDirPollMs: durationFlag(pi, "loop-watch-dir-interval", 2_000),
		fileMaxBytes: numberFlag(pi, "loop-file-max-kb", 16) * 1024,
		cmdTimeoutMs: durationFlag(pi, "loop-cmd-timeout", 30_000),
		steerHint: pi.getFlag("loop-steer-hint") === true,
	});

	pi.registerCommand("loop", {
		description: "Re-run a prompt on an interval in this session (agentic cron).",
		getArgumentCompletions: (prefix) =>
			["5m", "10m", "15m", "30m", "1h", "--watch", "--each", "--file", "--cmd", "--at", "--times", "--batch", "--on-change"]
				.filter((s) => s.startsWith(prefix))
				.map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const defaultInterval = String(pi.getFlag("loop-default-interval") ?? DEFAULT_INTERVAL);
			const parsed = parseLoopArgs(args, defaultInterval, loadDefaultPrompt(ctx.cwd));
			if (!parsed.ok) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			const spec = parsed.spec;

			// A /slash target: remember skills for fire-time re-expansion; refuse what the
			// public API can't run. Only the text-prompt kinds carry isSlash; file modes
			// treat the prompt as a template.
			if ((spec.kind === "fixed" || spec.kind === "selfPaced" || spec.kind === "at") && spec.isSlash) {
				const resolved = resolveSlashTarget(pi, ctx.cwd, spec.prompt);
				if (resolved.kind === "unsupported") {
					ctx.ui.notify(resolved.reason, "warning");
					return;
				}
				if (resolved.kind === "skill") {
					spec.prompt = resolved.text; // snapshot fallback; re-expanded at fire time
					spec.skill = { name: resolved.name, args: resolved.args };
					spec.isSlash = false;
				}
				// "literal": leave the slash text as-is (sent verbatim to the model).
			}

			// Creation-time path checks — catch typos now instead of looping on a ghost file.
			if (spec.kind === "each") {
				if (!statSafe(spec.file)) {
					ctx.ui.notify(`Worklist file not found: ${spec.file}`, "warning");
					return;
				}
				if (readItems(spec.file).length === 0) {
					ctx.ui.notify(`Worklist file has no items (blank lines and # comments are skipped): ${spec.file}`, "warning");
					return;
				}
			} else if ((spec.kind === "watch" || spec.kind === "fileInterval") && !statSafe(spec.file)) {
				const note =
					spec.kind === "watch"
						? `${spec.file} doesn't exist yet — watching for it to appear.`
						: `${spec.file} doesn't exist yet — fires will say "(file not found)" until it does.`;
				ctx.ui.notify(note, "warning");
			}

			const result = scheduler.add(spec);
			if (!result.ok) {
				ctx.ui.notify(result.reason, "warning");
				return;
			}
			scheduler.renderWidget(ctx);
			ctx.ui.notify(`Loop ${result.id} started (${result.cadence}). Stop with /loop-stop ${result.id}.`, "info");
		},
	});

	pi.registerCommand("loop-list", {
		description: "List active loops in this session.",
		handler: async (_args, ctx) => {
			const loops = scheduler.list();
			if (loops.length === 0) {
				ctx.ui.notify("No active loops.", "info");
				return;
			}
			const lines = loops.map((l) => {
				const ran = l.fireCount > 0 ? ` · ran ${l.fireCount}×` : "";
				return `${l.id} · ${l.label} · ${l.when} · ${l.detail}${ran}`;
			});
			ctx.ui.notify(`Active loops (${loops.length}):\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("loop-stop", {
		description: "Stop a loop by id, or all loops with 'all'.",
		getArgumentCompletions: () =>
			["all", ...scheduler.ids()].map((v) => ({ value: v, label: v === "all" ? "all (stop everything)" : v })),
		handler: async (args, ctx) => {
			const target = args.trim() || "all";
			const stopped = scheduler.stop(target);
			scheduler.renderWidget(ctx);
			if (stopped > 0) ctx.ui.notify(`Stopped ${stopped} loop${stopped > 1 ? "s" : ""}.`, "info");
			else ctx.ui.notify(target === "all" ? "No active loops to stop." : `No loop with id ${target}.`, "warning");
		},
	});

	pi.registerCommand("loop-pause", {
		description: "Pause a loop by id (or all loops) without losing its progress.",
		getArgumentCompletions: () =>
			["all", ...scheduler.ids()].map((v) => ({ value: v, label: v === "all" ? "all (pause everything)" : v })),
		handler: async (args, ctx) => {
			const target = args.trim() || "all";
			const paused = scheduler.pause(target);
			scheduler.renderWidget(ctx);
			if (paused > 0) ctx.ui.notify(`Paused ${paused} loop${paused > 1 ? "s" : ""}. Resume with /loop-resume.`, "info");
			else ctx.ui.notify(target === "all" ? "No loops to pause." : `No running loop with id ${target}.`, "warning");
		},
	});

	pi.registerCommand("loop-resume", {
		description: "Resume a paused loop by id, or all paused loops.",
		getArgumentCompletions: () =>
			["all", ...scheduler.ids()].map((v) => ({ value: v, label: v === "all" ? "all (resume everything)" : v })),
		handler: async (args, ctx) => {
			const target = args.trim() || "all";
			const resumed = scheduler.resume(target);
			scheduler.renderWidget(ctx);
			if (resumed > 0) ctx.ui.notify(`Resumed ${resumed} loop${resumed > 1 ? "s" : ""}.`, "info");
			else ctx.ui.notify(target === "all" ? "No paused loops." : `No paused loop with id ${target}.`, "warning");
		},
	});

	pi.registerCommand("loop-now", {
		description: "Fire a loop immediately (as soon as the agent is idle).",
		getArgumentCompletions: () => scheduler.ids().map((v) => ({ value: v, label: v })),
		handler: async (args, ctx) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /loop-now <id>", "warning");
				return;
			}
			if (scheduler.fireNow(id)) {
				scheduler.renderWidget(ctx);
				ctx.ui.notify(`Loop ${id} will fire as soon as the agent is idle.`, "info");
			} else {
				ctx.ui.notify(`No running loop with id ${id} (paused loops need /loop-resume first).`, "warning");
			}
		},
	});

	// Restore persisted loops on reload/resume; render the widget; clear timers on shutdown.
	pi.on("session_start", async (event, ctx) => {
		scheduler.restore(ctx, event.reason);
		scheduler.renderWidget(ctx);
	});
	pi.on("session_shutdown", async () => {
		scheduler.disposeAll();
	});

	// Idle tracking so loops fire between turns, never mid-response. The final messages are
	// passed along so a loop-fired turn can steer its own loop (NEXT: / LOOP: sentinels).
	pi.on("agent_start", async () => {
		scheduler.setBusy(true);
	});
	pi.on("agent_end", async (event) => {
		scheduler.setBusy(false);
		scheduler.onAgentEnd(event.messages);
	});
}
