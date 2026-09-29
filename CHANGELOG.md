# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- chore: raise dsh host floor to 0.2.0-rc.2 — the umbrella peer
  `@deepseek-ai/dsh` floor moves `>=0.1.7-rc.1` → `>=0.2.0-rc.2`. No code
  changes: the `agent/pre-step` waterfall surface is unchanged in 0.2.0
  (157/157 tests + `tsc --noEmit` green against the 0.2.0-rc.2 closure;
  closure relinked to the installed host tree).

- feat: `mode: 'auto'` — the local keyword gate. Every ordinary user turn is
  matched against the new `autoKeywords` list first, IN PROCESS (plain string
  matching, no network, no clock, no state), and only a hit earns one jev
  verdict. A turn that hits nothing is returned untouched and completely
  silent: no call, no injection, no log line, no data shared. That gate — not
  "ask jev about every turn" — is the whole difference the mode adds. Explicit
  `/dispatch` and `/jev` triggers are matched first, are never gated, and keep
  their semantics in every mode (a capability gap still answers with a
  diagnostic, a `/jev` skip is still rendered).
- `autoKeywords` defaults to a 45-Chinese + 40-ASCII = 85-entry bilingual
  task-verb dictionary: Chinese phrases matched as substrings (Chinese has no
  word boundaries; single characters like 写/改/加 are deliberately absent, they
  appear in small talk) and ASCII words matched on word boundaries (so `fix`
  misses `prefix` and `add` misses `address`), both case-insensitively. The list
  is replaceable as a whole. `mode: 'auto'` with an EMPTY list is a load error: a
  gate that looks on and can never fire is exactly the silent mismatch this
  plugin refuses — `once` is the mode for explicit requests only. The list was
  revised after real-machine probing found a whole band of the most common task
  phrasings silent (false negatives) while a couple of entries were far too
  broad: added the Chinese 修改/检查/删除/移除/去掉/报错/生成/梳理/提交/构建/安装/总结/对比/看一下/看看/为什么会;
  removed 为什么 (subsumed by 为什么会) and split 麻烦 into 麻烦你 + 麻烦帮;
  added the ASCII build/commit/check/explain/summarize/generate/delete/install/
  update/run/document plus the irregular forms analysis/writing/debugging/
  running/committed/verified. Removed `can you` (English politeness covers
  nearly every sentence, so it was the highest false-positive entry) and the
  dead-weight `write a` — it sat behind `write`, which matches every turn the
  phrase could, so it was unreachable, and its one-letter last word was the only
  way "write as much as you like" could forge a `kw:write a` label. The
  widening is deliberate and follows an ASYMMETRIC cost model: a false hit costs
  one jev call that in all likelihood comes back `skip`, while a miss costs the
  turn the whole feature — the user gets nothing and cannot tell a miss from a
  broken install.
- `auto` without `logDir` logs one extra boot info line. The gate's misses are
  invisible by design, so the verdict log is the only channel that says which
  keywords earn their call.
- Keyword-hit turns record `trigger` as `"kw:<keyword>"` in the verdict log
  (explicit turns still record the trigger word itself) — the label that makes
  the gate calibratable. The label is user configuration, so it is cleaned
  before it is written: CR/LF become spaces, whitespace collapses, and it is
  capped at 64 CHARACTERS. The cap counts code points, not UTF-16 code units —
  a cut between the halves of a surrogate pair leaves a lone surrogate in the
  row, and `jq` then rejects the WHOLE file the README teaches you to read
  (`Invalid \uXXXX\uXXXX surrogate pair escape`, exit 5). A keyword-hit turn
  that jev skips still renders nothing and logs no `skip —` info line.
- No new threshold keys: a keyword hit adds one jev call bounded by the existing
  `timeoutMs` (default 5000), on top of the local roster read, the redaction
  pass and the render. That call is the LARGEST part of a hit turn's added wait,
  but it is not a worst-case bound on the whole turn.
