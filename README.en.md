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

The third mode is `auto`: every **ordinary user turn** clears a **local** keyword gate first (plain string matching, zero network), and only a hit on an `autoKeywords` entry is worth asking Jev about; **a miss is completely silent** — zero calls, zero injection, zero log lines, zero data shared. That is the entire difference between it and "ask jev about every turn".

`auto` has two preconditions:

1. **`autoKeywords` must be non-empty** — an empty dictionary is a mode that looks on and can never fire, so it is a load-time error (use `mode: once` to handle explicit requests only). The default dictionary is non-empty, so `mode: auto` without configuring `autoKeywords` is valid.
2. **Configure `logDir` as well** — a miss is invisible by design, and the verdict log is the only place that can answer "which keyword's hits were really worth asking about". With `auto` and no `logDir`, boot logs one extra info line.

Explicit triggers are matched first in every mode and are never gated; their semantics are kept word for word: an explicit turn still gets the diagnostic when the capability gate fails, and a `/jev` skip is still rendered.

The default `autoKeywords` dictionary (replaceable as a whole):

- Chinese / non-ASCII (**substring** match — Chinese has no word boundaries):
  `帮我` `请帮` `麻烦你` `麻烦帮` `实现` `修复` `排查` `调查` `调研` `研究` `分析` `优化` `重构` `部署` `发布` `测试` `迁移` `升级` `接入` `集成` `审查` `评审` `复现` `定位` `验证` `写一个` `改一下` `加一个` `跑一下` `修改` `检查` `删除` `移除` `去掉` `报错` `生成` `梳理` `提交` `构建` `安装` `总结` `对比` `看一下` `看看` `为什么会`
- ASCII (**word-bounded**, case-insensitive, one common suffix allowed):
  `implement` `fix` `refactor` `investigate` `research` `analyze` `analyse` `optimize` `optimise` `deploy` `test` `write` `add` `remove` `replace` `migrate` `upgrade` `review` `debug` `reproduce` `verify` `diagnose` `help me` `build` `commit` `check` `explain` `summarize` `generate` `delete` `install` `update` `run` `document` `analysis` `writing` `debugging` `running` `committed` `verified`

Single Chinese characters are deliberately excluded — 写/改/加/删 are everywhere in small talk, and a one-character gate would fire on ordinary conversation. The bias is **asymmetric** and deliberately wide otherwise: a false hit costs one jev call (and mostly comes back `skip`), while a miss costs the turn its whole feature — and the user cannot tell a miss from a broken install, which is why the most common task phrasings (`修改`/`检查`/`生成`, `build`/`commit`/`run`) are in.

Four matching rules, all applied to a **copy used for matching only** — the user's text reaches the state sent to jev as typed, apart from redaction and the `stateChars` cap; the only thing that gets cleaned and truncated is the `kw:` label in the verdict log:

- **One common ASCII suffix is allowed**: `s`/`es`/`ed`/`ing`/`ment`/`ments`/`d`, so `fixing`/`fixed`/`tests`/`deployment`/`refactoring` hit, and `d` lets an `-e` stem recognize its own past tense (`removed`/`updated`/`generated`/`deleted`), while `prefix` (the `r` after `pre`+`fix`), `address`, and `addressing` still miss. Irregular forms the suffix rule cannot reach (`writing`, `debugging`, `analysis`, `running`, `committed`, `verified`) are shipped as their own entries.
- **Hyphens separate words** (a word character is a letter, a digit, or an underscore): `fix-me` and `the e2e-test is red` hit; the identifier `fix_it` does not.
- **Whitespace folds**: runs of whitespace collapse to one space before matching, so `help  me` and `help\nme` both hit `help me`; inside a multi-word entry (`help me`) that whitespace is treated as a separator of the "not a letter, digit, or underscore" class — punctuation counts too — so `help,me` and `help-me` hit as well, while `helpXme` and `help_me` do not.
- **NFKC normalization**: a full-width `ｆｉｘ this bug` (an input method left on Chinese) hits `fix`.

Note that the gate scans the **whole turn text**, while the state sent to jev is capped by `stateChars` (1200 by default) — a keyword that falls outside that window still hits, and still earns the jev call, jev just never sees the word.

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

