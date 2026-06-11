# pi-loop

> **TL;DR — what's an agent loop?** Instead of prompting a coding agent by hand, you design a *loop*: a recurring prompt that fires on a schedule, a file change, or a worklist, and that the agent can steer or stop itself. You go from prompter to loop designer, the agent keeps working between your check-ins.
>
> More on the idea: [@steipete](https://x.com/steipete/status/2063697162748260627) · [@mvanhorn](https://x.com/mvanhorn/status/2063865685558903149) · [@0xCodez](https://x.com/0xCodez/status/2064374643729773029)

Agentic cron for your Pi session. Re-run a prompt on an interval, a file or directory change, a worklist, or command output, all inside the session you already have open.

A `/loop` slash command for the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Loops fire *between turns* (never mid-response) and die with the session.

## Install

pi-loop is a Pi extension, so install [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) first if you don't have it:

```bash
bun add -g @earendil-works/pi-coding-agent
```

Recommended — install pi-loop into your Pi from npm:

```bash
pi install npm:@j3ssie/pi-loop
```

This registers the `/loop`, `/loop-list`, `/loop-stop`, `/loop-pause`, `/loop-resume`, and `/loop-now` commands in your Pi sessions. Run them inside an interactive `pi` session, or one-shot with `pi -p "/loop 5m check the deploy"`.

## Usage

```
/loop [interval] [flags] [prompt]
```

| Command | Behavior |
| --- | --- |
| `/loop 5m check the deploy and summarize what changed` | **Fixed interval** — re-runs the prompt every 5m. |
| `/loop check whether CI passed and fix new comments` | **Self-paced** — the next delay is chosen by the agent (`NEXT: 20m`) or by exponential backoff, bounded 1m–1h. |
| `/loop`  /  `/loop 15m` | Runs the **default maintenance prompt** (see below). |
| `/loop --at 09:00 give me a standup summary` | **Daily** at a clock time (24h, local). |
| `/loop 5m --times 6 check the canary` | Stops automatically after **N runs**. |
| `/loop-list` | List active loops (with run counts). |
| `/loop-pause <id\|all>`  /  `/loop-resume <id\|all>` | Pause without losing progress; resume re-arms. |
| `/loop-now <id>` | Fire a loop immediately (as soon as the agent is idle). |
| `/loop-stop <id>`  /  `/loop-stop all` | Stop one loop, or all of them. |

Interval units: `s`, `m`, `h`, `d` (e.g. `30s`, `5m`, `90m`, `1h`, `2d`). Unlike Claude Code there's no one-minute cron floor — sub-minute intervals are honored exactly.

Flags must come **before** the prompt text (after the optional leading interval). Values with spaces are quoted: `--watch "my notes.md"`, `--cmd "git status -s"`. Once the prompt starts, everything is taken verbatim — a prompt may mention `--watch` freely. Misspelled flags and invalid combinations are rejected with guidance rather than silently misparsed.

While loops are active a live status widget shows each one and refreshes every second:

```
◷ 0001 · every 5s · next in 3s · echo tick · ran 12×
```

The countdown reads `next in Ns/Nm/Nh` while waiting, `due` once the timer fires, `after turn` while a paced loop waits for its run to finish, and `paused` for paused loops. The widget (and its refresher) appear only in the TUI and disappear when the last loop stops.

## The agent steers its own loop (sentinels)

After a turn that a loop fired, the **final assistant message** is scanned for control lines (each on its own line, case-insensitive). They apply only to the loop that initiated that turn — user-typed turns are never affected:

| Line | Effect |
| --- | --- |
| `NEXT: 20m` | Set the delay before this loop's next run (self-paced loops clamp to the 1m–1h bounds; interval loops take it as a one-off deferral, min 1s). |
| `LOOP: done` (or `LOOP: stop`) | The work is finished — stop the loop. |
| `LOOP: now` | Run again immediately (as soon as the agent is idle). |
| `LOOP: retry` | Worklist loops: re-run the current item(s) instead of advancing. |

So "loop until CI is green" is just: `/loop check CI; if it's green say LOOP: done`. Every loop-fired prompt gets a one-line reminder of this syntax appended automatically (so even a custom prompt can self-steer); the reminder is skipped when your prompt already mentions `NEXT:`/`LOOP:` (as the built-in default does), and can be turned off with `--loop-steer-hint false`.

## Loop over a file, directory, or command

| Mode | Command | What it does |
| --- | --- | --- |
| **Watch** | `/loop --watch ./runs/latest.json triage new findings` | Fires **only when the file changes** — detected by polling mtime/size every `--loop-watch-interval` (default 1s), robust across editors that save atomically. The current contents are injected into the prompt. **Watching a directory works too**: `/loop --watch ./runs …` fires when anything under it changes (recursive, skips `.git`/`node_modules`) and injects the most recently modified file. Directories poll on a slower cadence (`--loop-watch-dir-interval`, default 2s) since each tick rescans the tree. |
| **Worklist** | `/loop --each ./todo.txt fix the lint: {item}` | Processes **one item per iteration** (blank lines and `#` comments skipped), then **auto-stops** when the list is exhausted. Progress is **content-addressed**: editing the file mid-run (inserting/removing lines) never skips or repeats work, and it survives `/reload`. `--batch N` groups N items per turn; `{item}` and `{index}` are substituted (or the items are appended if you omit them). An optional leading interval sets the per-item delay: `/loop 30s --each ./todo.txt …`. `LOOP: retry` re-runs the current item. |
| **Re-read** | `/loop 5m --file ./notes.md summarize what's new` | Every interval, reads the file's **current** contents and runs the task on them. Add `--on-change` to skip the run when the contents are byte-identical to last time. |
| **Command** | `/loop 1m --cmd "gh pr checks 123" --on-change summarize failures` | Every interval, runs the shell command (30s timeout, configurable) and injects its output — `--watch` for things that aren't files: CI status, queue depth, service health. `--on-change` fires only when the output differs from the previous run. |

For **watch**/**re-read**, contents are injected via a `<file path="…" untrusted="true">…</file>` block, or the `{contents}`/`{file}` placeholders. For **cmd** it's a `<command-output command="…" untrusted="true">…</command-output>` block, or `{output}`/`{cmd}`. The `untrusted="true"` marking tells the agent to treat injected content as data, not instructions (see the security note below). Injected contents are capped at `--loop-file-max-kb` (default 16 KB, UTF-8 safe truncation).

Creation-time checks catch typos: `--each` refuses a missing or empty worklist file; `--watch`/`--file` warn when the path doesn't exist yet (watch then waits for it to appear).

> Note: `/loop --watch ./x do Y` overlaps with the simpler `/loop 5m read ./x and do Y` (the agent's own read tool). Reach for `--watch`/`--on-change` when you want **change-driven** firing rather than time-driven.

## Default maintenance prompt (`loop.md`)

Bare `/loop` runs a built-in careful-babysitter prompt unless you override it. Resolution order (project wins over user, **read at fire time** so edits apply to the next iteration of already-running loops, truncated at 25 KB):

1. `<cwd>/.pi/loop.md`
2. `~/.pi/loop.md`
3. built-in default

Example `.pi/loop.md`:

```md
Check the current branch and PR.
If CI is failing: fetch logs, find the smallest low-risk fix, apply it, run the relevant test, summarize.
If there are review comments: address only concrete requests, no broad refactors, leave a concise summary.
If everything is green and quiet, say so in one line — and if the PR merged, say LOOP: done.
```

## Configuration (CLI flags)

| Flag | Default | Purpose |
| --- | --- | --- |
| `--loop-max` | `50` | Max concurrent loops per session. |
| `--loop-default-interval` | `10m` | Interval used by bare `/loop`. |
| `--loop-expiry-days` | `7` | Days before a loop expires (matches Claude Code). |
| `--loop-self-min` / `--loop-self-max` | `1m` / `1h` | Self-paced delay bounds (also clamp `NEXT:`). |
| `--loop-watch-interval` | `1s` | How often `--watch` polls a file for changes. |
| `--loop-watch-dir-interval` | `2s` | How often `--watch` rescans a directory (a full tree walk). |
| `--loop-file-max-kb` | `16` | Max KB of file/command contents injected into prompts. |
| `--loop-cmd-timeout` | `30s` | Timeout for `--cmd` command runs. |
| `--loop-steer-hint` | `true` | Append a `NEXT:`/`LOOP:` steering hint to loop-fired prompts. |

(`registerFlag` only supports boolean/string, so numeric flags are passed as strings.)

## How it works

The whole feature rests on one verified fact from Pi's own `send-user-message.ts` example:
**`pi.sendUserMessage(prompt)` triggers a turn when the agent is idle** (and throws if streaming without `deliverAs`). So:

- A trigger (timer, file poll, command run) never fires a prompt directly — it only *arms a pending fire*.
- The fire is *released* when the agent goes idle, tracked via the `agent_start` / `agent_end` events.
- Multiple triggers elapsing during a long turn collapse to a **single** fire (no catch-up storm).
- When several loops are pending, the one **waiting longest fires first** — a tight loop can't starve a slow one.
- Prompts are resolved at **fire time**: file contents, worklist items, `loop.md`, and `/skill:` expansions are all re-read, so edits apply to the next iteration.
- A watchdog unsticks the engine if a send never becomes a turn; `session_shutdown` clears all timers; loops (including pause state, worklist progress, and run counts) are restored across `/reload` and `--resume` via `appendEntry`, dropping any past their 7-day expiry (an idle watch loop is also expired by a periodic sweep).

The engine invariants (idle-gating, collapse, fairness, sentinel handling, persistence round-trips, all loop modes) are covered by the test suite:

```bash
npm run build && npm test
```

## Limits & when not to use it

`/loop` is **session-scoped** — it only fires while Pi is open and idle, and loops expire after 7 days. For durable, laptop-closed automation use OS cron, CI, or a hosted runner instead.

**Headless.** The status widget and notifications are TUI-only. In a non-TUI session (e.g. `--mode json`), loop notifications (started/fired/expired/complete/stopped) fall back to `<cwd>/.pi/loop.log` so there's still an audit trail.

## Slash-command targets

You can point a loop at a `/slash` target (e.g. `/loop 20m /skill:review-pr 1234`). How it's handled depends on what the target is — and on a hard API limit: Pi's public extension API has **no way to execute a command, prompt template, or skill on demand** (`sendUserMessage` calls `prompt(text, { expandPromptTemplates: false })`, which the source comments as *"skip command handling and template expansion"*, and the extension context exposes no `prompt()`/`runCommand()`). Given that, pi-loop does the most it can:

| Target | Behavior |
| --- | --- |
| **Skill** — `/skill:name [args]` | ✅ Expanded to the exact `<skill>…</skill>` block (rebuilt with the exported `loadSkills` + `stripFrontmatter`, identical to `AgentSession._expandSkillCommand`) — **re-expanded at every fire**, so skill edits apply to the next iteration. |
| **Prompt template** (`source: "prompt"`) | ⚠️ Refused with guidance — templates live in the session's private registry; no public expander. Loop the prompt text directly, or wrap it as a skill. |
| **Extension command** (`source: "extension"`) | ⚠️ Refused with guidance — handler-commands can't be fired on a timer via the public API. |
| **Unknown** `/foo` | Sent verbatim as literal prompt text. |

So the fully-supported way to loop a "slash command" is to express it as a **skill** and loop `/skill:name`. If you need to loop an arbitrary extension command on a timer, that requires a new Pi API (e.g. `ctx.prompt(text)` / `runCommand`) — worth a feature request upstream.

## From source (development)

For development from this checkout, you need Pi (the `pi` CLI) and Bun ≥ 1.1.0 on your PATH:

```bash
bun install
bun run build      # emits dist/ (what the pi.extensions manifest points to)
pi install ./      # in-place dev install; edits apply after a /reload
```

## License

pi-loop is made with ♥ by [@j3ssie](https://github.com/j3ssie) and it is released under the MIT license.