- UPGRADE NOTE: `mode: 'auto'` is a validation ERROR in 0.1.3 (`MODES` is
  `['off', 'once']`), so a config carrying it does not load today. After this
  upgrade it loads, and it really takes effect: every ordinary turn that clears
  the local keyword gate sends that turn's user text to TypeSafe Jev. If you
  ever wrote `mode: 'auto'` into a config, decide on purpose whether you want
  that outbound channel — set a `logDir` if you also want the calibration
  evidence, or go back to `once` so that explicit `/dispatch` and `/jev`
  requests stay the only turns that leave the machine.
- fix: ASCII gate matching was widened in four ways. One common inflection is
  now allowed after a stem (`s`/`es`/`ed`/`ing`/`ment`/`ments`/`d`), so
  `fixing`/`fixed`/`tests`/`deployment`/`refactoring` hit while `prefix`,
  `address`, and `addressing` still miss — and `d` is what makes an `-e` stem
  recognize its own past tense, because the plain `ed` alternative spells
  "removeed": `removed`, `deleted`, `updated`, `generated`, `migrated`,
  `upgraded`, `replaced`, `reproduced`, `investigated`, `optimized`, `analysed`
  and `diagnosed` were all silent misses before it. Second, word boundaries are
  now built from letters, digits, and underscore only, so a hyphen separates
  words (`fix-me`, `the e2e-test is red`) while the identifier `fix_it` still
  does not match. Third, the words of a multi-word entry are separated by any
  run of characters that are not letters/digits/underscores, so `help,me` and
  `help-me` hit while `help_me` and `helpXme` do not. Fourth, matching runs on a
  folded copy of the turn — NFKC (a full-width `ｆｉｘ` hits `fix`) with
  whitespace runs collapsed (so `help  me` and `help\nme` hit `help me`). The
  state sent to jev still carries the user's text as typed, redaction and the
  `stateChars` cap aside; only the `kw:` label is cleaned and truncated.
- fix: an `auto` keyword hit that runs into an incomplete subagent stack (wrong
  `agentsDir`, empty roster, `use_agent` not visible, delegation depth spent) no
  longer stays invisible. The first such turn logs ONE info line naming what is
  missing and stating that keyword-hit turns stay silent by design; later hits do
  not repeat it. The flag is per plugin instance — a remount logs it again, a new
  session does not — so the line says process, not session. Nothing is injected
  and no verdict-log row is written for those turns, exactly as before.
- docs: README (zh/en) — third mode documented in Usage; the `autoKeywords` row
  added and the `mode` row rewritten in both config tables (the English `mode`
  row said `warns at boot` where the code logs an info line, which this repo's
  own no-warning rule makes wrong); Privacy now states that `auto` only sends a
  turn that cleared the local gate (the gate itself is zero-network), and says
  plainly that a hit is sent even when the user never typed `/dispatch`; the
  verdict-log section documents the `kw:` label; the default dictionary list is
  updated on both sides (word for word, in order, with a test parsing both
  READMEs and failing if either drifts from the code) and followed by the four
  matching rules (ASCII suffix, hyphen as a separator, whitespace folding with
  the multi-word separator, NFKC); the capability-gate section states the
  one-time
  info line instead of claiming total silence; and the `timeoutMs` row no longer
  calls itself the worst-case per-turn wait (it bounds the jev call, and a hit
  turn also pays the roster read, the redaction pass, and the render) — the row
  had still said `2000` and justified it as "shorter than the core's 5s
  default", where the default has been 5000 since 0.1.1. This supersedes the
  0.1.0 note that `auto` was deliberately out of scope — it lands now, gated
  locally instead of classifying every turn.
- docs: the package's `cordis.patch.yml` comment describes both `once` and
  `auto` (local gate semantics, the one-time gap line, and the widened matching
  rules); `config: {}` stays empty.

## 0.1.3 - 2026-09-28

- fix: `scripts/smoke-boot.mjs` still hardcoded the pre-rename plugin id
  `dsh-jev-dispatch` in the scratch profile's patch entry and in the
  post-removal assertion, so the id never matched the mounted row and the
  boot smoke failed with "the profile config override did not reach the
  plugin row" — CI was red on main since the 0.1.2 rename. Plugin code is
  unchanged; this only repairs the gate. Also corrected the stale
  `@aiwayds/dsh-jev-dispatch` name in `package-lock.json`.