When any leg fails, an explicit request gets a diagnostic naming what is missing; **ordinary turns stay completely silent** — no call, no injection, no log — and under `auto` a turn that came in through the keyword gate injects nothing and writes no verdict-log row (it never asked for a verdict, so a gap in the subagent stack is not its business). The FIRST such turn in a session does log **one info line** naming the gap and stating that keyword-hit turns stay quiet by design; it is not repeated, so a whole session cannot look on while the stack behind it is missing. Leg 4 comes in two halves: the gate checks the target-independent necessary condition, and after the pick the recommendation is re-checked against that agent's own `deep` (`use_agent` always passes an explicit `maxDepth = childDepth + deep`, so "session depth + 1 + agent.deep ≤ host cap" is the arithmetic that can actually reject the dispatch).

## Where the roster comes from

Read straight from `$DSH_HOME/agents/*.md` (i.e. `~/.dsh/agents`), **fresh per request, never cached** — the directory is editable at runtime, and a cached snapshot would recommend a deleted agent. Parsing matches the registry's strict version: a mistyped `thinking` / `background` / `maxRounds` drops the whole file from the criteria, because jev must never recommend an agent that `use_agent` will refuse to run.

Criteria lines use the registry's own rendering — `- <name> (<display_name>): <description>` — with a multi-level description fallback (frontmatter description of ≥ 20 chars → body's first sentence → display name → name, bounded to 120 chars on the first sentence) and a trailing `(unparsable agents excluded: …)` line. The option label is a rubric name; **the translation back to the agent id happens when the advice is built** — `use_agent` wants `workhorse`, not `workhorse (牛马狗)`.

## Verdict log (opt-in)

Set `logDir` to turn it on; each verdict appends one NDJSON line to `verdicts.ndjson`:

```json
{"at":"…","session":"s1","mode":"once","trigger":"/dispatch","action":"advise","reason":"dispatch 0.85, workhorse at 0.90 (margin 0.60)","confidence":0.9,"route":"workhorse","usage":{"input_tokens":120,"output_tokens":30},"latencyMs":412,"answers":{…},"delivered":true}
```

`action` is what jev decided; `delivered` is whether the advice actually reached the turn — two different facts. A log failure is a warn and never affects the turn. What the log cannot see is whether the agent **followed** the advice; that is a routing ledger's job.

`trigger` is the explicit trigger word itself (`/dispatch`, `/jev`); under `auto`, a turn matched by the local keyword gate records `kw:<keyword>` (e.g. `kw:修复`) — which is what lets the log answer "which keyword's hits were really worth dispatching", the only calibration evidence `auto` has.

Calibrating from the log:

```sh
jq -r 'select(.action=="advise") | [.route, .confidence] | @tsv' verdicts.ndjson | sort | uniq -c | sort -rn
```

## Privacy

What leaves the machine: the turn's **plain user text only** (plugin- and tool-authored messages never enter the state, so advice this plugin injected is never classified again; non-text content is never sent), the workspace path, and the roster criteria. The whole assembly is redacted and only then truncated to `stateChars` (default 1200). Built-ins cover `sk-` / `pk_` / `ghp_` / `github_pat_` / `AKIA` / `Bearer` / `api_key=` / long base64; `redactPatterns` adds more.

**When anything leaves at all**: `off` never sends; `once` sends only on an explicit `/dispatch` `/jev` turn; `auto` sends only on a turn that **hit a local keyword** (the payload is identical to `once`, cwd included) — so under `auto` **a hit sends even though the user never typed `/dispatch`**, with the user's own text travelling to TypeSafe Jev as the state. **The local keyword gate itself issues no network request** — a miss is one in-process string comparison and does not even leave a log line. Subagent sessions, aborted turns, and `auto` turns whose capability gate fails send nothing either.

## Configuration

