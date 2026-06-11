#!/usr/bin/env bun
/**
 * npm publish orchestrator for pi-loop.
 *
 * pi-loop is a *compiled* Pi extension: `src/*.ts` is bundled into a single
 * `dist/index.js` via `bun build`, and only that file (plus README + LICENSE)
 * ships. Publishing means producing a fresh bundle and shipping it so both
 * `pi install <pkg>` and `npm i -g <pkg>` resolve `dist/index.js`.
 *
 * Flow per run: npm auth check → `bun install --ignore-scripts` (so preflight +
 * the build have deps) → preflight (typecheck + tests) → build (bun bundle) →
 * next version by patch-bumping the registry's current latest → write it back to
 * package.json → stage a curated copy under build/npm/pkg with a publish-ready
 * manifest (no `private`, no `scripts`, no devDependencies) → dry-run validate
 * the tarball → publish (skipping if that version is already on the registry).
 *
 * The staged manifest drops the `scripts` block on purpose so no lifecycle hook
 * runs on a consumer's `npm install`. Staging also lets the committed
 * package.json keep its dev-only fields untouched.
 *
 * Env vars:
 *   PILOOP_VERSION             — pin the version to publish (overrides the bump)
 *   PILOOP_NPM_DRY_RUN=1       — stage + dry-run validate only; no registry writes
 *   PILOOP_NPM_SKIP_PREFLIGHT=1 — skip typecheck + tests
 *   PILOOP_NPM_SKIP_BUILD=1    — skip the bundle build (dist already current)
 *   PILOOP_NPM_SKIP_INSTALL=1  — skip `bun install` (deps already present)
 *   NPM_TOKEN                  — if set, a staged-dir .npmrc references it via
 *                                `${NPM_TOKEN}` for auth (the secret is never
 *                                written to disk; npm expands it at read time,
 *                                and omits .npmrc from the published tarball)
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_PATH = join(ROOT, "package.json");
const STAGE = join(ROOT, "build", "npm");

// The committed manifest is the single source of truth: `name` (so a rename
// needs no edit here) and `files` (the exact set staging copies and the staged
// manifest inherits — keep it complete, e.g. include LICENSE).
const ROOT_PKG = JSON.parse(readFileSync(PKG_PATH, "utf8")) as {
	name?: string;
	files?: string[];
};
const PKG_NAME = String(ROOT_PKG.name ?? "");
if (!PKG_NAME) throw new Error(`no "name" in ${PKG_PATH}`);
const PUBLISH_FILES = ROOT_PKG.files ?? [];
if (PUBLISH_FILES.length === 0) throw new Error(`no "files" array in ${PKG_PATH}`);

const DRY_RUN = process.env.PILOOP_NPM_DRY_RUN === "1";
const SKIP_PREFLIGHT = process.env.PILOOP_NPM_SKIP_PREFLIGHT === "1";
const SKIP_BUILD = process.env.PILOOP_NPM_SKIP_BUILD === "1";
const SKIP_INSTALL = process.env.PILOOP_NPM_SKIP_INSTALL === "1";
const PINNED_VERSION = process.env.PILOOP_VERSION;

const PREFIX = "\x1b[36m[*]\x1b[0m";

function step(msg: string): void {
	console.log(`${PREFIX} ${msg}`);
}

function run(cmd: string, args: string[], opts: { cwd?: string; check?: boolean } = {}): number {
	const result = spawnSync(cmd, args, { cwd: opts.cwd ?? ROOT, stdio: "inherit" });
	if ((opts.check ?? true) && result.status !== 0) {
		throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status})`);
	}
	return result.status ?? 0;
}

function npmAuthCheck(): void {
	const r = spawnSync("npm", ["whoami"], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.status === 0) {
		step(`npm authenticated as ${(r.stdout ?? "").trim()}`);
		return;
	}
	if (process.env.NPM_TOKEN) {
		step("npm whoami failed but NPM_TOKEN is set — relying on staged-dir .npmrc");
		return;
	}
	const msg = "not authenticated to npm. Run `npm login`, or set NPM_TOKEN (an Automation token).";
	if (DRY_RUN) {
		step(`warning: ${msg}`);
		return;
	}
	throw new Error(msg);
}

function ensureDeps(): void {
	if (SKIP_INSTALL) {
		step("skip bun install (PILOOP_NPM_SKIP_INSTALL=1)");
		return;
	}
	// --ignore-scripts: never run any lifecycle hook during this prepare install.
	step("installing dependencies (bun install --ignore-scripts)");
	run("bun", ["install", "--ignore-scripts"]);
}

function preflight(): void {
	if (SKIP_PREFLIGHT) {
		step("skip preflight (PILOOP_NPM_SKIP_PREFLIGHT=1)");
		return;
	}
	step("preflight: typecheck");
	run("bun", ["run", "typecheck"]);
	step("preflight: tests");
	run("bun", ["run", "test"]);
}

function build(): void {
	if (SKIP_BUILD) {
		step("skip build (PILOOP_NPM_SKIP_BUILD=1)");
		return;
	}
	step("building (bun run build → dist)");
	run("bun", ["run", "build"]);
}

/** `npm view <spec> version` → trimmed stdout, or undefined on failure/empty. */
function npmViewVersion(spec: string): string | undefined {
	const r = spawnSync("npm", ["view", spec, "version"], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (r.status !== 0) return undefined;
	const v = (r.stdout ?? "").trim();
	return v.length > 0 ? v : undefined;
}

/** Highest version on the `latest` dist-tag, or undefined if the lookup fails. */
function registryLatest(): string | undefined {
	return npmViewVersion(PKG_NAME);
}

function readLocalVersion(): string {
	const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version?: string };
	return String(pkg.version ?? "0.0.0");
}