## 0.1.2 - 2026-09-28

First release as `@aiwayds/dsh-agent-dispatch` (renamed from
`@aiwayds/dsh-jev-dispatch`, same code as that package's 0.1.1): the old
name said HOW (jev), the new name says WHAT (agent dispatch advice) and
matches the ecosystem's functional naming (dsh-ask-router,
dsh-subagent-registry, dsh-approval-policy, ...).

## 0.1.1 - 2026-09-28

- `timeoutMs` default 2000 → 5000: real-machine verdicts measured cold-start
  spikes past the 2s wire floor (typesafe native); the call sits inline in the
  pre-step waterfall but fails open either way, and a cold call now lands
  instead of silently timing out. The key was already configurable.

## 0.1.0 - 2026-09-28

First release — the ex-ante dispatch leg of the dsh jev effort. Scope per the
wayfinder decision tickets (03 dispatch rubric, 06 core API, 08 repo):

- `agent/pre-step` mount with `prepend: true`: `await next()`, then a
  source-attributed user message appended after every other message of the
  step. A `reject` decision and an aborted turn are returned untouched, and a
  turn cancelled while the call is in flight injects nothing.
- Modes `off` (default, registers nothing) and `once` (verdict on explicit
  request only). `auto` is deliberately absent — it waits in the map's fog
  until the verdict log has earned it.
- Triggers `/dispatch <task>` (wants the recommendation) and `/jev <question>`
  (free decision request: a "do not delegate" verdict is rendered too), both
  configurable, parsed by a pure word-bounded matcher over plain user turns.
- Four-question rubric in ONE request: `dispatch` (noul), `agent` (choice over
  the roster plus a `none` abstention), `risky` (noul), `long_running` (noul).
  System One-calibrated policy, every gate independently configurable:
  dispatch ≥ 0.60 advise / ≤ 0.35 skip / middle is uncertainty; agent
  confidence ≥ 0.70 AND top1−top2 ≥ 0.15; risky ≥ 0.75 holds the delegation
  back; long_running ≥ 0.70 adds `background: true`.
- Capability gate, re-verified per request, four legs: `use_agent` visible to
  this agent, subagent provider registered, roster non-empty, delegation depth
  left (target-independent check in the gate, per-agent refinement after the
  pick). A failed gate answers an explicit request with a diagnostic and leaves
  ordinary turns completely silent.
- Roster data surface: `$DSH_HOME/agents/*.md` read fresh per request and never
  cached, parsed with the registry's strict rules (a mistyped `thinking`,
  `background` or `maxRounds` drops the file from the criteria), descriptions
  sanitized and bounded through the documented fallback chain, rendered in the
  registry's own `- <name> (<display_name>): <description>` line shape, with a
  trailing unparsable-files note. The composed model is never surfaced, and the
  rubric option label is translated back to the agent id `use_agent` takes.
- Privacy: credential-shaped redaction (the vitas pattern set) over the whole
  assembled state including the workspace path, then a `stateChars` cap; only
  plain user text is shipped, so a verdict is never re-classified from a
  previous verdict.
- jev-optional by construction: no key at boot means no listener and one info
  line; a key lost at runtime returns the turn; a typed jev error passes the
  turn through and lands in the log. No path emits a warning — degradation is
  silence, because a wrong dispatch suggestion is worse than none.
- Opt-in NDJSON verdict log (`logDir`) with `action` (what jev decided) and
  `delivered` (whether the advice reached the turn) recorded separately; log
  failures are a warn, never a throw.
- Messages are built through the pinned peer's `createUserMessage`; when the
  peer is unreachable the injection is SKIPPED rather than fabricated (one
  warn, then quiet).
- Deliberately out: `auto` mode, model-route fallback when the roster is empty,
  caching/circuit breaking/budget guards (all in the map's fog), and any
  verdict beyond an agent name plus at most `background` — `use_agent` takes no
  model, and `background`/`resume` are mutually exclusive so v1 can never emit
  the pair.