| key | default | meaning |
|---|---|---|
| `mode` | `'off'` | `off` / `once` / `auto`. `auto` = a local keyword gate: only a hit asks Jev, a miss is completely silent; requires a non-empty `autoKeywords`, and logs one info line at boot when it cannot be calibrated without `logDir` |
| `agentsDir` | `'~/.dsh/agents'` | the default literal resolves against the dsh home, so `DSH_HOME` keeps working |
| `toolName` | `'use_agent'` | the dispatch tool the gate probes |
| `provider` | `'spawn'` | the subagent provider the gate probes |
| `triggers` | `['/dispatch', '/jev']` | trigger words; they outrank the keyword gate in every mode |
| `autoKeywords` | bilingual task-verb dictionary (see Usage) | the local gate dictionary for `auto`: Chinese matches as a substring, ASCII on word boundaries with one suffix allowed (`s`/`es`/`ed`/`ing`/`ment`/`ments`/`d`, so `fix` covers `fixing` and `remove` covers `removed`, but `fix` still misses `prefix`), hyphens separate words, and the separator between the words of a multi-word entry is any run of characters that are not letters/digits/underscores (so `help,me`/`help-me` hit while `help_me`/`helpXme` do not); matching runs on an NFKC-folded, whitespace-collapsed copy; case-insensitive; consulted under `auto` only |
| `timeoutMs` | `5000` | the deadline for **one jev call** (ms). A hit turn also pays the roster read, the redaction pass, and the render — so this is the largest part of a turn's added wait, not "the worst-case extra milliseconds one turn can wait"; on timeout it fails open, the turn proceeds, there is just no advice |
| `stateChars` | `1200` | state cap |
| `model` | `null` | jev model id; `null` uses the core's pinned version |
| `thresholds` | see above | each of the six gates is independently overridable |
| `skipSubagentSessions` | `true` | a subagent's own turn never gets advice (no recursion) |
| `logDir` | `null` | set a directory to enable the verdict log |
| `redactPatterns` | `[]` | extra redaction regex sources |
| `includeDismissLine` | `true` | the trailing "ignore this if it does not fit" line |

## Ecosystem

The other leg — who needs attention while a subagent runs — lives in **dsh-tui-pi's attention** and shares `@aiwayds/dsh-jev-core` with this plugin: one key resolution, one strict validation, one fail-open contract. Attention upgrades to semantic scoring with jev and falls back to a local heuristic ranking without it; dispatch goes silent without it.

## FAQ

**Installed but nothing happens?** Check three layers in order: (1) is the package in `dsh.profile.bundles`? `plugin add` does NOT write it for you (see Install) — without the entry the loader never mounts the plugin; (2) is `mode` still the default `off`? (3) is a jev key configured? No key = complete silence (one boot info line). Any of the three failing looks identical: nothing happens. That's by design, not a bug.

**Sent `/dispatch` and saw no advice?** Check the verdict log (`logDir`) — most likely a well-reasoned skip: the task is too small ("do it here"), the turn already names an agent ("advice adds nothing"), or confidence fell short. **When it judges correctly, it looks like nothing happened.** Use `/jev` to see the reasoning: skip verdicts are rendered too.

**Usable without a jev key?** Installable and harmless (zero load on the host), but the advice stays silent — there is deliberately NO local-rules fallback here, because a wrong recommendation is worse than silence. `auto`'s local keyword gate is not a fallback recommendation: it only decides whether a turn is worth asking Jev about, produces no advice of its own, and with no key the plugin is silent all the same. For a local, zero-dependency ranking boost see dsh-tui-pi 2.24+'s attention (heuristic always on, jev only an upgrade layer).

**How does this relate to dsh-tui-pi's attention?** Complementary legs: this plugin covers BEFORE dispatching (whether/whom); attention covers AFTER (who is stuck, when to stop early). Both work in the same turn without knowing about each other.

**Difference from the community's dsh-jev-subagent-dispatch?** That one routes to MODEL tiers (provider/model pairs); this one routes to REGISTERED AGENTS (~/.dsh/agents/*.md, native to use_agent and the roster). That one reads keys from env; this one is keychain-first. Both can be installed together (custom `triggers` avoid collisions).

**How do I calibrate the thresholds?** No preview dry-run; use `/jev` plus the verdict log — every record carries the four raw answers and the final action. Read skips against advises until the misses disappear. All thresholds hot-apply.

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
