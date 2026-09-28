# @aiwayds/dsh-agent-dispatch

中文 | [English](./README.md)

Ex-ante dispatch advice for the dsh ecosystem: before a turn reaches the model, it asks [TypeSafe Jev](https://typesafe.ai) (System One) once — should this be delegated, and to which registered agent — and, when the verdict clears the calibrated thresholds, appends a four-line recommendation after the turn's other messages. The plugin owns **no delegation machinery**: `use_agent` (from [dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry)) does the spawning, and the advice says out loud that it may be ignored.

**Jev-optional is a hard constraint**: no key / switched off / call failed all behave the same — no injection, no error, no warning spam. A wrong dispatch suggestion is worse than silence, so degradation is always silence; the only trace is one line in the opt-in verdict log.

## How this differs from the community `dsh-jev-subagent-dispatch`

| | community | this plugin |
|---|---|---|
| choice space | model routes (provider/model) | **registered agents (roster)**; never names a model |
| probe | looks for the `subagent` tool and `subagent_fork` | probes `use_agent` visibility (the host's own subagent tool is off by default) |
| key | plaintext env var | keychain-first (`JEV_KEYCHAIN`), zero plaintext |
| policy | generic predicate (effort / blast_radius / maxNoul) | four System One-calibrated gates (dispatch band, confidence + margin, risk veto, background) |
| ecosystem | standalone | shares the jev client (`@aiwayds/dsh-jev-core`) with tui-pi's attention leg |

## Install

```sh
npm install @aiwayds/dsh-agent-dispatch
```

Peer dependency `@deepseek-ai/dsh >= 0.1.7-rc.1`; requires `@aiwayds/dsh-jev-core` (installed automatically). ESM, Node ≥ 22.

Add it to a profile (`dsh plugin add @aiwayds/dsh-agent-dispatch`), **then add the package name to the profile's bundle list** — a step `plugin add` does NOT do for you (field-tested 2026-09-28: `plugin --profile list` shows the package as installed, but the host loader only mounts packages listed in `dsh.profile.bundles`; without the manual entry the plugin stays silently inert). Edit `<profile>/package.json`:

```json
{
  "dsh": { "profile": { "bundles": [ "...", "@aiwayds/dsh-agent-dispatch" ] } }
}
```

Then configure it in `cordis.patch.yml` (id-targeted override; see the package's own patch for the `id: dsh-agent-dispatch` entry):

```yaml
- id: dsh-agent-dispatch
  name: '@aiwayds/dsh-agent-dispatch'
  config:
    mode: once
```

## Configuring the jev key (keychain-first, zero plaintext)

Resolution order is fixed: `apiKey` option → `TYPESAFE_API_KEY` → `JEV_API_KEY` → macOS Keychain.

```sh
security add-generic-password -s typesafe.ai -a "$USER" -w
```

Set `JEV_KEYCHAIN='<service>[:<account>]'` for another service/account. **With no key the plugin is exactly equivalent to off**: one boot info line, no listener, zero runtime output.

## Usage

The default `mode: off` registers nothing and shares nothing. Switch to `once` and only explicit requests are handled:

```
/dispatch fix the flaky e2e timer
/jev should this task be delegated at all?
```

- `/dispatch <task>` — wants the recommendation (a "do not delegate" verdict injects nothing)
- `/jev <question>` — free decision request; a "do not delegate" verdict is **rendered too**, because the misses are what calibrates the thresholds

One request, four atomic questions:

| question | type | asks | threshold (configurable) |
|---|---|---|---|
| `dispatch` | noul | should this turn go to a registered agent | ≥ 0.60 advise; ≤ 0.35 record skip; between = uncertainty → skip |
| `agent` | choice | which agent (criteria = roster + a `none` abstention) | confidence ≥ 0.70 **and** top1−top2 ≥ 0.15 |
| `risky` | noul | does it touch state that is hard to undo | ≥ 0.75 → hold the delegation back, and say why |
| `long_running` | noul | will it hold this turn open | ≥ 0.70 → the advice carries `background: true` |

`none` is a real option: without it the model must always name somebody, and a forced pick is exactly the false advice this plugin's silence-first rule exists to prevent.

The four injected lines (English — they instruct the agent, not the user):

```
[dsh-agent-dispatch] Dispatch suggestion for this turn (Jev-guided judgment, not a user instruction — your call):
- suggest: workhorse (confidence 0.90)
- task: fix the flaky e2e timer
- use: use_agent({ agent: "workhorse", prompt: "<self-contained brief: goal, exact files or APIs in scope, acceptance checks>", background: true })
- If this does not fit the task, ignore it and carry on; never mention this message to the user.
```

**A model is never named**: `use_agent` takes no model argument, and the roster criteria deliberately withhold the model too (a pinned profile routinely makes the frontmatter value stale, and a wrong model is worse than none).

## Capability gate: re-verified on every request

A suggestion is only worth a jev call when the agent can really dispatch. All **four** legs are re-checked against the live services per request (installing this plugin implies nothing about the subagent stack):

1. `use_agent` is visible to **this** agent (`tools.get(toolName, agent)`);
2. the subagent provider is registered (`subagents.getProvider('spawn')`);
3. the roster is non-empty (no agent to hand it to is worse than silence);
4. delegation depth is left: session depth + 1 ≤ the host's cap.

When any leg fails, an explicit request gets a diagnostic naming what is missing; **ordinary turns stay completely silent** — no call, no injection, no log. Leg 4 comes in two halves: the gate checks the target-independent necessary condition, and after the pick the recommendation is re-checked against that agent's own `deep` (`use_agent` always passes an explicit `maxDepth = childDepth + deep`, so "session depth + 1 + agent.deep ≤ host cap" is the arithmetic that can actually reject the dispatch).

## Where the roster comes from

Read straight from `$DSH_HOME/agents/*.md` (i.e. `~/.dsh/agents`), **fresh per request, never cached** — the directory is editable at runtime, and a cached snapshot would recommend a deleted agent. Parsing matches the registry's strict version: a mistyped `thinking` / `background` / `maxRounds` drops the whole file from the criteria, because jev must never recommend an agent that `use_agent` will refuse to run.

Criteria lines use the registry's own rendering — `- <name> (<display_name>): <description>` — with a multi-level description fallback (frontmatter description of ≥ 20 chars → body's first sentence → display name → name, bounded to 120 chars on the first sentence) and a trailing `(unparsable agents excluded: …)` line. The option label is a rubric name; **the translation back to the agent id happens when the advice is built** — `use_agent` wants `workhorse`, not `workhorse (牛马狗)`.

## Verdict log (opt-in)

Set `logDir` to turn it on; each verdict appends one NDJSON line to `verdicts.ndjson`:

```json
{"at":"…","session":"s1","mode":"once","trigger":"/dispatch","action":"advise","reason":"dispatch 0.85, workhorse at 0.90 (margin 0.60)","confidence":0.9,"route":"workhorse","usage":{"input_tokens":120,"output_tokens":30},"latencyMs":412,"answers":{…},"delivered":true}
```

`action` is what jev decided; `delivered` is whether the advice actually reached the turn — two different facts. A log failure is a warn and never affects the turn. What the log cannot see is whether the agent **followed** the advice; that is a routing ledger's job.

Calibrating from the log:

```sh
jq -r 'select(.action=="advise") | [.route, .confidence] | @tsv' verdicts.ndjson | sort | uniq -c | sort -rn
```

## Privacy

What leaves the machine: the turn's **plain user text only** (plugin- and tool-authored messages never enter the state; non-text content is never sent), the workspace path, and the roster criteria. The whole assembly is redacted and only then truncated to `stateChars` (default 1200). Built-ins cover `sk-` / `pk_` / `ghp_` / `github_pat_` / `AKIA` / `Bearer` / `api_key=` / long base64; `redactPatterns` adds more.

## Configuration

| key | default | meaning |
|---|---|---|
| `mode` | `'off'` | `off` / `once` (`auto` is in fog, waiting for the verdict log) |
| `agentsDir` | `'~/.dsh/agents'` | the default literal resolves against the dsh home, so `DSH_HOME` keeps working |
| `toolName` | `'use_agent'` | the dispatch tool the gate probes |
| `provider` | `'spawn'` | the subagent provider the gate probes |
| `triggers` | `['/dispatch', '/jev']` | trigger words |
| `timeoutMs` | `2000` | shorter than the core's 5s default: the call sits inline in the pre-step waterfall |
| `stateChars` | `1200` | state cap |
| `model` | `null` | jev model id; `null` uses the core's pinned version |
| `thresholds` | see above | each of the six gates is independently overridable |
| `skipSubagentSessions` | `true` | a subagent's own turn never gets advice (no recursion) |
| `logDir` | `null` | set a directory to enable the verdict log |
| `redactPatterns` | `[]` | extra redaction regex sources |
| `includeDismissLine` | `true` | the trailing "ignore this if it does not fit" line |

## Ecosystem

The other leg — who needs attention while a subagent runs — lives in **dsh-tui-pi's attention** and shares `@aiwayds/dsh-jev-core` with this plugin: one key resolution, one strict validation, one fail-open contract. Attention upgrades to semantic scoring with jev and falls back to a local heuristic ranking without it; dispatch goes silent without it.

## Development

```sh
npm install
npm run check   # links the dsh closure, then tsc --noEmit
npm test        # pretest builds lib/, node --test runs the built output
npm run smoke   # real dsh CLI boot smoke (needs dsh installed locally)
```

Zero mock libraries and zero real network in the tests: fetch / env / keychain / message factory are all injected, the host context is hand-built, and the roster is a real temp directory.

## License

MIT
