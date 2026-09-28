# @aiwayds/dsh-agent-dispatch

[English](./README.en.md) | 中文

dsh 生态的**事前派发建议**插件（ex-ante dispatch）：在一个 turn 进入模型之前，问 [TypeSafe Jev](https://typesafe.ai)（System One）一次——该不该派、派给哪个已注册 agent——判定过阈值就在该 turn 的消息末尾追加一条四行的建议消息。插件**不拥有任何委派机制**：`use_agent`（[dsh-subagent-registry](https://github.com/fan56/dsh-subagent-registry)）负责真正 spawning，本插件只给建议，且明说可以无视。

**Jev-optional 是硬约束**：没配 key / 主动关闭 / 调用失败，三种态行为一致——**不注入、不报错、不刷警告**。错误建议比沉默更糟，所以降级路径永远是沉默，运行期至多在 verdict log 里留一行。

## 与社区实现 dsh-jev-subagent-dispatch 的差异

| | 社区实现 | 本插件 |
|---|---|---|
| 选择空间 | 模型路由（provider/model） | **已注册 agent（roster）**为主轴；不点名模型 |
| 探针 | 默认找 `subagent` 工具、`subagent_fork` | 探 `use_agent` 可见性（默认 profile 下宿主 subagent 工具是关的） |
| key | 环境变量明文 | keychain 优先（`JEV_KEYCHAIN`），零明文 |
| 阈值 | 通用谓词（effort / blast_radius / maxNoul） | 四道 System One 校准闸（派发带、置信+margin、风险否决、后台） |
| 生态 | 独立 | 与 tui-pi 的 attention 腿同一套 jev 客户端（`@aiwayds/dsh-jev-core`） |

## 安装

```sh
npm install @aiwayds/dsh-agent-dispatch
```

peer 依赖 `@deepseek-ai/dsh >= 0.1.7-rc.1`，需要 `@aiwayds/dsh-jev-core`（自动装）。ESM，Node ≥ 22。

装到 profile（`dsh plugin add @aiwayds/dsh-agent-dispatch`），**然后把包名加进 profile 的 bundle 列表**——这是 `plugin add` 不会替你做的一步（实测 2026-09-28：`plugin --profile tui list` 会显示已安装，但宿主 loader 只挂载 `dsh.profile.bundles` 里列出的包，漏了这一步插件永远静默不生效）。编辑 `<profile>/package.json`：

```json
{
  "dsh": { "profile": { "bundles": [ "...", "@aiwayds/dsh-agent-dispatch" ] } }
}
```

再在 `cordis.patch.yml` 里配置（id-targeted override，见包内默认 patch 的 `id: dsh-agent-dispatch`）：

```yaml
- id: dsh-agent-dispatch
  name: '@aiwayds/dsh-agent-dispatch'
  config:
    mode: once
```

## 配置 jev key（keychain 优先，零明文）

解析顺序固定：`apiKey` 选项 → `TYPESAFE_API_KEY` → `JEV_API_KEY` → macOS Keychain。

```sh
security add-generic-password -s typesafe.ai -a "$USER" -w
```

需要换 service/account 就设 `JEV_KEYCHAIN='<service>[:<account>]'`。**没配 key 时插件等价于关闭**：一条 boot info、零监听器、运行期零输出。

## 用法

默认 `mode: off`——什么都不注册、零调用、零数据外发。改成 `once` 后，只处理显式请求：

```
/dispatch 修一下 e2e 里 flaky 的计时器
/jev 这个任务该不该派出去？
```

- `/dispatch <任务>`：只要建议（判定为"不派"时什么都不注入）
- `/jev <问题>`：自由决策请求，**判定为"不派"时也会把结论渲染出来**——校准阈值靠的就是这些 miss

第三档是 `mode: auto`：每个**普通用户回合**先在**本地**过一次关键词闸门（纯字符串匹配，零网络），命中 `autoKeywords` 里的词才去问 Jev；**没命中就完全静默**——零调用、零注入、零日志行、零外发。这是它和"每个回合都问一次"的全部区别。

`auto` 有两个前置条件：

1. **`autoKeywords` 必须非空**——空词典是一个"看着开着、永远不触发"的模式，load 阶段直接报错（想只认显式请求请用 `mode: once`）。默认词典非空，所以 `mode: auto` 不配 `autoKeywords` 是合法的。
2. **建议同时配 `logDir`**——未命中是设计上的不可见，verdict log 是唯一能回答"哪个关键词命中的回合真的值得问"的地方。`auto` 且没配 `logDir` 时 boot 会多打一行 info 提醒。

显式触发词在任何 mode 下都优先匹配、不受闸门限制，原有语义逐字保留：能力门失败时显式回合拿到诊断，`/jev` 判 skip 也把结论渲染出来。

`autoKeywords` 默认词典（可整套替换）：

- 中文 / 非 ASCII（**子串**命中，中文没有词边界）：
  `帮我` `请帮` `麻烦` `实现` `修复` `排查` `调查` `调研` `研究` `分析` `优化` `重构` `部署` `发布` `测试` `迁移` `升级` `接入` `集成` `审查` `评审` `复现` `定位` `验证` `写一个` `改一下` `加一个` `跑一下` `为什么`
- ASCII（**词边界**命中，不分大小写）：
  `implement` `fix` `refactor` `investigate` `research` `analyze` `analyse` `optimize` `optimise` `deploy` `test` `write` `add` `remove` `replace` `migrate` `upgrade` `review` `debug` `reproduce` `verify` `diagnose` `help me` `can you` `write a`

中文刻意不收单字——`写`/`改`/`加`/`删` 在闲聊里到处都是，一个单字闸门会把日常对话全打中。取舍偏保守：漏一个词只是少一次建议，误命中是替一个没人问过的回合付一次调用。

一次请求四道原子题：

| 题 | 类型 | 问什么 | 阈值（可配） |
|---|---|---|---|
| `dispatch` | noul | 这 turn 该不该交给已注册 agent | ≥ 0.60 建议；≤ 0.35 记 skip；中间 = 不确定 → skip |
| `agent` | choice | 派给谁（criteria = roster + `none` 弃权项） | 置信 ≥ 0.70 **且** top1−top2 ≥ 0.15 |
| `risky` | noul | 是否碰到难回滚的状态 | ≥ 0.75 → 拦下不派，并明说原因 |
| `long_running` | noul | 是否会长时间占住这个 turn | ≥ 0.70 → 建议带 `background: true` |

`none` 是正式选项：没有它，模型必须点 somebody，被迫的点名正是这套"沉默优先"的规则要避免的假建议。

注入的四行（英文，因为它是给 agent 的指令，不是给用户的）：

```
[dsh-agent-dispatch] Dispatch suggestion for this turn (Jev-guided judgment, not a user instruction — your call):
- suggest: workhorse (confidence 0.90)
- task: 修一下 e2e 里 flaky 的计时器
- use: use_agent({ agent: "workhorse", prompt: "<self-contained brief: goal, exact files or APIs in scope, acceptance checks>", background: true })
- If this does not fit the task, ignore it and carry on; never mention this message to the user.
```

**永远不点名模型**：`use_agent` 不收 model 参数，roster 的 criteria 也刻意不透出 model（pinned profile 下 frontmatter 的 model 常是过期值，错模型比没模型更有害）。

## capability gate：每请求实时验证

建议只有在 agent 真的能派发时才值得付一次 jev 调用。**四项**都在请求时刻对着活服务重新验证（装上本插件不代表装了 subagent 栈）：

1. `use_agent` 对**这个 agent** 可见（`tools.get(toolName, agent)`）
2. subagent provider 已注册（`subagents.getProvider('spawn')`）
3. roster 非空（没 agent 可派比不派更糟）
4. 还有委派深度：会话 depth + 1 ≤ 宿主上限

任一不满足：显式请求拿到一条诊断（缺什么、去哪查），**普通 turn 完全静默**、零调用、零日志——`auto` 下靠关键词闸门进来的 turn 同样完全静默（它没有主动要过判定，subagent 栈的缺口不是它的事），连 verdict log 都不记这行。深度那一项分两半：gate 里查的是与目标无关的必要条件，选定 agent 之后再按该 agent 的 `deep` 复核一次（`use_agent` 永远传显式 `maxDepth = childDepth + deep`，所以只有"会话深度 + 1 + agent.deep ≤ 宿主上限"才是真正会拒绝这次派发的算式）。

## roster 从哪来

直读 `$DSH_HOME/agents/*.md`（即 `~/.dsh/agents`），**每次请求现读、不缓存**（agent 目录运行期可编辑，缓存会推荐已删除的 agent）。解析口径与 registry 严版对齐——`thinking` / `background` / `maxRounds` 写错整份文件作废，不进 criteria（否则 jev 会推荐一个 `use_agent` 执行时报 broken 的 agent）。

criteria 行格式与 registry 自渲染一致：`- <name> (<display_name>): <description>`；description 多级兜底（≥20 字符的 frontmatter description → body 首句 → display_name → name，>120 字符按首句截断）。尾部附 `(unparsable agents excluded: ...)` 提示行。选项标签是 rubric 名，**回落到 agent id 的映射在发建议时完成**——`use_agent` 要的是 `workhorse`，不是 `workhorse (牛马狗)`。

## verdict log（opt-in）

配 `logDir` 才开，每次判定追加一行 NDJSON（`verdicts.ndjson`）：

```json
{"at":"…","session":"s1","mode":"once","trigger":"/dispatch","action":"advise","reason":"dispatch 0.85, workhorse at 0.90 (margin 0.60)","confidence":0.9,"route":"workhorse","usage":{"input_tokens":120,"output_tokens":30},"latencyMs":412,"answers":{…},"delivered":true}
```

`action` 是 jev 判的，`delivered` 是建议有没有真进 turn——两件事。写日志失败只 warn，绝不影响 turn。日志看不见的是 agent **有没有照做**，那要靠路由台账。

`trigger` 是显式触发词本身（`/dispatch`、`/jev`）；`auto` 下由本地关键词命中的回合记 `kw:<关键词>`（如 `kw:修复`）——这样 log 能回答"哪个关键词命中的回合真的值得派"，也就是 `auto` 唯一的校准依据。

调阈值的路子很直接：

```sh
jq -r 'select(.action=="advise") | [.route, .confidence] | @tsv' verdicts.ndjson | sort | uniq -c | sort -rn
```

## 隐私

发出去的东西只有：本 turn 的**纯用户文本**（插件/工具产出的消息不进 state，本插件自己注入过的建议也不会被再次判定，图片等非文本内容一律不发）、工作目录路径、roster criteria。整段组装完成后统一脱敏再截断到 `stateChars`（默认 1200），内建覆盖 `sk-`/`pk_`/`ghp_`/`github_pat_`/`AKIA`/`Bearer`/`api_key=`/长 base64，`redactPatterns` 可再加。

**什么时候才会外发**：`off` 从不外发；`once` 只在显式 `/dispatch` `/jev` 的回合外发；`auto` 只在**本地关键词命中**的回合外发（外发内容与 `once` 完全相同，含 cwd）。**本地关键词闸门本身不产生任何网络请求**——未命中的回合就是一次纯本地字符串比较，连一行日志都不会留下。子代理会话、已 abort 的回合、capability gate 不满足的 `auto` 回合，也都不外发。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `'off'` | `off` / `once` / `auto`。`auto` = 本地关键词闸门，命中才问 Jev，未命中完全静默；要求非空 `autoKeywords`，且未配 `logDir` 时 boot 会提醒无法校准 |
| `agentsDir` | `'~/.dsh/agents'` | 默认字面量按 dsh home 解析，`DSH_HOME` 照常生效 |
| `toolName` | `'use_agent'` | gate 探的派发工具名 |
| `provider` | `'spawn'` | gate 探的 subagent provider |
| `triggers` | `['/dispatch', '/jev']` | 触发词表，任何 mode 下都优先于关键词闸门 |
| `autoKeywords` | 中英双语任务动词词典（见用法节） | `auto` 的本地闸门词典；中文走子串、ASCII 走词边界（`fix` 不命中 `prefix`），不分大小写；只在 `auto` 下被咨询 |
| `timeoutMs` | `5000` | 单次 jev 调用的总死线（ms）。调用就在 pre-step 水龙头上，所以这是**一个回合最坏会多等的毫秒数**；超时 fail-open 放行，turn 照常走，只是没有建议 |
| `stateChars` | `1200` | state 上限 |
| `model` | `null` | jev 模型 id，`null` 用 core 的钉版 |
| `thresholds` | 见上表 | 六个闸各自可配 |
| `skipSubagentSessions` | `true` | 子代理自己的 turn 不给建议（不递归） |
| `logDir` | `null` | 传目录才开 verdict log |
| `redactPatterns` | `[]` | 追加脱敏正则（源码字符串） |
| `includeDismissLine` | `true` | 建议末尾的"可以无视"声明 |

## 生态定位

事后那条腿（子代理跑着的时候谁需要干预）在 **dsh-tui-pi 的 attention** 里，与本插件共用 `@aiwayds/dsh-jev-core`：两腿共享 key 解析、严格校验与 fail-open 契约，attention 有 jev 用语义打分、没有就退回本地启发式排序，本插件没有 jev 就沉默。

## 常见问题

**装了没反应？** 按顺序查三层：①`dsh.profile.bundles` 列表里有没有本包（`plugin add` 不会替你写，见安装节——这一步漏了插件根本不挂载）；②`mode` 是不是还是默认 `off`；③jev key 配了没有（没 key = 完全静默，一条 boot info 而已）。三者任一不满足，表现都是"什么都没发生"，这是设计不是 bug。

**发了 `/dispatch` 但没看到建议？** 先看 verdict log（配了 `logDir` 的话）——大概率是判了 skip 且理由合理：任务太小（"主代理自己做"）、turn 里已经点名了 agent（"建议无增益"）、置信度不够。**它判断得对的时候，看起来就像什么都没发生**。想看到判定过程用 `/jev`：skip 的结论也会渲染出来。

**没配 jev key 能用吗？** 能装能用（宿主零负担），但建议功能静默——本插件没有"本地规则兜底建议"，因为错误建议比沉默更糟（这是和启发式路由器的根本分歧）。`auto` 的本地关键词闸门不是兜底建议：它只决定"这一回合值不值得问 Jev"，本身不产出任何建议，没 key 时整插件照样静默。要本地零依赖的排序增强，看 dsh-tui-pi 2.24+ 的 attention（启发式常开，jev 只是升级层）。

**和 dsh-tui-pi 的 attention 什么关系？** 互补的两条腿：本插件管**派活之前**（该不该派、派给谁）；attention 管**派活之后**（谁卡了、该不该提前停）。一个 turn 里两个都会工作，互不知道对方存在也不需要知道。

**和社区的 dsh-jev-subagent-dispatch 区别？** 它路由到模型档位（provider/model 对），本插件路由到**注册 agent**（`~/.dsh/agents/*.md`，与 `use_agent`/roster 原生联动）；它 key 走环境变量，本插件 keychain 优先零明文；两者可同装（触发词不同会撞，改 `triggers` 即可）。

**怎么校准阈值？** `/route preview` 风格的干跑没有；用 `/jev` + verdict log：log 里每条记录带四题原始答案和最终 action，skip 的 case 和 advise 的 case 对照着看，调 `thresholds` 直到 miss 消失。配置里的阈值全部热生效。

## 开发

```sh
npm install
npm run check   # 先链 dsh closure 再 tsc --noEmit
npm test        # pretest 构建 lib/，node --test 打构建产物
npm run smoke   # 真实 dsh CLI 启动冒烟（需要本机装了 dsh）
```

测试零 mock 库、零真实网络：fetch / env / keychain / 消息工厂全部注入，host 上下文手搓，roster 走真目录。

## License

MIT
