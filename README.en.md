# dsh-self-improvement

**English** | [中文](./README.md)

Cross-session self-improvement for DeepSeek Harness: it captures what each session's workspace learns, then feeds that knowledge back into later sessions through importance-weighted prompt injection — plus retrospectives, SOP extraction and improvement proposals.

## The problem it solves

An agent starts from zero every session. Pitfalls it already hit, preferences the user explicitly stated, methods that were proven to work — all of it is lost. Dumping long-term notes into `AGENTS.md` doesn't scale either: it grows without bound and eventually drowns in noise.

This plugin provides a maintainable memory channel. Writes carry **provenance and trust grading**; reads are **ranked by importance and recency**; and when the budget runs out, entries are dropped **by score instead of silently truncated**.

## Features

| Capability | Description |
| --- | --- |
| Cross-session memory | Stored per conversation workspace; survives restarts and session switches |
| Five memory kinds | `fact` / `preference` / `lesson` / `resource` / `method`, one file per kind |
| Weighted injection | Selects by `importance + recency + hit count`, not just newest-first |
| Configurable reuse scope | Per-workspace only / shared global library / local accumulation plus global supplement |
| Immediate error retro | `agent/error` triggers a background retrospective (debounced, rate-limited, with a daily token budget) |
| Session-end retro | Writes session logs and snapshots; the retrospective runs at the start of the next session |
| Sleep-time consolidation | While idle, induces higher-level principles, drafts hypotheses to verify, and prepares prefetch points |
| Negative-feedback learning | Reads `messageFeedback`; a 👎 is the highest-priority evidence |
| Memory governance | Bi-temporal invalidation (marks, never deletes), automatic dedup/merge with fidelity checks, line-wise eviction with a trace when a file hits its cap |
| SOP skill library | Reusable methods extracted during retrospectives land in `playbooks/` and are registered as a **real skill** (progressive disclosure) with usage statistics |
| Session handoff | Retrospectives produce `logs/handoff-latest.md`, injected at the start of the next session |
| Crash-safe persistence | Incremental snapshots while running (retried on write failure); unfinished sessions are recovered on startup |
| Poisoning defence | Write provenance decided by the plugin, imperative-statement quarantine, and a second check at injection time |
| Improvement proposals | The plugin's suggestions about itself go through a state machine and require human approval; rejection reasons are written back to memory |
| Web panel | Shows memory, queue, cost and proposals above the composer; add/invalidate entries and switch scope |
| Zero context cost | Memory is injected through the system prompt, consuming no conversation turns |

## Installation

Install as a DSH profile plugin:

```sh
# install from a local directory
dsh plugin add /path/to/dsh-self-improvement
```

Alternatively place this directory under `~/.dsh/plugins-src/`, where `cordis.patch.yml` registers it into the profile layer stack.

Restart `dsh web` (or the relevant profile process) to activate.

## Quick start

The plugin starts working as soon as it loads; no extra setup is normally required.

| Entry point | Purpose |
| --- | --- |
| Just state a preference in conversation | The model calls the `remember` tool |
| `/selfip` | Show the current reuse scope and config file locations |
| `/selfip scope both` | Switch the reuse scope |
| `/memory <keyword>` | Search memory |
| `/forget <keyword>` | Invalidate matching entries (marks them; history is kept) |
| `/retro` | Run a retrospective on the current session immediately |
| `/promote` | Manually promote general entries to the global library |
| `/proposals` | List and resolve pending improvement proposals |

## Reuse scope

Memory is **per-workspace by default**. Change `scope` to reuse across workspaces:

| `scope` | Behaviour |
| --- | --- |
| `workspace` (default) | Reads and writes only this workspace's library |
| `global` | Everything is written to the global library, shared by all workspaces |
| `both` | This workspace keeps accumulating, also reads the global library, and **promotes** general entries to it at session end |

Precedence: **environment variable > workspace config > global config > default**.

- Global config: `${DSH_HOME}/self-improvement/config.json` (affects every workspace)
- Workspace config: `<workspace>/self-improvement/config.json` (higher precedence, affects only this workspace)
- Environment: `SELFIP_SCOPE` / `SELFIP_GLOBAL_DIR`

```json
{
  "scope": "both",
  "globalDir": "${DSH_HOME}/self-improvement",
  "autoPromote": true
}
```

No restart is needed — the change applies on the next memory refresh, and hand-edited config files are detected too.

### Switching scope changes what is *visible*

Switching `scope` only changes the **read range**; it does not move data:

- Files under `memory/` stay where they are; only `proposals/` migrates with the scope;
- `workspace → global` makes this workspace's accumulated memory disappear from injection and search immediately, and `global` mode does not promote, so it never flows back automatically (the reverse switch behaves the same way);
- Nothing is lost — switch back to a mode that reads it and it is visible again;
- So this cannot happen silently, all three entry points report which layer will be hidden, how many entries that is, and how to restore them.

**Promotion rules** — automatic promotion is deliberately conservative, so one workspace's bias is not broadcast to all of them:

