/**
 * Slash-target resolution for `/loop <interval> /something`.
 *
 * Hard constraint (verified against @earendil-works/pi-coding-agent v0.79.0):
 * the public extension API has NO way to execute a registered command, prompt template, or
 * skill on demand. `pi.sendUserMessage()` calls `session.prompt(text, { expandPromptTemplates:
 * false })`, which the source comments as "skip command handling and template expansion", and
 * the extension context exposes no `prompt()` / `runCommand()`.
 *
 * What IS reproducible with public APIs is **skill expansion**: a `/skill:name args` invocation
 * expands to a `<skill>…</skill>` block (exactly as AgentSession._expandSkillCommand does). We
 * rebuild that block using the exported `loadSkills` + `getAgentDir` + `stripFrontmatter`, so a
 * loop can re-run a skill as plain prompt text.
 *
 * Everything else (prompt templates, extension commands) is classified and reported as
 * unsupported, with guidance, rather than silently no-oping.
 */

import { readFileSync } from "node:fs";
import { getAgentDir, loadSkills, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type SlashResolution =
	/** A skill target expanded to plain prompt text; loop re-expands it at fire time. */
	| { kind: "skill"; text: string; name: string; args: string }
	/** Not a known command/skill/template — treat as literal prompt text. */
	| { kind: "literal" }
	/** Recognised but not loopable via the public API (template or command). */
	| { kind: "unsupported"; reason: string };

const SKILL_PREFIX = "skill:";

/** Split "/name rest" -> { name, args } (name without leading slash). */
function splitSlash(text: string): { name: string; args: string } {
	const body = text.slice(1); // drop leading "/"
	const sp = body.indexOf(" ");
	return sp === -1 ? { name: body, args: "" } : { name: body.slice(0, sp), args: body.slice(sp + 1).trim() };
}

/**
 * Rebuild the exact <skill> block AgentSession produces for /skill:name args.
 * Exported so the scheduler can re-expand at fire time (skill edits apply next iteration).
 */
export function expandSkill(cwd: string, skillName: string, args: string): SlashResolution {
	let skills;
	try {
		skills = loadSkills({ cwd, agentDir: getAgentDir(), skillPaths: [], includeDefaults: true }).skills;
	} catch (err) {
		return { kind: "unsupported", reason: `Could not load skills: ${err instanceof Error ? err.message : String(err)}` };
	}
	const skill = skills.find((s) => s.name === skillName);
	if (!skill) {
		return { kind: "unsupported", reason: `Skill "${skillName}" not found in this workspace or agent dir.` };
	}
	let body: string;
	try {
		body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
	} catch (err) {
		return { kind: "unsupported", reason: `Could not read skill "${skillName}": ${err instanceof Error ? err.message : String(err)}` };
	}
	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
	return { kind: "skill", text: args ? `${block}\n\n${args}` : block, name: skillName, args };
}

/**
 * Resolve a slash target into something loopable.
 * `text` is the prompt portion starting with "/", e.g. "/skill:foo bar" or "/review-pr 123".
 */
export function resolveSlashTarget(pi: ExtensionAPI, cwd: string, text: string): SlashResolution {
	const { name, args } = splitSlash(text);

	// Explicit skill form: /skill:name
	if (name.startsWith(SKILL_PREFIX)) {
		return expandSkill(cwd, name.slice(SKILL_PREFIX.length), args);
	}

	// Classify against registered slash commands (name-only metadata).
	const match = pi.getCommands().find((c) => c.name === name || c.name === `${SKILL_PREFIX}${name}`);
	if (!match) return { kind: "literal" };

	switch (match.source) {
		case "skill": {
			const skillName = match.name.startsWith(SKILL_PREFIX) ? match.name.slice(SKILL_PREFIX.length) : name;
			return expandSkill(cwd, skillName, args);
		}
		case "prompt":
			return {
				kind: "unsupported",
				reason: `"/${name}" is a prompt template — the extension API can't expand templates from a loop. Loop the prompt text directly, or wrap it as a skill and use /skill:${name}.`,
			};
		default: // "extension"
			return {
				kind: "unsupported",
				reason: `"/${name}" is an extension command — commands can't be fired on a timer via the public API (sendUserMessage bypasses command handling). Loop a plain prompt, or a /skill:… target, instead.`,
			};
	}
}
