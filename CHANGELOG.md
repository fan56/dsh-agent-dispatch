# Changelog

All notable changes to this project are documented in this file.

## Unreleased

## 0.1.1 (as @aiwayds/dsh-agent-dispatch) - 2026-09-28

Renamed from `@aiwayds/dsh-jev-dispatch` (same code as that package's
0.1.1): the old name said HOW (jev), the new name says WHAT (agent
dispatch advice) and matches the ecosystem's functional naming
(dsh-ask-router, dsh-subagent-registry, dsh-approval-policy, ...).

## 0.1.1 - 2026-09-28

- `timeoutMs` default 2000 → 5000: real-machine verdicts measured cold-start
  spikes past the 2s wire floor (typesafe native); the call sits inline in the
  pre-step waterfall but fails open either way, and a cold call now lands
  instead of silently timing out. The key was already configurable.

## 0.1.0 - 2026-09-28
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
