/**
 * LoopScheduler — the engine behind /loop.
 *
 * Core rule: fire only when the agent is idle, and collapse missed fires.
 * Triggers never fire a prompt directly; they only *arm a pending fire*. The fire is
 * *released* when the agent goes idle (tracked via agent_start/agent_end). This gives,
 * for free, the three Claude-Code semantics we want:
 *   - fires between turns, never mid-response
 *   - multiple triggers during a long turn collapse to a single fire (no storm)
 *   - timers/watchers are session-local and die with the session
 *
 * Everything kind-specific (what arms the trigger, what message to build, how to re-arm)
 * lives in the per-mode handlers in modes.ts. The scheduler owns the generic machinery:
 *   - FIFO fairness: when several loops are pending, the one waiting longest fires first,
 *     so a tight loop can never starve a slow one
 *   - sentinels: after a loop-fired turn, the final assistant message may steer the loop
 *     (NEXT: 20m / LOOP: done / LOOP: now / LOOP: retry) — applied only to the loop that
 *     initiated the turn
 *   - a watchdog that clears a stuck inFlight if a send never becomes a turn
 *   - expiry (checked at fire time and swept periodically), --times limits, pause/resume
 *   - persistence across /reload and --resume via appendEntry
 *
 * Crash-safety: every send uses `sendUserMessage(prompt, { deliverAs: "followUp" })`, which
 * starts a fresh turn when idle and safely queues if we race a still-streaming turn instead
 * of throwing "Agent is already processing". An `inFlight` guard keeps one outstanding fire.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoopSpec } from "./parse.js";
import { DEFAULTS, modeFor, type AnyMode, type LoopConfig, type ModeEngine, type Task } from "./modes.js";
import { finalAssistantText, parseControls } from "./sentinel.js";
import { readItems } from "./fileutil.js";

/** One-line steering hint appended to loop-fired prompts (skipped if the prompt already teaches it). */
const STEER_HINT =
	"\n\n— Automated loop turn. You can steer it: end your reply with `LOOP: done` to stop, " +
	"`LOOP: now` to run again immediately, or `NEXT: <duration>` (e.g. NEXT: 20m) to set the next delay.";

/** Throttle window for coalescing persistence writes. */
const PERSIST_THROTTLE_MS = 1_000;

export type { LoopConfig, Task } from "./modes.js";

interface PersistedTask {
	id: string;
	spec: LoopSpec;
	createdAt: number;
	expiresAt: number;
	fireCount?: number;
	lastFiredAt?: number;
	paused?: boolean;
}

interface Snapshot {
	tasks: PersistedTask[];
}

export interface LoopInfo {
	id: string;
	kind: LoopSpec["kind"];
	label: string;
	when: string;
	detail: string;
	fireCount: number;
	paused: boolean;
}

export type AddResult = { ok: true; id: string; cadence: string } | { ok: false; reason: string };

const SWEEP_MS = 60_000;

function clamp(n: number, lo: number, hi: number): number {
	return Math.min(Math.max(n, lo), hi);
}

/** Compact countdown: 45s, 12m, 3h. */
function humanize(ms: number): string {
	const s = Math.max(0, Math.ceil(ms / 1000));
	if (s < 100) return `${s}s`;
	const m = Math.ceil(s / 60);
	if (m < 100) return `${m}m`;
	return `${Math.ceil(m / 60)}h`;
}

