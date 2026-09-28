# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- feat: `mode: 'auto'` — the local keyword gate. Every ordinary user turn is
  matched against the new `autoKeywords` list first, IN PROCESS (plain string
  matching, no network, no clock, no state), and only a hit earns one jev
  verdict. A turn that hits nothing is returned untouched and completely
  silent: no call, no injection, no log line, no data shared. That gate — not
  "ask jev about every turn" — is the whole difference the mode adds. Explicit
  `/dispatch` and `/jev` triggers are matched first, are never gated, and keep
  their semantics in every mode (a capability gap still answers with a
  diagnostic, a `/jev` skip is still rendered).
- `autoKeywords` defaults to a 54-entry bilingual task-verb dictionary: 29
  Chinese phrases matched as substrings (Chinese has no word boundaries; single
  characters like 写/改/加 are deliberately absent, they appear in small talk)
  and 25 ASCII words matched on word boundaries (so `fix` misses `prefix` and
  `add` misses `address`), both case-insensitively. The list is replaceable as
  a whole. `mode: 'auto'` with an EMPTY list is a load error: a gate that looks
  on and can never fire is exactly the silent mismatch this plugin refuses —
  `once` is the mode for explicit requests only.
- `auto` without `logDir` logs one extra boot info line. The gate's misses are
  invisible by design, so the verdict log is the only channel that says which
  keywords earn their call.
- Keyword-hit turns record `trigger` as `"kw:<keyword>"` in the verdict log
  (explicit turns still record the trigger word itself) — the label that makes
  the gate calibratable. A keyword-hit turn that jev skips still renders
  nothing and logs no `skip —` info line, and a failed capability gate stays
  silent for it too: it never asked for a verdict, so a gap in the subagent
  stack is not its business. No new threshold keys — the worst-case added
  latency is still bounded by the existing `timeoutMs` (default 5000).
- docs: the package's `cordis.patch.yml` comment now describes both `once` and
  `auto` (local gate semantics included); `config: {}` stays empty.
- docs: README (zh/en) — third mode documented in Usage, `autoKeywords` row
  added and the `mode` row rewritten in both config tables, Privacy now states
  that `auto` only sends a turn that cleared the local gate (the gate itself is
  zero-network), verdict-log section documents the `kw:` label. This supersedes
  the 0.1.0 note that `auto` was deliberately out of scope — it lands now,
  gated locally instead of classifying every turn.
- docs: the `timeoutMs` config row still said `2000` and justified it as
  "shorter than the core's 5s default"; the default has been 5000 since 0.1.1,
  so the row and the argument built on it now match the code.

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
