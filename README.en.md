# dsh-self-improvement

**English** | [中文](./README.md)

A **cross-session self-improvement** plugin for DeepSeek Harness: it distils each session workspace's experience into persistent memory, injects it back in later sessions weighted by importance, and adds self-retrospectives, SOP extraction and improvement proposals.

## Capabilities

| Capability | Mechanism |
| --- | --- |
| Cross-session memory | One store per session workspace, at `<workspace>/self-improvement/memory/` |
| Reuse scope | Configurable: this workspace only / shared global store (two-way) / workspace + global read-only (one-way) — see below |
| Conversation trace | Listens on `session/event`, keeps text leaf fields only (bounded and truncated) |
| Immediate error retrospective | Triggered by `agent/error`; the plugin calls the LLM in the background and persists low-risk conclusions |
| Session-end retrospective | On session disposal it writes a log and snapshot, and completes the retrospective at the next session start |
| Learning from negative feedback | Reads `messageFeedback` (**fetched on demand**); 👎 is the highest-priority evidence |
| Memory governance | Importance-weighted injection, bi-temporal invalidation, merge-on-dedup with fidelity checks |
| Idle-time consolidation | On idle / new session it induces principles, generates hypotheses to verify, and produces prefetch notes |
| SOP skill library | `playbooks/` entries carry front-matter stats and are registered as **real skills** (progressive disclosure) |
| Session handoff | Retrospectives produce `logs/handoff-latest.md`, injected at the start of the next session |
| Crash-safe persistence | Incremental snapshots while running (with write-retry backoff); automatic recovery after a hard kill |
| Poisoning defence | Server-side origin classification + imperative-statement quarantine + a second check at injection time |
| Proposal loop | Proposals have a state machine, a pending cap of 1, and rejection reasons written back into memory |

## Reuse scope (configurable)

Memory is **per-workspace by default**: experience accumulated in `F:\<workspace>` does not reach `F:\<workspace-b>`. Change the scope to `global` or `both` when you want to reuse it.

| `scope` | Behaviour | Direction |
| --- | --- | --- |
| `workspace` (default) | Reads and writes this workspace's store only; experience stays local | Closed |
| `global` | Memory is written to the global store, shared by all workspaces (the workspace store keeps only logs/queue/proposals) | **Two-way** |
| `both` | Reads this workspace's store + the global store, but new experience is written **only to this workspace, never promoted** | **One-way** |

`both` means "workspace + global read-only": **I can reuse other workspaces' experience, but other workspaces cannot see mine.**

- Read: this workspace's store (full budget) + the global store (remaining budget, deduplicated via `seen`);
- Write: this workspace's store only; `promote` is always `false`;
- Why: you get the shared accumulation without broadcasting your own experiments and preferences.

**How to change it** (no restart needed, effective immediately):

```
/selfip                      # show the current scope and config file locations
/selfip scope both           # switch this workspace to "workspace + global read-only"
/selfip global scope global  # write the global config, affecting all workspaces
/selfip globalDir D:\exp     # move the global store elsewhere
```

You can also edit the config files directly, or let the model call the `selfip_config` tool:

- Global config: `${DSH_HOME}/self-improvement/config.json` (affects all workspaces)
- Workspace config: `<workspace>/self-improvement/config.json` (**higher priority**, this workspace only)
- Environment variables: `SELFIP_SCOPE` / `SELFIP_GLOBAL_DIR` (highest priority, handy for experiments)

```json
{
  "scope": "both",
  "globalDir": "${DSH_HOME}/self-improvement",
  "autoPromote": false
}
```

### About promotion

`both` is one-way reuse, and **promotion is leakage**, so promotion is disabled entirely in that mode: neither automatic promotion nor the `/promote` command nor the panel button will do anything — they refuse and explain why. The `autoPromote` key is still accepted, but outside `global` it currently has no effect; it is kept for backwards compatibility with existing config files.

> To make experience visible to every workspace, switch to `scope=global`: that mode writes the global store directly and needs no promotion step.

**How the global store grows**: written by workspaces running in `global` mode, or maintained by hand under `~/.dsh/self-improvement/self-improvement/memory/` (note that `memoryRootOf` appends one more `self-improvement` segment after `globalDir`, so `globalDir` points at the DSH home, not at the store itself).

**Sharing semantics and boundaries**:

