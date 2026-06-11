// Tests slash-target resolution: classification + real /skill:name expansion.
// Run: node test/slash.mjs   (after `npx tsc` has produced dist/)
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSlashTarget } from "../dist/slash.js";

let failures = 0;
const assert = (cond, msg) => {
	console.log((cond ? "  ✓ " : "  ✗ ") + msg);
	if (!cond) failures++;
};
const fakePi = (cmds) => ({ getCommands: () => cmds });

console.log("slash-target resolution");

// Unknown slash -> literal (sent verbatim).
{
	const r = resolveSlashTarget(fakePi([]), "/tmp", "/review-pr 123");
	assert(r.kind === "literal", `unknown slash -> literal (got ${r.kind})`);
}

// Extension command -> unsupported with guidance.
{
	const r = resolveSlashTarget(fakePi([{ name: "review-pr", source: "extension" }]), "/tmp", "/review-pr 123");
	assert(r.kind === "unsupported" && /extension command/.test(r.reason ?? ""), "extension command -> unsupported");
}

// Prompt template -> unsupported with guidance.
{
	const r = resolveSlashTarget(fakePi([{ name: "plan", source: "prompt" }]), "/tmp", "/plan now");
	assert(r.kind === "unsupported" && /prompt template/.test(r.reason ?? ""), "prompt template -> unsupported");
}

// Real /skill:name expansion against a temp workspace skill.
{
	const root = mkdtempSync(join(tmpdir(), "pi-loop-skill-"));
	const skillDir = join(root, ".pi", "skills", "demo");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		"---\nname: demo\ndescription: a demo skill\n---\nDo the demo thing carefully.",
	);

	const r = resolveSlashTarget(fakePi([]), root, "/skill:demo extra args");
	assert(r.kind === "skill", `/skill:demo -> expanded (got ${r.kind}${r.reason ? ": " + r.reason : ""})`);
	if (r.kind === "skill") {
		assert(r.text.includes('<skill name="demo"'), "contains <skill> block header");
		assert(r.text.includes("Do the demo thing carefully."), "contains skill body");
		assert(r.text.trim().endsWith("extra args"), "appends invocation args after the block");
		assert(!r.text.includes("---"), "frontmatter stripped");
	}

	// Unknown skill name -> unsupported.
	const r2 = resolveSlashTarget(fakePi([]), root, "/skill:nope");
	assert(r2.kind === "unsupported" && /not found/.test(r2.reason ?? ""), "missing skill -> unsupported");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