/** Patch-bump, preserving any prerelease suffix (0.0.3 → 0.0.4, 1.2.3-rc → 1.2.4-rc). */
function bumpPatch(version: string): string {
	const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
	if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
		throw new Error(`cannot parse version "${version}" (expected MAJOR.MINOR.PATCH[-prerelease])`);
	}
	return `${m[1]}.${m[2]}.${Number(m[3]) + 1}${m[4] ?? ""}`;
}

function computeNextVersion(): string {
	if (PINNED_VERSION) {
		step(`using pinned PILOOP_VERSION=${PINNED_VERSION}`);
		return PINNED_VERSION;
	}
	const latest = registryLatest();
	const base = latest ?? readLocalVersion();
	if (latest) step(`registry latest ${PKG_NAME}@${latest}`);
	else step(`registry latest unavailable — bumping from local package.json (${base})`);
	const next = bumpPatch(base);
	step(`next version → ${next}`);
	return next;
}

/** Rewrite only the `"version":` line so the rest of the manifest is untouched. */
function writeVersion(next: string): void {
	if (DRY_RUN) {
		step("skip writing version — dry run");
		return;
	}
	const raw = readFileSync(PKG_PATH, "utf8");
	const updated = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
	if (updated === raw) throw new Error(`failed to rewrite "version" in ${PKG_PATH}`);
	writeFileSync(PKG_PATH, updated);
	step(`wrote version ${next} to package.json (not committed)`);
}

/**
 * Write a staged-dir .npmrc when NPM_TOKEN is set (CI/automation path). When it
 * isn't, npm falls back to ~/.npmrc — the normal local `npm login` flow.
 *
 * The file stores the literal `${NPM_TOKEN}` rather than the expanded value:
 * npm substitutes env vars at read time, so the secret never lands on disk.
 * cleanupStage() removes the staged tree (including this file) after the run.
 * npm also omits .npmrc from published tarballs regardless.
 */
function writeNpmrc(dir: string): void {
	if (!process.env.NPM_TOKEN) return;
	writeFileSync(
		join(dir, ".npmrc"),
		// Literal ${NPM_TOKEN} — npm expands it at read time, so no secret on disk.
		"registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n",
		{ mode: 0o600 },
	);
}

/** Remove the staged package tree, including any .npmrc holding auth config. */
function cleanupStage(): void {
	if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
}

/** Full package.json minus dev-only fields, with publish metadata added. The
 *  committed `files` is kept as-is — it already declares exactly what ships. */
function writeManifest(dir: string, version: string): void {
	const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as Record<string, unknown>;
	pkg.private = undefined;
	pkg.scripts = undefined;
	pkg.devDependencies = undefined;
	pkg.version = version;
	pkg.publishConfig = { access: "public" };
	writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function stage(version: string): string {
	cleanupStage();
	const dir = join(STAGE, "pkg");
	mkdirSync(dir, { recursive: true });

	// Copy exactly the manifest's `files` entries — a dir recursively, a file
	// directly — so the staged tree matches what `npm publish` would ship.
	for (const entry of PUBLISH_FILES) {
		const rel = entry.replace(/\/$/, "");
		const src = join(ROOT, rel);
		if (!existsSync(src)) throw new Error(`missing publishable path: ${src} (did the build run?)`);
		if (statSync(src).isDirectory()) {
			cpSync(src, join(dir, rel), {
				recursive: true,
				filter: (s: string) => !s.endsWith(".DS_Store"),
			});
		} else {
			copyFileSync(src, join(dir, rel));
		}
	}

	writeManifest(dir, version);
	writeNpmrc(dir);
	step(`staged ${PKG_NAME}@${version} under ${dir}`);
	return dir;
}

/** True if <PKG_NAME>@<version> already exists on the registry. */
function isPublished(version: string): boolean {
	return npmViewVersion(`${PKG_NAME}@${version}`) === version;
}

function publishOrSkip(dir: string, version: string): void {
	if (isPublished(version)) {
		step(`skip ${PKG_NAME}@${version} — already on registry`);
		return;
	}
	step(`publishing ${PKG_NAME}@${version}`);
	run("npm", ["publish", "--access", "public"], { cwd: dir });
}

function main(): void {
	step(`npm publish ${PKG_NAME}${DRY_RUN ? "  [DRY RUN]" : ""}`);

	npmAuthCheck();
	ensureDeps();
	preflight();
	build();

	const version = computeNextVersion();
	writeVersion(version);

	try {
		const dir = stage(version);

		step("validating tarball (npm publish --dry-run)");
		run("npm", ["publish", "--dry-run", "--access", "public"], { cwd: dir });

		if (DRY_RUN) {
			step("DRY RUN — staged + validated only; no registry writes performed");
			console.log("");
			console.log(`  staged under:  ${dir}`);
			console.log(`  would publish: ${PKG_NAME}@${version}`);
			return;
		}

		publishOrSkip(dir, version);

		step("published successfully!");
		console.log("");
		console.log(`  npm install -g ${PKG_NAME}`);
		console.log(`  pi install ${PKG_NAME}`);
	} finally {
		// Always clear the staged tree (and any auth .npmrc) after a real run,
		// including on error. Preserved only on a dry run for inspection — its
		// .npmrc holds the literal ${NPM_TOKEN}, never the expanded secret.
		if (!DRY_RUN) cleanupStage();
	}
}

main();