- If the global store is not writable (read-only sandbox, invalid path), writes **degrade to this workspace** and say so in the result — never a silent loss;
- After another workspace writes to the shared store, workspaces sharing it in this process are **notified to rebuild their injection** (they do not have to wait for the next round);
- Global entries sit after workspace entries in the injection block, so on conflict the workspace conclusion wins;
- `/forget` invalidates matching entries in **both** stores.

### Layering and switching semantics (important)

The two stores are **siblings, not nested**: the same layout (`config.json` + `memory/` + `logs/` + `playbooks/` + `proposals/`) exists once in the global store and once per workspace. The global store is a synthetic store in memory (`isGlobal: true`); it is not in the `stores` table and does not participate in LRU eviction or session teardown.

At parse time `scope` compiles into four switches, and every behaviour is driven by them (`resolveConfig`):

| scope | `readWorkspace` | `readGlobal` | `writeGlobal` | `promote` |
| --- | --- | --- | --- | --- |
| `workspace` | ✅ | ❌ | ❌ | ❌ |
| `global` | ❌ | ✅ | ✅ | ❌ |
| `both` | ✅ | ✅ | ❌ | ❌ (constant — promotion is leakage) |

- `readGlobal` governs **both injection and search**: in `workspace` mode `memory_search` runs with `includeGlobal` false, so global entries are not searchable either (not merely uninjected); in `global` mode even this workspace's store is not read.
- `both` is the only mode that **reads both layers**: the main block is this workspace's store (full budget), the supplementary block is the global store (remaining budget + `seen` dedup); writes still land only in this workspace, so it is **one-way into this workspace**.
- `promote` is always `false`: no scope broadcasts workspace entries. To make experience visible across workspaces you must switch to `global` explicitly (writing the shared store) rather than relying on promotion.

**Switching scope is a mask, not a migration** — deliberate, but you must know the consequences:

- Memory files under `memory/` **stay exactly where they are**; only `proposals/` migrates with the scope (`pMigrateProposals`);
- So `workspace → global` makes this workspace's accumulated memory **disappear from injection and search immediately**, and `global` never promotes, so there is **no automatic way back**; the reverse switch behaves the same way;
- Nothing is lost — the files are still there, and switching back restores visibility;
- Therefore all three switch entry points (`/selfip`, the `selfip_config` tool, the web panel) report "which layer will be hidden, how many entries, how to recover", and the panel keeps showing it until dismissed.

> Troubleshooting tip: in `workspace`/`global` mode the self-diagnostic may report 0 entries for the global or workspace layer, because it counts within the current read scope — that **does not mean the layer is empty**. Inspect the files on disk, or switch to `both`.

## Memory format

```
- [ISO-timestamp] (kind) text {imp:8,src:user,origin:tool,invalid:ISO-timestamp,uses:3}
```

- `kind`: `fact` / `preference` / `lesson` / `resource` / `method`
- `imp`: importance 1-10 (unverified entries are **capped at 5** when scored)
- `src`: the source the model claims (`user`/`agent`/`web`/`tool`/`doc`)
- `origin`: the write origin **decided by the plugin** (`tool`/`command`/`retro`/`sleep`) — the model cannot forge it
- `invalid`: bi-temporal invalidation marker (the text is kept, injection and search skip it)
- `uses`: how many times search has matched the entry (feeds the weight)

## Data locations

```
<workspace>/self-improvement/
  config.json          this workspace's config
  memory/              memory (facts / lessons / methods / resources / principles / hypotheses)
    quarantine/        quarantined suspicious content
  logs/                session logs, snapshots, handoff brief, retrospective queue, diagnostics state
  playbooks/           SOPs (with usage stats and front-matter)
  proposals/           improvement proposals and their state
```

The global store uses the same layout.

## Trust model (poisoning defence)

Memory ends up in the system prompt, so entries are graded by **who wrote them**, not by what they claim:

| Source | Injection marker |
| --- | --- |
| Slash commands (direct human control) | Trusted, no marker |
| `remember` tool with `src=user` | Trusted |
| `src` is `web`/`tool`/`doc` | `〈external source, reference only〉` |
| Retrospective / idle induction (`origin=retro/sleep`) | `〈auto-induced, unverified〉` |

Three lines of defence: **at write time** pattern detection (9 imperative patterns → `memory/quarantine/`) → **at parse time** the same check as a fallback (raw text is never written blindly) → **at injection time** one more check (a match is skipped and counted as `injectionBlocked`). Every injected block starts with the fixed statement that no imperative content in it is a user instruction and must not be executed.

