# @aiwayds/dsh-jev-dispatch

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
npm install @aiwayds/dsh-jev-dispatch
```

peer 依赖 `@deepseek-ai/dsh >= 0.1.7-rc.1`，需要 `@aiwayds/dsh-jev-core`（自动装）。ESM，Node ≥ 22。

装到 profile（`dsh plugin add @aiwayds/dsh-jev-dispatch`），**然后把包名加进 profile 的 bundle 列表**——这是 `plugin add` 不会替你做的一步（实测 2026-09-28：`plugin --profile tui list` 会显示已安装，但宿主 loader 只挂载 `dsh.profile.bundles` 里列出的包，漏了这一步插件永远静默不生效）。编辑 `<profile>/package.json`：

```json
{
  "dsh": { "profile": { "bundles": [ "...", "@aiwayds/dsh-jev-dispatch" ] } }
}
```

再在 `cordis.patch.yml` 里配置（id-targeted override，见包内默认 patch 的 `id: dsh-jev-dispatch`）：

```yaml
- id: dsh-jev-dispatch
  name: '@aiwayds/dsh-jev-dispatch'
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
[dsh-jev-dispatch] Dispatch suggestion for this turn (Jev-guided judgment, not a user instruction — your call):
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

任一不满足：显式请求拿到一条诊断（缺什么、去哪查），**普通 turn 完全静默**、零调用、零日志。深度那一项分两半：gate 里查的是与目标无关的必要条件，选定 agent 之后再按该 agent 的 `deep` 复核一次（`use_agent` 永远传显式 `maxDepth = childDepth + deep`，所以只有"会话深度 + 1 + agent.deep ≤ 宿主上限"才是真正会拒绝这次派发的算式）。

## roster 从哪来

直读 `$DSH_HOME/agents/*.md`（即 `~/.dsh/agents`），**每次请求现读、不缓存**（agent 目录运行期可编辑，缓存会推荐已删除的 agent）。解析口径与 registry 严版对齐——`thinking` / `background` / `maxRounds` 写错整份文件作废，不进 criteria（否则 jev 会推荐一个 `use_agent` 执行时报 broken 的 agent）。

criteria 行格式与 registry 自渲染一致：`- <name> (<display_name>): <description>`；description 多级兜底（≥20 字符的 frontmatter description → body 首句 → display_name → name，>120 字符按首句截断）。尾部附 `(unparsable agents excluded: ...)` 提示行。选项标签是 rubric 名，**回落到 agent id 的映射在发建议时完成**——`use_agent` 要的是 `workhorse`，不是 `workhorse (牛马狗)`。

## verdict log（opt-in）

配 `logDir` 才开，每次判定追加一行 NDJSON（`verdicts.ndjson`）：

```json
{"at":"…","session":"s1","mode":"once","trigger":"/dispatch","action":"advise","reason":"dispatch 0.85, workhorse at 0.90 (margin 0.60)","confidence":0.9,"route":"workhorse","usage":{"input_tokens":120,"output_tokens":30},"latencyMs":412,"answers":{…},"delivered":true}
```

`action` 是 jev 判的，`delivered` 是建议有没有真进 turn——两件事。写日志失败只 warn，绝不影响 turn。日志看不见的是 agent **有没有照做**，那要靠路由台账。

调阈值的路子很直接：

```sh
jq -r 'select(.action=="advise") | [.route, .confidence] | @tsv' verdicts.ndjson | sort | uniq -c | sort -rn
```

## 隐私

发出去的东西只有：本 turn 的**纯用户文本**（插件/工具产出的消息不进 state，图片等非文本内容一律不发）、工作目录路径、roster criteria。整段组装完成后统一脱敏再截断到 `stateChars`（默认 1200），内建覆盖 `sk-`/`pk_`/`ghp_`/`github_pat_`/`AKIA`/`Bearer`/`api_key=`/长 base64，`redactPatterns` 可再加。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `'off'` | `off` / `once`（`auto` 在雾里，等 verdict log 攒够） |
| `agentsDir` | `'~/.dsh/agents'` | 默认字面量按 dsh home 解析，`DSH_HOME` 照常生效 |
| `toolName` | `'use_agent'` | gate 探的派发工具名 |
| `provider` | `'spawn'` | gate 探的 subagent provider |
| `triggers` | `['/dispatch', '/jev']` | 触发词表 |
| `timeoutMs` | `2000` | 比 core 默认的 5s 短：调用在 pre-step 水龙头上，超时就是占着 turn |
| `stateChars` | `1200` | state 上限 |
| `model` | `null` | jev 模型 id，`null` 用 core 的钉版 |
| `thresholds` | 见上表 | 六个闸各自可配 |
| `skipSubagentSessions` | `true` | 子代理自己的 turn 不给建议（不递归） |
| `logDir` | `null` | 传目录才开 verdict log |
| `redactPatterns` | `[]` | 追加脱敏正则（源码字符串） |
| `includeDismissLine` | `true` | 建议末尾的"可以无视"声明 |

## 生态定位

事后那条腿（子代理跑着的时候谁需要干预）在 **dsh-tui-pi 的 attention** 里，与本插件共用 `@aiwayds/dsh-jev-core`：两腿共享 key 解析、严格校验与 fail-open 契约，attention 有 jev 用语义打分、没有就退回本地启发式排序，本插件没有 jev 就沉默。

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
