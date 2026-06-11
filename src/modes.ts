/**
 * Per-mode behavior for the LoopScheduler.
 *
 * Each loop kind implements ModeHandler<K> — generic over its own spec kind, so handlers see
 * a narrowed `task.spec` and need no `if (kind !== X)` guards. The scheduler owns only the
 * generic machinery (idle-gating, fairness, sentinels, persistence, widget) and delegates
 * everything kind-specific here. Adding a mode = adding one handler to MODES, nothing else.
 *
 * Trigger model: `eng.arm(task, delayMs)` schedules the handler's `onTimer` (default:
 * arm a pending fire via `eng.trigger`). Watch loops use a poller instead of a timer
 * (a slower cadence for directories, where each tick rescans the tree).
 * `buildPrompt` resolves the message at fire time — file contents, worklist items,
 * default prompts (loop.md) and skill expansions are all re-read so edits apply to the
 * next iteration, never a stale snapshot.
 */

import { exec } from "node:child_process";
import { basename } from "node:path";
import type { LoopSpec } from "./parse.js";
import { loadDefaultPrompt } from "./defaultPrompt.js";
import { expandSkill } from "./slash.js";
import { capBytes, hashText, injectCmd, injectFile, readCapped, readItems, scanDir, selectPending, statSafe } from "./fileutil.js";

export interface LoopConfig {
	max: number;
	expiryMs: number;
	selfMin: number;
	selfMax: number;
	watchPollMs?: number;
	/** Directories are rescanned each tick (expensive), so they poll on a slower cadence. */
	watchDirPollMs?: number;
	fileMaxBytes?: number;
	cmdTimeoutMs?: number;
	/** How long after a send to wait for agent_start before assuming the turn was lost. */
	watchdogMs?: number;
	/** Append a one-line NEXT:/LOOP: steering hint to loop-fired prompts. */
	steerHint?: boolean;
}

export const DEFAULTS = {
	watchPollMs: 1_000,
	watchDirPollMs: 2_000,
	fileMaxBytes: 16 * 1024,
	cmdTimeoutMs: 30_000,
	watchdogMs: 30_000,
} as const;

export interface Task {
	id: string;
	spec: LoopSpec;
	timer?: ReturnType<typeof setTimeout>;
	poller?: ReturnType<typeof setInterval>;
	/** watch (file): last seen mtime/size. */
	lastMtimeMs?: number;
	lastSize?: number;
	/** watch (directory): last scan signature, and the path that changed. */
	watchIsDir?: boolean;
	watchSig?: string;
	changedPath?: string;
	/** cmd: output captured at trigger time, consumed by the fire. */
	cmdOutput?: string;
	/** --on-change dedupe fingerprint (fileInterval/cmd). */
	lastHash?: string;
	/** each: items sent in the last fire (consumed by LOOP: retry). */
	lastBatch?: string[];
	/** Trigger fired; waiting for the agent to be idle before sending. */
	pending: boolean;
	/** When the trigger fired — flush() releases the oldest first (FIFO-fair). */
	pendingSince?: number;
	/** Paced kinds (selfPaced/each): fired, waiting for the turn to end before re-arming. */
	awaitingTurn: boolean;
	paused: boolean;
	createdAt: number;
	expiresAt: number;
	nextDelayMs: number;
	/** Wall-clock time the armed timer is expected to fire (for the live countdown). */
	nextFireAt?: number;
	fireCount: number;
	lastFiredAt?: number;
}

/** A Task whose spec is narrowed to a single kind K. */
export type TaskOf<K extends LoopSpec["kind"]> = Task & { spec: Extract<LoopSpec, { kind: K }> };
type SpecOf<K extends LoopSpec["kind"]> = Extract<LoopSpec, { kind: K }>;