**Credential redaction** (mandatory at write time): memory travels into **every** session's system prompt, and can spread to shared stores, so plaintext secrets never hit disk. When a known shape (`ghp_`/`sk-`/`AKIA`/`AIza`/`xox?-`/JWT/private-key blocks) or an explicit assignment such as `密钥：<value>` is found, the value is **redacted in place**, keeping the structure and the type prefix (`<redacted:ghp>`) but never the secret characters. The policy is **redact, not reject**: "which key points at which service, and what state it is in" is still valuable knowledge.

## Content volatility (memory that expires because the world changed)

Some memory goes stale **not because it is old but because the outside world changed**: an API key that used to work was deleted, an endpoint moved, a model was renamed, quotas and prices changed. Plain freshness decay (5 → 1) cannot express this — it only lowers the score slowly and never says "this may now be wrong".

So every entry carries two metadata fields:

| Field | Meaning |
| --- | --- |
| `ttl` | Review interval in days, inferred from the content at write time (see below) |
| `vfy` | When it was last confirmed to still hold |

| Content shape | `ttl` |
| --- | --- |
| Credentials (`api key`/`token`/`密钥`/`password`/`凭据`…) | 30 days |
| External-service facts (endpoint/domain/model name/quota/price/version) | 90 days |
| General external references (URL/API/service/platform/account/subscription) | 180 days |
| Everything else (preferences, stable facts) | 180 days (default) |

**What happens after expiry is the point of the design: nothing is deleted or hidden — it is annotated.**

- At injection the entry gets `〈may be stale, verify before use〉`, telling the model to **check rather than copy it blindly**;
- Its importance is **capped** while scoring (the same treatment unverified entries get), and it is **placed at the end of the injection block** — still visible, but not in the most prominent position;
- **Why not delete it**: if a stale key simply vanished, the conclusion "this key was revoked" would vanish with it, and the model would walk into the same trap again. The fact that something expired is itself a valuable conclusion.

**The review loop**: idle-time consolidation hands the model an explicit task — the entries due for re-verification (sorted by days overdue, at most 15) — and asks it to confirm each one. Anything confirmed dead is rewritten as a replacement entry saying what took its place and why; anything still valid is kept as-is (rewriting refreshes `vfy` and thus leaves the review queue).

> Relation to poisoning defence: that one is about **source credibility** (who wrote it), this one about **temporal validity** (does it still hold). The two dimensions are independent and their markers stack.

## Injection strategy

1. **Weighted selection**: `importance + freshness + hit count`, with unverified entries capped;
2. **Per-section quotas**: facts/lessons get 900 characters each, methods/resources 700 each, consumed in score order;
3. **Budget accounting**: the real limit is `injectChars - WRAPPER_CHARS(260)` — wrapper overhead counts against the budget;
4. **Priority order** (lower number kept first): handoff 0 → proposals 1 → prefetch 2 → principles 3 → hypotheses 4 → facts 5 → lessons 6 → methods 7 → resources 8 → SOP list 9;
5. **How it degrades**: drop whole sections → shrink line by line → explicitly report which sections were dropped (**never truncate the head**, never drop silently).

## URLs provided by the user: deterministic reminders

**This came out of a real mistake**: in one turn the user pasted a download mirror URL while I was busy troubleshooting; I wrote it into the body of `lessons.md` as *part of a solution* and **never** turned it into a standalone `resources.md` entry — it was only recorded after the user pointed it out (so the same URL ended up recorded twice).

**The root cause is not "the plugin cannot remember", but that neither write path triggers at the right moment:**

| Path | Why it misses |
| --- | --- |
| `remember` tool | The model must call it **in the moment**; whether something deserves an entry is entirely delegated to the model's diligence, exactly when it is busiest troubleshooting |
| Session end / idle induction | Waits for the session to end, long after the turn is gone; it also only extracts a `## RESOURCES` section from the conversation, with **no logic that detects "the user pasted a URL"** |
| Injection instructions | Only a vague "record useful sites proactively", with no actionable trigger |

**The fix: turn recognition from model diligence into deterministic extraction.** The plugin extracts URLs from **user messages** (with or without a scheme), and every URL not yet in the store is injected as a "URLs awaiting a verdict" block with an explicit action: if it is reusable, `remember` it as a resource **in this turn**, including its limitation (e.g. "tarballs only, no git clone"). Key properties:

- **It repeats rather than reminding once**: even if the moment is missed, every later injection lists it again until it is recorded;
- **It disappears once recorded**: the comparison is against the union of all stores (workspace + shared), so it never becomes noise;
- **The render path stays synchronous and pure**: `systemPrompt.section`'s `text` is used as a synchronous string by both the runtime and the tests (`.text(...).includes(...)`), so the "already recorded" set is maintained asynchronously by `refreshRecordedUrls` into a `Set`, and rendering only does `candidates − recorded` without touching disk.

