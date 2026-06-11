/**
 * File helpers for the file-loop modes (watch / worklist / re-read / cmd).
 * Kept separate from the scheduler so they can be unit-tested directly.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** mtime + size snapshot used for change detection; undefined if the path is missing. */
export function statSafe(file: string): { mtimeMs: number; size: number; isDir: boolean } | undefined {
	try {
		const s = statSync(file);
		return { mtimeMs: s.mtimeMs, size: s.size, isDir: s.isDirectory() };
	} catch {
		return undefined;
	}
}

/** Truncate to at most `maxBytes` of UTF-8 without splitting a multi-byte character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(text, "utf-8");
	if (buf.byteLength <= maxBytes) return { text, truncated: false };
	let end = maxBytes;
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back off over continuation bytes
	return { text: buf.subarray(0, end).toString("utf-8"), truncated: true };
}

/** Read a file as text, truncated to `maxBytes` (UTF-8 safe). Never throws. */
export function readCapped(file: string, maxBytes: number): string {
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return `(file not found: ${file})`;
	}
	const t = truncateUtf8(text, maxBytes);
	if (t.truncated) text = `${t.text}\n…(truncated at ${maxBytes} bytes)`;
	return text.trim() ? text : "(file is empty)";
}

/** Cap an arbitrary string (e.g. command output) at `maxBytes`, UTF-8 safe. */
export function capBytes(text: string, maxBytes: number): string {
	const t = truncateUtf8(text, maxBytes);
	return t.truncated ? `${t.text}\n…(truncated at ${maxBytes} bytes)` : text;
}

/** Read a file as a worklist: non-blank, non-`#`-comment lines, trimmed. Never throws. */
export function readItems(file: string): string[] {
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	return text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"));
}

/**
 * Worklist items not yet processed, in file order. `done` is a multiset of processed item
 * texts, so the cursor is content-addressed: inserting/removing lines in the file never
 * skips or repeats work, and duplicate items each get their own turn.
 */
export function selectPending(items: string[], done: string[]): string[] {
	const counts = new Map<string, number>();
	for (const d of done) counts.set(d, (counts.get(d) ?? 0) + 1);
	const pending: string[] = [];
	for (const item of items) {
		const c = counts.get(item) ?? 0;
		if (c > 0) counts.set(item, c - 1);
		else pending.push(item);
	}
	return pending;
}

/** FNV-1a hash, hex — cheap content fingerprint for --on-change dedupe. */
export function hashText(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16);
}

/**
 * Recursive directory snapshot for watching a directory: a change signature plus the most
 * recently modified file. Skips .git/node_modules; bounded at `maxEntries` files.
 */
export function scanDir(dir: string, maxEntries = 5_000): { signature: string; latest?: string } {
	let count = 0;
	let totalSize = 0;
	let maxMtime = 0;
	let latest: string | undefined;
	const stack = [dir];
	while (stack.length > 0 && count < maxEntries) {
		const d = stack.pop()!;
		let entries;
		try {
			entries = readdirSync(d, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of entries) {
			if (e.name === ".git" || e.name === "node_modules") continue;
			const p = join(d, e.name);
			if (e.isDirectory()) {
				stack.push(p);
				continue;
			}
			const s = statSafe(p);
			if (!s) continue;
			count++;
			totalSize += s.size;
			if (s.mtimeMs > maxMtime) {
				maxMtime = s.mtimeMs;
				latest = p;
			}
			if (count >= maxEntries) break;
		}
	}
	return { signature: `${count}:${totalSize}:${maxMtime}`, latest };
}

/**
 * Build the message for a file mode. If the template contains `{contents}`/`{file}` those are
 * substituted; otherwise the contents are prepended as a `<file>` block before the template.
 * The block is marked `untrusted="true"` so the model treats watched/loaded content as data,
 * not instructions (a loop can inject attacker-influenced files or logs — prompt-injection).
 */
export function injectFile(file: string, contents: string, template: string): string {
	if (template.includes("{contents}") || template.includes("{file}")) {
		return template.replaceAll("{contents}", contents).replaceAll("{file}", file);
	}
	return `<file path="${file}" untrusted="true">\n${contents}\n</file>\n\n${template}`;
}

/**
 * Build the message for a cmd loop. `{output}`/`{cmd}` are substituted if present;
 * otherwise the output is prepended as a `<command-output>` block before the template.
 * Marked `untrusted="true"` for the same prompt-injection reason as injectFile.
 */
export function injectCmd(command: string, output: string, template: string): string {
	if (template.includes("{output}") || template.includes("{cmd}")) {
		return template.replaceAll("{output}", output).replaceAll("{cmd}", command);
	}
	return `<command-output command="${command}" untrusted="true">\n${output}\n</command-output>\n\n${template}`;
}