/** Services the scheduler exposes to mode handlers. */
export interface ModeEngine {
	readonly cfg: LoopConfig;
	cwd(): string;
	/** Schedule the handler's onTimer (or the default pending-fire) after delayMs. */
	arm(task: Task, delayMs: number): void;
	/** Arm a pending fire now (released when the agent is idle). */
	trigger(task: Task): void;
	/** Is this task still registered (guards async callbacks racing a stop)? */
	active(task: Task): boolean;
	persist(): void;
}

/** What buildPrompt returns: a message to send, "skip" (re-arm without firing), or null (exhausted — stop). */
export type PromptResult = string | "skip" | null;

export interface ModeHandler<K extends LoopSpec["kind"]> {
	/** Arm the initial trigger (timer or poller). Also used on resume. */
	start(task: TaskOf<K>, eng: ModeEngine): void;
	/** What an armed timer does when it fires. Default (undefined): eng.trigger. */
	onTimer?(task: TaskOf<K>, eng: ModeEngine): void;
	/** Resolve the message at fire time. */
	buildPrompt(task: TaskOf<K>, eng: ModeEngine): PromptResult;
	/** After a successful send (or a "skip"), schedule the next trigger. */
	postFire(task: TaskOf<K>, eng: ModeEngine): void;
	/** Human cadence for the "loop started" notification. */
	cadence(spec: SpecOf<K>): string;
	/** Short kind label for the widget. */
	label(spec: SpecOf<K>): string;
	/** Widget detail line; `short` ellipsizes. */
	detail(task: TaskOf<K>, short: (s: string) => string): string;
	/** Widget status while waiting; undefined = generic countdown. */
	when?(task: TaskOf<K>): string | undefined;
	/** Notification when buildPrompt returns null (loop exhausted). */
	completeNote?(task: TaskOf<K>): string;
}

const fileMax = (cfg: LoopConfig) => cfg.fileMaxBytes ?? DEFAULTS.fileMaxBytes;

/**
 * Resolve prompt text at fire time: skill targets are re-expanded and default prompts
 * re-read from loop.md, so edits apply to the next iteration. Falls back to the snapshot
 * captured at creation when re-resolution fails.
 */
function resolveText(spec: { prompt: string; usesDefaultPrompt?: boolean; skill?: { name: string; args: string } }, eng: ModeEngine): string {
	if (spec.skill) {
		const r = expandSkill(eng.cwd(), spec.skill.name, spec.skill.args);
		if (r.kind === "skill") return r.text;
	}
	if (spec.usesDefaultPrompt) return loadDefaultPrompt(eng.cwd());
	return spec.prompt;
}

function resolveTemplate(spec: { promptTemplate: string; usesDefaultPrompt?: boolean }, eng: ModeEngine): string {
	return spec.usesDefaultPrompt ? loadDefaultPrompt(eng.cwd()) : spec.promptTemplate;
}

/** Milliseconds until the next daily occurrence of "HH:MM" local time. */
export function msUntilDaily(time: string, from = new Date()): number {
	const [h, m] = time.split(":").map(Number);
	const next = new Date(from);
	next.setHours(h!, m!, 0, 0);
	if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
	return next.getTime() - from.getTime();
}

const fixed: ModeHandler<"fixed"> = {
	start: (task, eng) => eng.arm(task, task.spec.intervalMs),
	buildPrompt: (task, eng) => resolveText(task.spec, eng),
	postFire: (task, eng) => eng.arm(task, task.spec.intervalMs),
	cadence: (spec) => `every ${spec.intervalLabel}`,
	label: (spec) => `every ${spec.intervalLabel}`,
	detail: (task, short) => short(task.spec.prompt),
};

const selfPaced: ModeHandler<"selfPaced"> = {
	start: (task, eng) => eng.arm(task, eng.cfg.selfMin),
	buildPrompt: (task, eng) => resolveText(task.spec, eng),
	// Re-armed by the scheduler on agent_end (backoff doubling or a NEXT: override).
	postFire: (task) => {
		task.awaitingTurn = true;
	},
	cadence: () => "self-paced",
	label: () => "self-paced",
	detail: (task, short) => short(task.spec.prompt),
};