**Known limit**: URLs come from **this session's conversation trace** (last 40 messages × 400 characters), so the mechanism is per-session — finding "a URL the user gave earlier but nobody recorded" across sessions is out of scope (it would mean scanning historical session logs, which is far more expensive; not implemented).

## Retrospective queue (at-least-once semantics)

- Entries carry `attempts` / `lastAttemptAt` / `lastError`;
- **An entry leaves the queue only after the retrospective succeeded and was persisted**; on failure the entry stays, the attempt counter grows, and a retry is scheduled after a 30-minute backoff;
- **Read-modify-write of `pending.md` must happen inside one lock** (`withPendingLock`). This queue has three writers that do not know each other: crash recovery appends, a successful retrospective deletes a batch, a failed one increments `attempts`. File I/O — and an entire LLM call — sits between their reads and writes, so a stale snapshot can overwrite entries appended in the meantime. **A session snapshot was actually lost this way**: the log said "added to the retrospective queue" while the queue did not contain it, making crash recovery useless. It was **intermittent** (~2%, scheduling-dependent) and only showed up under repeated runs; after the fix, 42 consecutive runs failed 0 times.
- Merging must exclude not only the keys handled in this batch but also the keys **deduplicated out of the queue / moved to the dead-letter file in this round**: the file is read before the deletion actually happens, so the second read still sees them, and without the exclusion the just-deduplicated entries would be written back (a regression introduced while fixing the previous item, caught again by `contract.mjs`'s "deduplicated evidence leaves the queue" case).
- More than 5 attempts → move to `logs/pending-dead.md` and count it in the self-diagnostic (never disappears silently);
- Evidence files get a `[[SELFIP-RETRO-DONE]]` sentinel so the same session is not retrospectively processed twice from a `partial` and a `final` file.

## LLM calls (timeout / cancellation / cost)

- Every call carries a `signal` and a 45-second timeout (managed by the cordis timer), so **a hung stream cannot paralyse the workspace**;
- **Background induction does not copy the session's reasoning effort**: retrospectives/consolidation/compaction are extraction-and-rewrite tasks, and if the session runs at a high `reasoningEffort`, a reasoning model counts reasoning tokens against the **output budget**, eating `retroMaxTokens` → `finish` becomes `max-tokens` → conclusions can only be discarded conservatively (burning tokens *and* lowering quality). Background calls therefore pick the cheapest level the adapter declares: `off` if available, otherwise the last entry; **when metadata is unavailable it falls back to the session's choice**, so behaviour never changes because of missing metadata. Symptoms of getting this wrong: `retroTruncated`/`retroAborted` growing steadily.
- Usage is accumulated into `store.cost.byKind` (error-retro / session-retro / sleep / compact / manual-retro);
- A per-workspace daily token budget (400k by default); once exhausted it degrades gracefully and is visible in the self-diagnostic;
- Output over the limit is **recorded explicitly** instead of being truncated silently.

## Timer access (host-shape compatibility)

Timers are accessed only through the public contract, never by reading the service instance's internals:

| Order | Source | Note |
| --- | --- | --- |
| 1 | `ctx.timeout` / `ctx.interval` | the documented API of `@deepseek-ai/cordis-plugin-timer` (mixin on ctx) |
| 2 | `ctx.timer.timeout` / `.interval` | same-named methods on the service instance |
| 3 | `ctx.timer.setTimeout` / `.setInterval` | the officially retained deprecated aliases (real instances have been seen with only the aliases) |

- When no usable timer is found it **fails explicitly and logs the reason** instead of silently skipping registration — the panel once had `timer.interval` swallowed by an outer `try/catch` that was not a function, leaving a permanent 404 with a single stderr line;
- Waiting for `webServer` to become ready reuses the same lookup chain, so all three host shapes get a working panel.

## Trigger matrix

| Moment | Action |
| --- | --- |
| `agent/created` | Warm the memory cache early (before the first assembly if possible) |
| `agent/session-start` | Create/prime the store, recover unfinished snapshots, complete pending retrospectives, idle consolidation (with cooldown) |
| `agent/error` | Pull 👎 → record the error → debounce 6s, then retrospective immediately (≤3 per session, ≥60s apart) |
| `tools/result` | Count calls and failures; a failure triggers a debounced snapshot |
| `session/event` | Conversation trace |
| `session/flush`, `agent/turn-stopping` | Incremental snapshot when something changed |
| `agent/status` → idle | Idle consolidation after 5 minutes (6-hour cooldown per workspace, persisted across restarts) |
| `agent/disposed` | Main session: read negative feedback → write the session log → enqueue the retrospective → mark the snapshot done (**no promotion**: no scope broadcasts workspace entries); delegated session: only roll errors up to the parent |

> **Main vs delegated session**: decided from `SessionHeader.delegationDepth` (a subagent is parent + 1) and `origin: 'subagent'` — **not** from `agents.roots()`, because subagents spawned in this harness are runtime roots too. A delegated session writes no log, enqueues no retrospective and triggers no consolidation; its failures reach the parent record as a roll-up summary (or `logs/subagent-rollup.md`).

## Pending proposals: how the user finds out

Proposals exist so that high-risk changes require human confirmation, but the user cannot see the system prompt — **someone has to relay them into the conversation**. Three channels:

| Channel | Mechanism | Needs the model? |
| --- | --- | --- |
| Injection notice | Every assembly lists pending proposals (id + summary) and **explicitly requires the model to report them in the first line of its reply** | Yes |
| Slash commands | `/proposals` lists, `/proposals accept\|reject <id> [reason]` decides — the user can find and settle them alone | No |
| Tool | `selfip_proposal(decision: list)` lists them; decisions are readable by the model afterwards | No |

Supporting constraints:

- Injected proposals **carry a first-line summary** (a bare filename does not tell the model what the proposal wants);
- Pending cap of 1: once full, new proposals are not persisted; instead a lesson is written and logged under `logs/`, to avoid nagging;
- A rejection reason is written into memory, and retrospectives use it to **stop proposing the same class of change**;
- Accepting only changes state: the plugin never edits its own code — implementation stays with the model/human via the files under `proposals/`;
- `selfip_status` exposes `proposals.pending`, `proposals.pendingSummary` and the decided list for diagnosis.

## Tools

- `remember(kind, note, importance?, source?)` — persist one memory (suspicious content is quarantined automatically)
- `memory_search(query, limit?)` — search older memory (a hit raises the entry's weight; searches the global store too, per scope)
- `playbook_use(slug, outcome)` — record an SOP usage result (drives success-rate ranking and "due for review")
- `selfip_config(scope?, globalDir?, autoPromote?, target?)` — read/set the reuse scope (no arguments = read only)
- `selfip_proposal(decision, id, note?)` — `accept` / `reject` / `list`; rejection reasons are written back into memory
- `selfip_status()` — self-diagnostic (below)

`selfip_status` reports: workspace, **scope configuration and global store size**, sandbox policy vs session-mode conflicts, injection length (including wrapper), pending/decided proposals, session snapshots, **dead letters, injection blocks, rejected compactions, skipped recoveries, truncations, token cost**, and read/write errors. Global entries also carry a `cacheMismatch` marker, so "the file has entries but the injection cache is empty" is visible immediately.

## Slash commands

- `/remember [kind:] content` — write memory directly (trusted source)
- `/memory [keyword]` — show store status or search (including the current scope and config file locations)
- `/forget keyword` — invalidate matching entries (bi-temporal; both stores at once)
- `/retro` — run a retrospective for this session now
- `/selfip [scope X|globalDir X|autoPromote on|off] [global]` — read/change the reuse scope
- `/promote [n]` — (retired) under one-way reuse promotion would leak this workspace's experience, so the command refuses and points at `scope=global`
- `/proposals [list|accept <id>|reject <id> [reason]]` — inspect/handle improvement proposals awaiting your decision

## Install and uninstall

```sh
dsh plugin --profile web add "file:C:/Users/<user>/.dsh/plugins-src/dsh-self-improvement"
dsh --profile web --dump-config | Select-String self-improvement   # verify without restarting
dsh plugin --profile web remove dsh-self-improvement               # uninstall (workspace memory is kept)
```

DSH must be **restarted** before the plugin loads.

### ⚠️ Always reinstall after editing the source

pnpm **copies** `file:` dependencies instead of symlinking them, so "edit the source → restart" still loads the old code:

```
edit lib/index.js  →  profile keeps the old copy  →  the restart still loads the old version
```

This bit us once: the source was 108,006 bytes while the profile copy sat at the 28,982 bytes captured at install time, so the restart ran the **original** version and two rounds of fixes were never live (the symptom: `selfip_status` returned old fields). The reliable sequence:

```powershell
# 1) edit the source and run the tests
node tests/smoke.mjs; node tests/contract.mjs; node tests/audit.mjs; node tests/memory-regression.mjs
# 2) reinstall (refreshes the copy)
dsh plugin --profile web remove dsh-self-improvement
dsh plugin --profile web add "file:C:/Users/<user>/.dsh/plugins-src/dsh-self-improvement"
# 3) verify the copy's hash matches the source
$src='C:\Users\<user>\.dsh\plugins-src\dsh-self-improvement\lib\index.js'
$dst='C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-self-improvement\lib\index.js'
(Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash
# 4) after restarting, confirm the field set via selfip_status (newer builds add policyModes / cost / injectionChars / truncations)
```

**Do not switch to `link:`**: a symlink makes module resolution start in the source directory, where peer dependencies such as `@deepseek-ai/dsh-tools` cannot be resolved (`Cannot find package`).

## Tests

```sh
node tests/smoke.mjs              # end-to-end smoke (stub ctx, fast)
node tests/memory-regression.mjs  # memory regression (injection fidelity under growth/compaction/invalidation)
node tests/contract.mjs           # contracts and fault injection (real defineTool / fences / feedback wrapper / queue semantics)
node tests/audit.mjs              # new-code-path audit (LRU / state persistence / policy isolation / budget / timeout / skills / concurrent dedup / timer shapes)
node tests/aux-effort.mjs         # model parameters for background induction (effort downgrade and fallback)
node tests/scope-visible.mjs      # scope-switch visibility reporting (which layer is hidden; data untouched)
node tests/panel-scope.mjs        # panel scope consistency (in global mode both display and writes use the global store)
node tests/panel-render.mjs       # panel rendering (minimal React stub; asserts the card shows the effective store)
node tests/one-way-share.mjs      # one-way reuse semantics of both (workspace experience never leaks out)
node tests/parser-tolerance.mjs   # parser tolerance + real model-output fixtures (first line of defence when switching models)
node tests/search-and-evict.mjs   # CJK search relevance + score-based eviction + health counters persisted
node tests/timestamps.mjs         # localised (offset-carrying) timestamps and local-day budget accounting
node tests/audit-regressions.mjs  # regressions for defects found by the independent adversarial audit (PLAYBOOK/CRLF/panel caps/both no-leak…)
node tests/volatility.mjs         # content volatility (ttl / due-for-review / review list) and credential redaction
node tests/debug-compact.mjs      # single-point debug of the compaction chain
node tests/debug-queue-race.mjs   # reproducer for the retrospective-queue race
node tests/debug-scope.mjs        # manual verification of scope and global-store read/write paths
```

`contract.mjs` covers the class of things "a stub test can never catch": real schema compilation and argument validation, sandbox fence branches, the real feedback wrapper, async streams, and fault injection (429, write refusal, queue retry, dead letters, dedup sentinels). It includes sentinel assertions — if `defineTool` is replaced by an identity stub, they must fail.

`aux-effort.mjs` is a separate file rather than part of `audit.mjs`: the plugin's `apply` captures the incoming `ctx` in a module-level closure, and `audit.mjs` applies it a dozen times in one process, so the closure always points at the last one — a "new instance per case" style cannot observe real behaviour there. Any case that needs precise control over the host shape or over what `ctx.get(...)` returns belongs in its own file.

## Test-fidelity principles

The value of this suite rests entirely on the stubs resembling a real host, so a few rules are non-negotiable:

- **Stubs must expose the service keys the plugin actually reads**: the plugin uses `ctx.get('llm')` and `ctx.get('agents')`; a stub that only sets `ctx.llm` silently sends features down their fallback branches while the test still "passes";
- **Asynchronous assertions always poll**, never a fixed `sleep` — false failures on a busy machine hide real defects;
- **Stub writes must make non-atomic scenarios controllable**: temp file + atomic rename, with retries for `EPERM` on Windows, otherwise a concurrent reader sees 0 bytes and invents a "lost write";
- **Cases needing precise host control live in their own file**: `apply` captures `ctx` in a module-level closure, so applying it repeatedly in one process makes cases contaminate each other;
- **Every test isolates `DSH_HOME` into a throwaway directory**: otherwise test fixtures get promoted into the real global store.

Every test is driven by a stub `ctx` and never calls a real model, so the suite runs offline anywhere:

```sh
npm test                      # all 17 suites
node tests/smoke.mjs          # or run one on its own
```

## License

MIT
