/**
 * Default prompt for bare `/loop`.
 *
 * Resolution order (project wins over user, matching Claude Code):
 *   1. <cwd>/.pi/loop.md
 *   2. ~/.pi/loop.md
 *   3. built-in maintenance ("babysitter") prompt
 *
 * Loaded synchronously so the scheduler can re-resolve it at *fire time* — edits to
 * loop.md take effect on the next iteration of an already-running loop.
 * Truncated at 25,000 bytes, matching Claude Code's limit.
 */

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_BYTES = 25_000;

const BUILT_IN = `Act as a careful maintenance babysitter for this repo. Each iteration:
1. Check git status, the current branch, and the open PR if one exists.
2. Check CI / test status if accessible.
3. Check recent scanner or agent output under ./runs, ./reports, or ./artifacts.
4. If a test or build is clearly broken, make the smallest low-risk fix and run the narrowest relevant test.
5. Triage any security finding into: confirmed / likely / needs-repro / false-positive.
6. Never push, delete data, rewrite history, or rotate credentials unless already explicitly authorized in this session.
7. End with a one-line status. You can steer this loop by finishing with one of these lines on its own:
   NEXT: 20m   (set the delay before the next run)
   LOOP: done  (everything is finished — stop the loop)
   LOOP: now   (something needs another pass — run again immediately)`;

export function loadDefaultPrompt(cwd: string): string {
	const candidates = [path.join(cwd, ".pi", "loop.md"), path.join(os.homedir(), ".pi", "loop.md")];
	for (const file of candidates) {
		try {
			const text = readFileSync(file, "utf-8");
			if (text.trim()) return text.slice(0, MAX_BYTES);
		} catch {
			// File missing or unreadable; fall through to the next candidate.
		}
	}
	return BUILT_IN;
}
