/**
 * Interval grammar, flags, and prompt splitting for the /loop command.
 *
 * Syntax: `/loop [interval] [flags] [prompt]`
 *   /loop 5m do X                        fixed interval
 *   /loop do X                           self-paced (NEXT:/backoff picks the next delay)
 *   /loop                                default maintenance prompt on the default interval
 *   /loop --watch ./notes.md do X        fire when the file (or directory) changes
 *   /loop --each ./todo.txt fix: {item}  process one item per iteration, then stop
 *   /loop 5m --file ./notes.md do X      re-read the file's contents into the prompt each interval
 *   /loop 1m --cmd "gh pr checks" do X   run a command each interval, inject its output
 *   /loop --at 09:00 do X                fire daily at a clock time
 *
 * Modifier flags: --times N (stop after N runs), --batch N (worklist items per run),
 * --on-change (only fire --file/--cmd loops when contents/output changed).
 *
 * Flags must appear *before* the prompt text (an optional leading interval comes first).
 * Values with spaces are quoted: --watch "my notes.md", --cmd "git status -s".
 * Once prompt text starts, everything after it is taken verbatim — so a prompt can
 * mention "--watch" freely as long as it doesn't lead the argument list.
 */

export interface SkillRef {
	name: string;
	args: string;
}

type Common = {
	/** Stop the loop automatically after this many fires (--times N). */
	maxRuns?: number;
};

export type LoopSpec = Common &
	(
		| {
				kind: "fixed";
				intervalMs: number;
				intervalLabel: string;
				prompt: string;
				isSlash: boolean;
				/** Prompt came from loop.md / built-in — re-resolve at fire time so edits apply. */
				usesDefaultPrompt?: boolean;
				/** Skill target — re-expand at fire time so skill edits apply. */
				skill?: SkillRef;
		  }
		| { kind: "selfPaced"; prompt: string; isSlash: boolean; skill?: SkillRef }
		| { kind: "at"; time: string; prompt: string; isSlash: boolean; usesDefaultPrompt?: boolean; skill?: SkillRef }
		| { kind: "watch"; file: string; prompt: string; usesDefaultPrompt?: boolean }
		| {
				kind: "each";
				file: string;
				promptTemplate: string;
				/** Items already processed (content-addressed, multiset) — robust to live edits of the file. */
				done: string[];
				delayMs: number;
				/** Items per iteration (--batch N), default 1. */
				batch?: number;
		  }
		| {
				kind: "fileInterval";
				file: string;
				intervalMs: number;
				intervalLabel: string;
				promptTemplate: string;
				usesDefaultPrompt?: boolean;
				/** Skip the fire when the contents are unchanged since the last one (--on-change). */
				onChange?: boolean;
		  }
		| {
				kind: "cmd";
				command: string;
				intervalMs: number;
				intervalLabel: string;
				promptTemplate: string;
				onChange?: boolean;
		  }
	);

export type ParseResult = { ok: true; spec: LoopSpec } | { ok: false; error: string };

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
type Unit = keyof typeof UNIT_MS;

/** Default delay between worklist items when no interval is given. */
export const DEFAULT_EACH_DELAY_MS = 3_000;

/** Fallback interval for bare /loop and --file/--cmd when the configured default is unparseable. */
export const DEFAULT_INTERVAL = "10m";

/** Parse a single interval token like "5m", "90m", "1h", "2d". Returns null if not an interval. */
export function parseInterval(token: string): { ms: number; label: string } | null {
	const m = /^(\d+)([smhd])$/.exec(token);
	if (!m) return null;
	const value = Number(m[1]);
	const unit = m[2] as Unit;
	if (!Number.isFinite(value) || value <= 0) return null;
	return { ms: value * UNIT_MS[unit], label: token };
}

interface Token {
	value: string;
	start: number;
	quoted: boolean;
}

/** Split on whitespace, honoring single/double quotes ("my file.txt" -> one token, quotes stripped). */
function tokenize(raw: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < raw.length) {
		while (i < raw.length && /\s/.test(raw[i]!)) i++;
		if (i >= raw.length) break;
		const start = i;
		let value = "";
		const q = raw[i];
		if (q === '"' || q === "'") {
			i++;
			while (i < raw.length && raw[i] !== q) value += raw[i++];
			i++; // closing quote (or end of string)
			tokens.push({ value, start, quoted: true });
		} else {
			while (i < raw.length && !/\s/.test(raw[i]!)) value += raw[i++];
			tokens.push({ value, start, quoted: false });
		}
	}
	return tokens;
}

const MODE_FLAGS = ["--watch", "--each", "--file", "--cmd"] as const;
const VALUE_FLAGS = new Set([...MODE_FLAGS, "--at", "--times", "--batch"]);
const BARE_FLAGS = new Set(["--on-change"]);

function err(error: string): ParseResult {
	return { ok: false, error };
}

/**
 * Parse the raw argument string from `/loop <args>` into a LoopSpec.
 * `defaultInterval` (e.g. "10m") and `defaultPrompt` are supplied by the caller; specs that
 * fall back to the default prompt carry `usesDefaultPrompt` so it can be re-read at fire time.
 */