const at: ModeHandler<"at"> = {
	start: (task, eng) => eng.arm(task, msUntilDaily(task.spec.time)),
	buildPrompt: (task, eng) => resolveText(task.spec, eng),
	postFire: (task, eng) => eng.arm(task, msUntilDaily(task.spec.time)),
	cadence: (spec) => `daily at ${spec.time}`,
	label: (spec) => `daily ${spec.time}`,
	detail: (task, short) => short(task.spec.prompt),
};

const watch: ModeHandler<"watch"> = {
	start: (task, eng) => {
		const file = task.spec.file;
		// Baseline: only fire on *subsequent* changes.
		const initial = statSafe(file);
		task.watchIsDir = initial?.isDir ?? false;
		if (task.watchIsDir) {
			task.watchSig = scanDir(file).signature;
		} else {
			task.lastMtimeMs = initial?.mtimeMs;
			task.lastSize = initial?.size;
		}
		// Directories rescan the whole tree each tick, so they poll on a slower cadence.
		const pollMs = task.watchIsDir ? (eng.cfg.watchDirPollMs ?? DEFAULTS.watchDirPollMs) : (eng.cfg.watchPollMs ?? DEFAULTS.watchPollMs);
		const poll = setInterval(() => {
			const s = statSafe(file);
			if (!s) return; // path missing; keep watching for it to (re)appear
			if (s.isDir) {
				task.watchIsDir = true;
				const scan = scanDir(file);
				if (scan.signature !== task.watchSig) {
					task.watchSig = scan.signature;
					task.changedPath = scan.latest;
					eng.trigger(task);
				}
				return;
			}
			task.watchIsDir = false;
			if (s.mtimeMs !== task.lastMtimeMs || s.size !== task.lastSize) {
				task.lastMtimeMs = s.mtimeMs;
				task.lastSize = s.size;
				task.changedPath = file;
				eng.trigger(task);
			}
		}, pollMs);
		poll.unref?.();
		task.poller = poll;
	},
	buildPrompt: (task, eng) => {
		const target = task.watchIsDir ? task.changedPath : task.spec.file;
		if (!target) return "skip"; // directory event with no identifiable file
		return injectFile(target, readCapped(target, fileMax(eng.cfg)), resolveText(task.spec, eng));
	},
	postFire: () => {}, // the poller drives the next fire
	cadence: (spec) => `watching ${spec.file}`,
	label: () => "watch",
	detail: (task, short) => {
		const name = basename(task.spec.file) + (task.watchIsDir ? "/" : "");
		return `${name} → ${short(task.spec.prompt)}`;
	},
	when: (task) => (task.pending ? "changed" : task.awaitingTurn ? undefined : "watching"),
};

const each: ModeHandler<"each"> = {
	start: (task, eng) => eng.arm(task, task.spec.delayMs),
	buildPrompt: (task) => {
		const spec = task.spec;
		const remaining = selectPending(readItems(spec.file), spec.done);
		if (remaining.length === 0) return null; // exhausted
		const take = remaining.slice(0, Math.max(1, spec.batch ?? 1));
		task.lastBatch = take;
		const index = spec.done.length;
		const body = take.join("\n");
		const tpl = spec.promptTemplate;
		if (tpl.includes("{item}") || tpl.includes("{index}")) {
			return tpl.replaceAll("{item}", body).replaceAll("{index}", String(index));
		}
		return take.length === 1
			? `${tpl}\n\n<item index="${index}">\n${body}\n</item>`
			: `${tpl}\n\n<items start="${index}" count="${take.length}">\n${body}\n</items>`;
	},
	// Mark items done at send time; LOOP: retry pulls them back out. Re-armed on agent_end.
	postFire: (task, eng) => {
		task.spec.done.push(...(task.lastBatch ?? []));
		eng.persist(); // progress survives reload
		task.awaitingTurn = true;
	},
	cadence: (spec) => `worklist over ${spec.file}`,
	label: () => "worklist",
	detail: (task, short) => `${basename(task.spec.file)}[${task.spec.done.length}] → ${short(task.spec.promptTemplate)}`,
	completeNote: (task) => `Worklist ${task.spec.file} complete (${task.spec.done.length} items).`,
};