export class LoopScheduler {
	private readonly tasks = new Map<string, Task>();
	private agentBusy = false;
	private inFlight = false;
	/** Task whose fire started the turn currently in flight — sentinel attribution. */
	private lastFiredId?: string;
	private seq = 0;
	private ticker?: ReturnType<typeof setInterval>;
	private sweeper?: ReturnType<typeof setInterval>;
	private watchdog?: ReturnType<typeof setTimeout>;
	private persistTimer?: ReturnType<typeof setTimeout>;
	private persistDirty = false;
	private ctx?: ExtensionContext;
	private readonly eng: ModeEngine;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly cfg: LoopConfig,
	) {
		this.eng = {
			cfg,
			cwd: () => this.ctx?.cwd ?? process.cwd(),
			arm: (task, delayMs) => this.armTask(task, delayMs),
			trigger: (task) => this.triggerTask(task),
			active: (task) => this.tasks.get(task.id) === task,
			persist: () => this.persist(),
		};
	}

	setBusy(busy: boolean): void {
		this.agentBusy = busy;
		if (busy) {
			this.clearWatchdog();
		} else {
			this.inFlight = false;
			queueMicrotask(() => this.flush());
		}
	}

	private idle(): boolean {
		return !this.agentBusy && !this.inFlight;
	}

	add(spec: LoopSpec): AddResult {
		if (this.tasks.size >= this.cfg.max) {
			return { ok: false, reason: `Max ${this.cfg.max} loops reached. Stop one with /loop-stop.` };
		}
		const now = Date.now();
		const id = (++this.seq).toString(36).padStart(4, "0");
		const task: Task = {
			id,
			spec,
			pending: false,
			awaitingTurn: false,
			paused: false,
			createdAt: now,
			expiresAt: now + this.cfg.expiryMs,
			nextDelayMs: 0,
			fireCount: 0,
		};
		this.tasks.set(id, task);
		modeFor(spec.kind).start(task, this.eng);
		this.persist();
		this.syncSweep();
		return { ok: true, id, cadence: modeFor(spec.kind).cadence(spec) };
	}

	stop(idOrAll: string): number {
		const ids = idOrAll === "all" ? [...this.tasks.keys()] : [idOrAll];
		let stopped = 0;
		for (const id of ids) {
			const task = this.tasks.get(id);
			if (!task) continue;
			this.cancelTimers(task);
			this.tasks.delete(id);
			stopped++;
		}
		if (stopped) this.persist();
		this.syncSweep();
		return stopped;
	}

	pause(idOrAll: string): number {
		const ids = idOrAll === "all" ? [...this.tasks.keys()] : [idOrAll];
		let paused = 0;
		for (const id of ids) {
			const task = this.tasks.get(id);
			if (!task || task.paused) continue;
			this.cancelTimers(task);
			task.paused = true;
			task.pending = false;
			task.pendingSince = undefined;
			task.awaitingTurn = false;
			task.nextFireAt = undefined;
			paused++;
		}
		if (paused) this.persist();
		return paused;
	}

	resume(idOrAll: string): number {
		const ids = idOrAll === "all" ? [...this.tasks.keys()] : [idOrAll];
		let resumed = 0;
		for (const id of ids) {
			const task = this.tasks.get(id);
			if (!task?.paused) continue;
			task.paused = false;
			modeFor(task.spec.kind).start(task, this.eng); // watch re-baselines; timers re-arm
			resumed++;
		}
		if (resumed) this.persist();
		return resumed;
	}

	/** Fire a loop immediately (as soon as the agent is idle). */
	fireNow(id: string): boolean {
		const task = this.tasks.get(id);
		if (!task || task.paused) return false;
		this.triggerTask(task);
		return true;
	}

	disposeAll(): void {
		for (const task of this.tasks.values()) this.cancelTimers(task);
		this.clearWatchdog();
		if (this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
		if (this.sweeper) {
			clearInterval(this.sweeper);
			this.sweeper = undefined;
		}
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
		}
		this.flushPersist(); // write any trailing state before /reload or quit
	}

	/**
	 * Turn ended: apply any loop-control sentinels from the final assistant message (only
	 * for the loop that fired this turn), then re-arm paced loops (selfPaced backoff,
	 * worklist per-item delay).
	 */
	onAgentEnd(messages?: unknown[]): void {
		const fired = this.lastFiredId ? this.tasks.get(this.lastFiredId) : undefined;
		this.lastFiredId = undefined;
		const ctl = fired && messages?.length ? parseControls(finalAssistantText(messages)) : undefined;

		let firedStopped = false;
		if (fired && ctl) {
			if (ctl.stop) {
				this.notify(`Loop ${fired.id} reported done — stopped.`);
				this.stop(fired.id);
				this.render();
				firedStopped = true;
			} else if (ctl.retry && fired.spec.kind === "each" && fired.lastBatch?.length) {
				// Un-mark the last batch so the same item(s) run again.
				for (const item of fired.lastBatch) {
					const i = fired.spec.done.lastIndexOf(item);
					if (i >= 0) fired.spec.done.splice(i, 1);
				}
				this.persist();
			}
		}

		for (const task of this.tasks.values()) {
			const isFired = task === fired && !firedStopped;
			if (task.awaitingTurn) {
				task.awaitingTurn = false;
				if (isFired && ctl?.now) {
					this.triggerTask(task);
					continue;
				}
				let delay: number;
				if (isFired && ctl?.nextMs !== undefined) {
					delay = task.spec.kind === "selfPaced" ? clamp(ctl.nextMs, this.cfg.selfMin, this.cfg.selfMax) : Math.max(1_000, ctl.nextMs);
				} else if (task.spec.kind === "selfPaced") {
					delay = Math.min(task.nextDelayMs * 2, this.cfg.selfMax);
				} else if (task.spec.kind === "each") {
					delay = task.spec.delayMs;
				} else {
					delay = task.nextDelayMs;
				}
				this.armTask(task, delay);
			} else if (isFired && (ctl?.now || ctl?.nextMs !== undefined)) {
				// Interval kinds re-armed at fire time; the sentinel overrides that schedule.
				if (ctl.now) this.triggerTask(task);
				else this.armTask(task, Math.max(1_000, ctl.nextMs!));
			}
		}
	}

	list(): LoopInfo[] {
		const now = Date.now();
		return [...this.tasks.values()].map((t) => {
			const handler = modeFor(t.spec.kind);
			return {
				id: t.id,
				kind: t.spec.kind,
				label: handler.label(t.spec),
				when: this.when(t, now, handler),
				detail: handler.detail(t, (s) => this.short(s)),
				fireCount: t.fireCount,
				paused: t.paused,
			};
		});
	}

	ids(): string[] {
		return [...this.tasks.keys()];
	}

	size(): number {
		return this.tasks.size;
	}

	renderWidget(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.render();
		this.syncTicker();
	}

	restore(ctx: ExtensionContext, reason: string): void {
		if (reason !== "reload" && reason !== "resume") return;
		const now = Date.now();
		let snapshot: Snapshot | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type?: string; customType?: string; data?: Snapshot };
			if (e.type === "custom" && e.customType === "loop-task" && e.data) snapshot = e.data;
		}
		if (!snapshot) return;
		for (const p of snapshot.tasks) {
			if (now > p.expiresAt || this.tasks.has(p.id)) continue;
			const spec = p.spec as LoopSpec & { cursor?: number; done?: string[] };
			// Migrate pre-done-set worklist snapshots (numeric cursor) to content addressing.
			if (spec.kind === "each" && !Array.isArray(spec.done)) {
				spec.done = readItems(spec.file).slice(0, typeof spec.cursor === "number" ? spec.cursor : 0);
			}
			const task: Task = {
				id: p.id,
				spec: p.spec,
				pending: false,
				awaitingTurn: false,
				paused: p.paused ?? false,
				createdAt: p.createdAt,
				expiresAt: p.expiresAt,
				nextDelayMs: 0,
				fireCount: p.fireCount ?? 0,
				lastFiredAt: p.lastFiredAt,
			};
			this.tasks.set(task.id, task);
			const n = parseInt(task.id, 36);
			if (Number.isFinite(n)) this.seq = Math.max(this.seq, n);
			if (!task.paused) modeFor(task.spec.kind).start(task, this.eng);
		}
		this.syncSweep();
	}

	// --- triggers --------------------------------------------------------------

	private armTask(task: Task, delayMs: number): void {
		clearTimeout(task.timer);
		task.nextDelayMs = delayMs;
		task.nextFireAt = Date.now() + delayMs;
		task.timer = setTimeout(() => {
			const handler = modeFor(task.spec.kind);
			if (handler.onTimer) handler.onTimer(task, this.eng);
			else this.triggerTask(task);
		}, delayMs);
	}

	private triggerTask(task: Task): void {
		if (this.tasks.get(task.id) !== task) return; // stopped since the trigger was armed
		if (!task.pending) {
			task.pending = true;
			task.pendingSince = Date.now(); // collapse: keep the original arrival time
		}
		task.nextFireAt = undefined;
		this.flush();
	}

	private cancelTimers(task: Task): void {
		clearTimeout(task.timer);
		task.timer = undefined;
		if (task.poller) {
			clearInterval(task.poller);
			task.poller = undefined;
		}
	}

	// --- firing ----------------------------------------------------------------

	private flush(): void {
		if (!this.idle()) return;
		const now = Date.now();
		for (const task of [...this.tasks.values()]) {
			if (now > task.expiresAt) {
				this.notify(`Loop ${task.id} expired — stopped.`);
				this.stop(task.id);
			}
		}
		// Release pending fires oldest-first so a tight loop can't starve a slow one.
		// No task becomes newly pending during this loop (postFire only arms async timers),
		// so the ready set is computed and sorted once rather than per iteration.
		const ready = [...this.tasks.values()].filter((t) => t.pending && !t.paused).sort((a, b) => (a.pendingSince ?? 0) - (b.pendingSince ?? 0));
		for (const task of ready) {
			task.pending = false;
			task.pendingSince = undefined;
			const handler = modeFor(task.spec.kind);
			const prompt = handler.buildPrompt(task, this.eng);
			if (prompt === null) {
				const note = handler.completeNote?.(task);
				if (note) this.notify(note);
				this.stop(task.id);
				this.render();
				continue;
			}
			if (prompt === "skip") {
				handler.postFire(task, this.eng); // nothing to send this round; re-arm
				continue;
			}
			this.inFlight = true;
			this.lastFiredId = task.id;
			try {
				this.pi.sendUserMessage(this.withSteerHint(prompt), { deliverAs: "followUp" });
			} catch {
				task.pending = true;
				task.pendingSince = now;
				this.inFlight = false;
				this.lastFiredId = undefined;
				return;
			}
			task.fireCount++;
			task.lastFiredAt = now;
			if (task.spec.maxRuns !== undefined && task.fireCount >= task.spec.maxRuns) {
				this.notify(`Loop ${task.id} finished its ${task.spec.maxRuns} run${task.spec.maxRuns > 1 ? "s" : ""} — stopped.`);
				this.stop(task.id);
				this.render();
			} else {
				handler.postFire(task, this.eng);
			}
			this.startWatchdog();
			return; // one fire; now in flight until agent_end
		}
	}

	/** If a send never turns into agent_start/agent_end, unstick the engine. */
	private startWatchdog(): void {
		this.clearWatchdog();
		const t = setTimeout(() => {
			this.watchdog = undefined;
			if (this.inFlight && !this.agentBusy) {
				this.inFlight = false;
				this.lastFiredId = undefined;
				this.flush();
			}
		}, this.cfg.watchdogMs ?? DEFAULTS.watchdogMs);
		t.unref?.();
		this.watchdog = t;
	}

	private clearWatchdog(): void {
		if (this.watchdog) {
			clearTimeout(this.watchdog);
			this.watchdog = undefined;
		}
	}

	// --- expiry sweep ------------------------------------------------------------

	/** Loops that never fire (e.g. a watch on a quiet file) still expire on schedule. */
	private syncSweep(): void {
		const active = this.tasks.size > 0;
		if (active && !this.sweeper) {
			const t = setInterval(() => {
				const now = Date.now();
				let swept = 0;
				for (const task of [...this.tasks.values()]) {
					if (now > task.expiresAt) {
						this.notify(`Loop ${task.id} expired — stopped.`);
						this.stop(task.id);
						swept++;
					}
				}
				if (swept) this.render();
			}, SWEEP_MS);
			t.unref?.();
			this.sweeper = t;
		} else if (!active && this.sweeper) {
			clearInterval(this.sweeper);
			this.sweeper = undefined;
		}
	}

	// --- persistence -----------------------------------------------------------

	/**
	 * Coalesced persistence: write immediately (leading edge) for an isolated change, then
	 * throttle further writes for a window so a fast worklist doesn't append a snapshot per item.
	 * disposeAll() flushes any trailing write, so /reload and quit never lose the latest state.
	 */
	private persist(): void {
		this.persistDirty = true;
		if (this.persistTimer) return; // inside a window; the trailing flush will catch this
		this.flushPersist(); // leading edge
		const t = setTimeout(() => {
			this.persistTimer = undefined;
			this.flushPersist();
		}, PERSIST_THROTTLE_MS);
		t.unref?.();
		this.persistTimer = t;
	}

	private flushPersist(): void {
		if (!this.persistDirty) return;
		this.persistDirty = false;
		const snapshot: Snapshot = {
			tasks: [...this.tasks.values()].map((t) => ({
				id: t.id,
				spec: t.spec,
				createdAt: t.createdAt,
				expiresAt: t.expiresAt,
				fireCount: t.fireCount,
				lastFiredAt: t.lastFiredAt,
				paused: t.paused,
			})),
		};
		this.pi.appendEntry("loop-task", snapshot);
	}

	/** Append the steering hint unless disabled, or the prompt already teaches NEXT:/LOOP:. */
	private withSteerHint(prompt: string): string {
		if (!this.cfg.steerHint) return prompt;
		if (/\b(LOOP|NEXT)\s*:/i.test(prompt)) return prompt;
		return prompt + STEER_HINT;
	}

	// --- widget ----------------------------------------------------------------

	private notify(message: string, level: "info" | "warning" = "info"): void {
		if (this.ctx?.hasUI) {
			this.ctx.ui.notify(message, level);
		} else if (this.ctx) {
			// Headless session (print/json) — there's no UI to notify, so leave an audit trail.
			this.logToFile(message, level);
		}
		// No ctx (e.g. before first render, or under test) — nothing to do.
	}

	private logToFile(message: string, level: "info" | "warning"): void {
		try {
			const dir = join(this.ctx!.cwd, ".pi");
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, "loop.log"), `${new Date().toISOString()} [${level}] ${message}\n`);
		} catch {
			// Best-effort; never let logging break a loop.
		}
	}

	private render(): void {
		const ctx = this.ctx;
		if (!ctx?.hasUI) return;
		const tasks = [...this.tasks.values()];
		if (tasks.length === 0) {
			ctx.ui.setWidget("loops", undefined);
			ctx.ui.setStatus("loop", undefined);
			return;
		}
		const now = Date.now();
		const lines = tasks.map((t) => {
			const handler = modeFor(t.spec.kind);
			const ran = t.fireCount > 0 ? ` · ran ${t.fireCount}×` : "";
			return `◷ ${t.id} · ${handler.label(t.spec)} · ${this.when(t, now, handler)} · ${handler.detail(t, (s) => this.short(s))}${ran}`;
		});
		ctx.ui.setWidget("loops", lines);
		ctx.ui.setStatus("loop", `◷ ${tasks.length} loop${tasks.length > 1 ? "s" : ""}`);
	}

	private syncTicker(): void {
		const active = this.tasks.size > 0 && !!this.ctx?.hasUI;
		if (active && !this.ticker) {
			const t = setInterval(() => {
				this.render();
				this.syncTicker();
			}, 1000);
			t.unref?.();
			this.ticker = t;
		} else if (!active && this.ticker) {
			clearInterval(this.ticker);
			this.ticker = undefined;
		}
	}

	private when(task: Task, now: number, handler: AnyMode): string {
		if (task.paused) return "paused";
		const custom = handler.when?.(task);
		if (custom) return custom;
		if (task.awaitingTurn) return "after turn";
		if (task.pending) return "due";
		if (task.nextFireAt !== undefined) return `next in ${humanize(task.nextFireAt - now)}`;
		return "—";
	}

	private short(prompt: string): string {
		const oneLine = prompt.replace(/\s+/g, " ").trim();
		return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
	}
}