export function parseLoopArgs(raw: string, defaultInterval: string, defaultPrompt: string): ParseResult {
	const tokens = tokenize(raw);
	let i = 0;

	// Optional leading interval token.
	let lead: { ms: number; label: string } | null = null;
	if (i < tokens.length && !tokens[i]!.quoted) {
		lead = parseInterval(tokens[i]!.value);
		if (lead) i++;
	}

	// Flags (head-anchored: stop at the first non-flag token, which starts the prompt).
	let mode: { flag: (typeof MODE_FLAGS)[number]; value: string } | undefined;
	let at: string | undefined;
	let times: number | undefined;
	let batch: number | undefined;
	let onChange = false;
	while (i < tokens.length && !tokens[i]!.quoted && tokens[i]!.value.startsWith("--")) {
		const flag = tokens[i]!.value;
		if (!VALUE_FLAGS.has(flag as never) && !BARE_FLAGS.has(flag)) {
			return err(`Unknown flag ${flag}. Known: --watch --each --file --cmd --at --times --batch --on-change. If "${flag}" is prompt text, start the prompt with a regular word.`);
		}
		i++;
		let value = "";
		if (VALUE_FLAGS.has(flag as never)) {
			if (i >= tokens.length) return err(`${flag} needs a value (e.g. ${flag === "--at" ? "--at 09:00" : flag === "--times" || flag === "--batch" ? `${flag} 5` : `${flag} ./path`}).`);
			value = tokens[i]!.value;
			i++;
		}
		if ((MODE_FLAGS as readonly string[]).includes(flag)) {
			if (mode) return err(`${mode.flag} and ${flag} can't be combined — pick one mode.`);
			mode = { flag: flag as (typeof MODE_FLAGS)[number], value };
		} else if (flag === "--at") {
			if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) return err(`--at expects a 24h clock time like 09:00 or 17:30 (got "${value}").`);
			at = value;
		} else if (flag === "--times") {
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0) return err(`--times expects a positive integer (got "${value}").`);
			times = n;
		} else if (flag === "--batch") {
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0) return err(`--batch expects a positive integer (got "${value}").`);
			batch = n;
		} else {
			onChange = true;
		}
	}

	// Everything from the first non-flag token on is the prompt, verbatim.
	const promptText = i < tokens.length ? raw.slice(tokens[i]!.start).trim() : "";

	// Combination checks.
	if (at !== undefined && mode) return err(`--at can't be combined with ${mode.flag} — it replaces the schedule, not the prompt source.`);
	if (at !== undefined && lead) return err(`--at and a leading interval can't be combined — pick one schedule.`);
	if (onChange && mode?.flag !== "--file" && mode?.flag !== "--cmd") return err(`--on-change only applies to --file or --cmd loops.`);
	if (batch !== undefined && mode?.flag !== "--each") return err(`--batch only applies to --each worklist loops.`);

	const fallbackInterval = parseInterval(defaultInterval) ?? parseInterval(DEFAULT_INTERVAL)!;

	if (mode?.flag === "--watch") {
		return { ok: true, spec: { kind: "watch", file: mode.value, prompt: promptText || defaultPrompt, usesDefaultPrompt: !promptText, maxRuns: times } };
	}
	if (mode?.flag === "--each") {
		return {
			ok: true,
			spec: {
				kind: "each",
				file: mode.value,
				promptTemplate: promptText || "Do the task for this item: {item}",
				done: [],
				delayMs: lead ? lead.ms : DEFAULT_EACH_DELAY_MS,
				batch,
				maxRuns: times,
			},
		};
	}
	if (mode?.flag === "--file") {
		const iv = lead ?? fallbackInterval;
		return {
			ok: true,
			spec: {
				kind: "fileInterval",
				file: mode.value,
				intervalMs: iv.ms,
				intervalLabel: iv.label,
				promptTemplate: promptText || defaultPrompt,
				usesDefaultPrompt: !promptText,
				onChange: onChange || undefined,
				maxRuns: times,
			},
		};
	}
	if (mode?.flag === "--cmd") {
		const iv = lead ?? fallbackInterval;
		return {
			ok: true,
			spec: {
				kind: "cmd",
				command: mode.value,
				intervalMs: iv.ms,
				intervalLabel: iv.label,
				promptTemplate: promptText || "Review this command output and act on anything that needs attention.",
				onChange: onChange || undefined,
				maxRuns: times,
			},
		};
	}
	if (at !== undefined) {
		const prompt = promptText || defaultPrompt;
		return { ok: true, spec: { kind: "at", time: at, prompt, isSlash: prompt.startsWith("/"), usesDefaultPrompt: !promptText, maxRuns: times } };
	}

	// No mode flags -> original interval / self-paced behavior.
	if (lead) {
		const prompt = promptText || defaultPrompt;
		return {
			ok: true,
			spec: { kind: "fixed", intervalMs: lead.ms, intervalLabel: lead.label, prompt, isSlash: prompt.startsWith("/"), usesDefaultPrompt: !promptText, maxRuns: times },
		};
	}
	if (!promptText) {
		return {
			ok: true,
			spec: {
				kind: "fixed",
				intervalMs: fallbackInterval.ms,
				intervalLabel: fallbackInterval.label,
				prompt: defaultPrompt,
				isSlash: false,
				usesDefaultPrompt: true,
				maxRuns: times,
			},
		};
	}
	return { ok: true, spec: { kind: "selfPaced", prompt: promptText, isSlash: promptText.startsWith("/"), maxRuns: times } };
}