const fileInterval: ModeHandler<"fileInterval"> = {
	start: (task, eng) => eng.arm(task, task.spec.intervalMs),
	buildPrompt: (task, eng) => {
		const spec = task.spec;
		const contents = readCapped(spec.file, fileMax(eng.cfg));
		if (spec.onChange) {
			const h = hashText(contents);
			if (h === task.lastHash) return "skip"; // unchanged since the last fire
			task.lastHash = h;
		}
		return injectFile(spec.file, contents, resolveTemplate(spec, eng));
	},
	postFire: (task, eng) => eng.arm(task, task.spec.intervalMs),
	cadence: (spec) => `every ${spec.intervalLabel} over ${spec.file}`,
	label: (spec) => `every ${spec.intervalLabel}`,
	detail: (task, short) => `${basename(task.spec.file)} → ${short(task.spec.promptTemplate)}`,
};

const cmd: ModeHandler<"cmd"> = {
	start: (task, eng) => eng.arm(task, task.spec.intervalMs),
	// Timer fires -> run the command async; only arm a pending fire once output is captured.
	onTimer: (task, eng) => {
		const spec = task.spec;
		exec(
			spec.command,
			{ timeout: eng.cfg.cmdTimeoutMs ?? DEFAULTS.cmdTimeoutMs, maxBuffer: 4 * 1024 * 1024, cwd: eng.cwd() },
			(err, stdout, stderr) => {
				if (!eng.active(task)) return; // stopped while the command ran
				let out = String(stdout ?? "").trim();
				const errText = String(stderr ?? "").trim();
				if (errText) out = out ? `${out}\n[stderr]\n${errText}` : `[stderr]\n${errText}`;
				if (err) out = `${out ? `${out}\n` : ""}[exit: ${typeof err.code === "number" ? err.code : "killed/timeout"}]`;
				if (!out) out = "(no output)";
				out = capBytes(out, fileMax(eng.cfg));
				if (spec.onChange) {
					const h = hashText(out);
					if (h === task.lastHash) {
						eng.arm(task, spec.intervalMs); // unchanged -> skip this round
						return;
					}
					task.lastHash = h;
				}
				task.cmdOutput = out;
				eng.trigger(task);
			},
		);
	},
	buildPrompt: (task) => injectCmd(task.spec.command, task.cmdOutput ?? "(no output)", task.spec.promptTemplate),
	postFire: (task, eng) => eng.arm(task, task.spec.intervalMs),
	cadence: (spec) => `every ${spec.intervalLabel} · $ ${spec.command}`,
	label: (spec) => `every ${spec.intervalLabel}`,
	detail: (task, short) => `$ ${short(task.spec.command)} → ${short(task.spec.promptTemplate)}`,
};

export const MODES: { [K in LoopSpec["kind"]]: ModeHandler<K> } = {
	fixed,
	selfPaced,
	at,
	watch,
	each,
	fileInterval,
	cmd,
};

/** A handler whose methods accept any Task/LoopSpec — what the scheduler dispatches through. */
export type AnyMode = ModeHandler<LoopSpec["kind"]>;

/**
 * Look up the handler for a runtime kind. The cast is the one place the K↔Task pairing is
 * unchecked; it is sound because the scheduler only ever calls a handler with its own kind's task.
 */
export function modeFor(kind: LoopSpec["kind"]): AnyMode {
	return MODES[kind] as unknown as AnyMode;
}