- Only `user`/`agent`-sourced entries (or entries without a source mark) are promoted; external sources (`web`/`tool`/`doc`) are never broadcast;
- Workspaces under the system temp directory never broadcast (tests and one-off experiments create workspaces there);
- Ranked by `importance + recency + hit count`, at most 3 per session end, minimum score 10;
- Content is deduplicated before writing; promoted lines are tagged `{promoted:<workspace>}`.

## Trust model

Memory ends up in the system prompt, so it is graded by **who wrote it**, not by **what it claims**:

| Source | Injection mark |
| --- | --- |
| Slash commands (direct human control) | Trusted, no mark |
| `remember` tool declaring `src=user` | Trusted |
| `src` is `web`/`tool`/`doc` | `〈external source, reference only〉` |
| Retrospective / sleep induction (`origin=retro/sleep`) | `〈automatically induced, unverified〉` |

Three layers of defence: **at write time** pattern detection (imperative statements are quarantined under `memory/quarantine/`) → **parse fallback** runs the same detection → **at injection time** a final check (matches are skipped and counted). The injected section always opens by stating that any imperative content in it is not a user instruction and must not be executed.

Unverified entries have their **importance capped at 5** when scored, so they never outrank trusted sources.

## Memory format

Each entry is one line:

```
- [ISO timestamp] (kind) content {imp:8,src:user,origin:tool,invalid:ISO timestamp,uses:3}
```

- `kind`: `fact` / `preference` / `lesson` / `resource` / `method`
- `imp`: importance, 1-10
- `src`: source declared by the model (`user`/`agent`/`web`/`tool`/`doc`)
- `origin`: write origin **decided by the plugin** (`tool`/`command`/`retro`/`sleep`/`panel`) — the model cannot forge it
- `invalid`: bi-temporal invalidation mark (the text is kept, but injection and search skip it)
- `uses`: number of search hits (contributes to weighting)

## Data layout

```
<workspace>/self-improvement/
  config.json          workspace config
  memory/              memory (facts / lessons / methods / resources / principles / hypotheses)
    quarantine/        quarantined suspicious content
  logs/                session logs, snapshots, handoff brief, pending-retro queue, diagnostic state
  playbooks/           SOPs (with usage stats and front-matter)
  proposals/           improvement proposals and their state
```

The global library uses the same layout.

## Tools

| Tool | Purpose |
| --- | --- |
| `remember` | Record a durable fact, preference or lesson |
| `memory_search` | Keyword search over memory (injection only carries high-scoring entries; use this for older ones) |
| `playbook_use` | Record the outcome of using an SOP, feeding success-rate statistics |
| `selfip_proposal` | List and resolve improvement proposals awaiting user confirmation |
| `selfip_config` | Inspect or set the memory reuse scope |
| `selfip_status` | Plugin self-diagnostics (per-workspace library state, sandbox policy, write/read errors, run counters) |

## Injection strategy

- **Weighted selection**: `importance + recency + hit count`, with unverified entries capped;
- **Per-section quotas**: 900 chars each for facts/lessons, 700 each for methods/resources, consumed by score;
- **Budget accounting**: the real limit is `injectChars - 260`; wrapper overhead counts against the budget;
- **Priority order**: handoff → proposals → prefetch → principles → hypotheses → facts → lessons → methods → resources → SOP list;
- **Eviction**: whole sections first, then line-wise shrinking, and dropped sections are always named (never head-truncated, never silently discarded).

## Reliability

- **At-least-once retrospectives**: queue entries carry `attempts` / `lastAttemptAt` / `lastError`; an entry leaves the queue only after a retrospective succeeded and was persisted, otherwise it retries with a 30-minute backoff. After 5 attempts it moves to a dead-letter queue and is counted in diagnostics;
- **Crash recovery**: incremental snapshots while running; unfinished sessions are recovered at startup. Evidence files carry a completion sentinel so a session is never retrospectively processed twice (which would burn tokens twice);
- **Isolated background calls**: retrospectives, sleep consolidation and compaction use their own LLM channel with a `signal` and a 45-second timeout, consuming no conversation context. Reasoning effort is taken from the cheapest level the adapter declares, so the output budget is not spent on thinking;
- **Write fallback**: if the global library is not writable (read-only sandbox, invalid path), writes degrade to the local workspace and the result says so — never a silent loss;
- **Budget and visibility**: a daily token budget per workspace, degrading gracefully when exhausted; diagnostics expose cooldown state, cost, queue length, write/read errors and quarantine counts.

## Tests

```sh
node tests/smoke.mjs              # functional smoke test
node tests/contract.mjs           # contracts and fault injection (real defineTool / sandbox fence / queue semantics)
node tests/audit.mjs              # boundaries and concurrency (cache eviction / state persistence / budget / timeout / dedup)
node tests/memory-regression.mjs  # memory regression (injection fidelity under growth, compaction, invalidation)
node tests/aux-effort.mjs         # model parameters for background induction calls
node tests/scope-visible.mjs      # visibility reporting when the reuse scope changes
```

The suites drive the plugin with a stubbed `ctx`, require no real model calls, and run offline on any machine.

## License

MIT
