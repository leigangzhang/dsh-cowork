# Proposal: M1 master/thread 闭环

Status: proposed
Date: 2026-11-05
Class: feature

## Problem

M0 证明了五项宿主 API，但仓库还没有产品：没有项目索引、没有路由、没有 handoff、没有可用的 `cowork-*` preset，也没有 `cowork_*` 工具。用户无法初始化项目、把一个需求交给 thread，或让 thread 把结果交回 master。M2/M3 的项目记忆、worktree、review 也无处附着。

M1 的完成定义由 [PLAN §6](../../../docs/PLAN.md) 固定：初始化项目生成 `index.json` 且 master 正确；master 发需求自动新建 thread 并出现在侧栏；再次发相关需求能路由到已有 thread；thread 调 handoff 后 master 收到结构化消息；不使用第三方协作运行时。M0 同时纠正了两条前提：`sessionController.create` 只有传 `workspaceId` 才挂 workspace；运行时注册的 preset 重启即消失。另有一个 M1 必须最先回答的新事实：本部署的工具挂在 preset 的 `plugins` 列表里（`dsh-web-app/presets/standard.patch.yml`），M0 的空 `plugins` preset 只验证了“可注册/可选中”，没有跑过一轮；如果它没有工具，`cowork-thread` 就不能工作。

## Proposal

交付一个 host-only 的 M1 闭环（client 面板仍属 M3），由纯模块与薄宿主适配层组成。设计按以下契约落地。

**模块边界**

- `src/store.ts`：项目索引与 handoff 文件读写；原子写、项目级锁、schema 校验。纯逻辑尽量独立，文件与时钟从参数注入。
- `src/session-slice.ts`：`sessionController` 的薄封装（create/prompt/rename/list）与 workspace 解析；不暴露其他宿主服务。
- `src/router.ts`：本地关键词打分；纯函数，输入索引摘要与 intent，输出决策。
- `src/handoff.ts`：handoff 结构校验、落盘、投递 master、未投递重放。
- `src/tools.ts`：六个 `cowork_*` 工具与错误码。
- `src/presets.ts`：注册 `cowork-master` / `cowork-thread`；两者都用 S0 定下的显式行（persona 覆盖 + 最小工具集）。
- `src/index.ts`：装配 service、工具、preset、事件；M0 探针的路由与工具在 M1 保留还是移除由 S0 后的实现决定，但不能与正式 API 冲突。

**数据模型（v1）**

- `<repo>/.dsh-cowork/index.json`：`version:1`、`projectId`、`masterSessionId`、`createdAt`、`threads[]`。thread 字段与 [PLAN §4.3](../../../docs/PLAN.md) 一致：`threadId`、`subject`、`status`（`new|active|awaiting_review|done|blocked|archived`）、`cwd`、`worktreePath`、`createdAt`、`updatedAt`、`lastHandoffAt`。
- `<repo>/.dsh-cowork/handoffs/<threadId>-<timestamp>.json`：PLAN §4.3 的 handoff 字段，另加 `version`、`createdAt`（ISO 8601 UTC）与 `deliveredAt`（成功投递后写）。文件名只保证唯一性，排序/比较一律用 `createdAt` 的 epoch；`deliveredAt` 缺省表示待投递，`cowork_project_status` 负责重放。
- `projectId`：优先规范化 `git remote get-url origin`（如 `github.com-owner-repo`）；没有 remote 时用 `sha256(realpath(repoPath))` 前 12 位。所有时间用 ISO 8601 UTC；handoff 文件名用 `YYYYMMDDTHHmmssSSSZ`。
- 状态推进：`new → active`（首次 prompt 成功）；handoff 按自身 `status` 写 `awaiting_review|blocked|done`；`archived` 只由用户操作；route 排除 `done|archived`。
- 原子写：宿主 `@deepseek-ai/dsh-atomic-write` 的 `withFileLock` + `writeFileAtomic`（M0 已用；它不 fsync，目录 fsync 由 store 补）。锁 target 固定为 `.dsh-cowork/.write.lock`；`withFileLock` 在 target 旁以 `<target>.lock` 创建互斥文件，因此实际磁盘锁是 `.write.lock.lock`（S1 实测，保留该命名不改）。同一时刻只允许一个写者；索引与单个 handoff 分开写，不整项目重写。
- 所有 JSON 写入前校验，读取后校验；损坏的文件返回带路径的可读错误，不静默重建。

**项目发现与调用者身份**

- 工具执行面用 `exec.agent` 取得调用会话；由会话 header 取 `id` 与 `cwd`。若 `exec.agent` 缺失（例如 PTC 下的某些执行路径），工具 fail closed 并返回明确错误，不猜测“当前项目”。
- 从 `cwd` 向上找 `.dsh-cowork/index.json`；找不到就报 `project/not-initialized`。`cowork_project_init` 以调用者 cwd 为项目根，幂等；若该路径已有索引且 master 不同，拒绝覆盖并返回现有 master。
- workspace 解析：`workspaceRegistry.resolveByPath(repoPath)`；没有 workspace 时由 init 创建（`workspaceRegistry.create(repoPath)`；不传 `title`，宿主已无生产调用方，标题由路径末段生成）并把 workspaceId 返回；索引不缓存 workspaceId，registry 是唯一事实源。
- 角色校验：thread 只能为自己的 `threadId` 调 `cowork_handoff`；master 只能调 init/route/thread_create/thread_list/project_status。越权返回 `role/forbidden`，不靠 prompt 约束。

**session-slice**

- `createThread({repoPath, subject})`：解析 workspaceId → `sessionController.create({workspaceId, agentPreset:'cowork-thread'})` → `rename({sessionId, title:'cowork: '+subject})`。create 的返回值缺失 `agentPreset` 时视为失败，不写索引。
- `promptThread(threadId, text)`：`sessionController.prompt({sessionId, requestId: crypto.randomUUID(), mode:'queue', content:[{type:'text', text}]})`；`accepted:true` 只代表入队，不等于跑完。
- `ensureSession(sessionId)`：用 `sessionController.list` 或 `inspect` 判断是否仍可见；不可见返回 `thread/session-missing`，不尝试静默重建。
- 不在 M1 做 session 历史读取、搜索、模型选择或取消。

**router**

- 纯函数 `scoreThread(intent, thread, lastHandoffSummary, now)`：
  - token 化：小写、去标点；ASCII 词按空白/标点切分；CJK 取相邻二字 bigram。纯函数、无外部依赖。
  - `score = subjectOverlap*3 + keywordOverlap*2 + statusPenalty + recencyBonus`。
  - 排除 `done|archived`；`blocked` −1；`awaiting_review` −0.5；最近 7 天 +1、30 天内 +0.5、更早 0。
  - `subjectOverlap` 与 `keywordOverlap` 用集合交集的计数，不做向量或语义模型。
- 决策：最高分 ≥ `routeThreshold`（默认 4）且比第二名高 ≥1 时复用；否则新建。阈值放 Config，允许 profile 覆盖。
- `cowork_route({intent, subject?})`：复用 → `promptThread` 并返回 `{action:'routed', threadId, score}`；未命中且给了 subject → 创建 thread、写索引、prompt 初始 brief、返回 `{action:'created', threadId}`；未命中且没有 subject → `{action:'needs_subject', candidates}`，由 master 生成 subject 再调。M1 不让路由工具凭空编造 subject。
- 初始 brief 只含：项目根、thread 主题、用户 intent、`cowork_handoff` 的要求、不要越界改其他 thread 的文件。M2 的项目记忆不在这里注入。

**handoff**

- `cowork_handoff` 必填：`status`、`summary`、`verification[]`；`verification` 每项含 `command`、`exitCode`、`evidence`。可选：`decisions`、`changedPaths`、`artifacts`、`openIssues`、`nextStep`。
- 校验失败返回 `handoff/invalid` 与逐字段原因，不写文件。
- `status` 只接受 `awaiting_review|blocked|done`（`new/active` 不是 handoff 状态）。
- 写入顺序固定：handoff 文件（唯一事实源，原子写）→ 更新索引 → 投递 master。若进程在两步之间崩溃，索引可能落后于文件；`cowork_project_init` 与 `cowork_project_status` 在读索引前先扫描 `handoffs/`，把 `Date.parse(createdAt)` 晚于 `Date.parse(lastHandoffAt)` 的文件按 status 回填索引（epoch 比较，不做文件名字符串比较），幂等。
- 投递失败仍保留文件与索引，返回 `delivered:false` 与可重放的提示；`cowork_project_status` 扫描 `deliveredAt` 为空的 handoff 重投，重投成功只补写该字段。若 master prompt 成功但随后写 `deliveredAt` 失败，返回 `delivered:true` 并附 `deliveryError`：投递已发生，标记可由下次 status 补写。
- master 收到的消息是文本摘要（主题、status、summary、verification、changedPaths、handoff 文件路径），不把整个 JSON 塞进 prompt。

**presets（S0 已回答）**

- S0 实测（[结果](../../../docs/M1_S0_RESULT.md)）：空 `plugins` preset 能完成一轮，但只看到 46 个 profile 级全局工具，没有 bash/fs/read/write 等 preset-scoped 工具；`agentPresets.resolve('standard')` 只返回 `{id}`，`readDocument('standard')` 只返回含 `!!js` 的 YAML 文本，`compositionInventory()` 只给模块名。结构化 `plugins` 不可得，空 preset 不可用于 thread。
- 因此 `cowork-master` / `cowork-thread` 在运行时注册**显式行**：persona 覆盖 + 从 standard 同源挑选的最小工具集；M1 不解析 YAML、不写 profile patch，M4 再把同一份行迁到 bundle patch（M1 的 preset 仍随重启消失，如实记录）。
- `exec.agent` 在 standard 与空 preset 两种组合下都已实测可用：`exec.agent.id` 与会话 id 一致，`exec.agent.session.header.cwd` 等于 workspace path；缺失时 fail closed。
- `cowork-master` 的 persona：路由、记录决策、验收，不直接改实现文件。`cowork-thread`：只做本 thread，先读 handoff/索引，完成必须 handoff。`ctx.tools.restrict` 只在 `agent.ctx` 上可用，M1 没有 preset-scoped 插件模块去调用它，因此**不硬限制 master 的写工具**，文档写明“prompt + 工具角色校验，未硬限制”。

**工具面（M1）**

| 工具 | 调用者 | 作用 |
|---|---|---|
| `cowork_project_init` | master | 建立/读取索引，登记 master，保证 workspace |
| `cowork_project_status` | master/thread | 索引、thread 概览、待投递 handoff |
| `cowork_route` | master | 打分、复用或创建并投递 |
| `cowork_thread_create` | master | 显式创建 thread |
| `cowork_thread_list` | master/thread | 列出 thread |
| `cowork_handoff` | thread | 结构化汇报并投递 master |

所有工具输出 JSON；错误统一 `{ok:false, error:{code, message, details?}}`。不新增 memory/worktree/review 工具（M2/M3）。

**不在 M1**

项目记忆、worktree、独立 review、客户端面板、desktop profile 适配、bundle 持久化、模型辅助路由、定时/后台任务。M1 不改 `docs/PLAN.md` 的范围。

## Alternatives considered

**先做项目记忆而不是主从闭环。** 否决：记忆要有 master/thread 才有消费者；先做记忆会得到一个没有调用方的存储层，也无法验证 PLAN §6 的 E2E。

**把 route 做成纯查询，由 master 自己创建/投递。** 否决：PLAN §2.2 要求 route 命中即投递、未命中即新建；拆成多次工具调用会把“是否正确路由”分散到模型的多步决策里，E2E 也更难断言。保留 `needs_subject` 分支，让 subject 仍由 master 生成。

**用向量/模型语义检索做路由。** 否决：PLAN §1.3 明确 MVP 不做向量检索；本地关键词 + 阈值足以支撑 M1，误判时 master 可以显式 `cowork_thread_create` 纠正。

**把 handoff 直接塞进 master 的 prompt，不落盘。** 否决：PLAN §5.4 要求投递失败不丢 handoff，且 master 下次 status 可重放；没有文件就没有重放源。

**为 M1 同时引入 AgentTeams 或第三方协作运行时。** 否决：PLAN §8 与 AGENTS.md 的 no-multi-orchestrator 明确禁止；M1 只用 `sessionController`。

**把 preset 声明直接写进 profile patch。** 否决：M0 已证明运行时注册可用，M1 用热注入做 E2E；写 profile 会污染用户环境，持久化属于 M4 的 bundle 安装路径。

## Acceptance criteria

- [A1] `cowork_project_init` 在仓库根建立 `index.json`，`masterSessionId` 等于调用会话，重复调用幂等且不覆盖已有 master — `source`
- [A2] master 调 `cowork_route({intent, subject})` 在无匹配时创建 thread：会话出现在 `sessionController.list`、`workspace.sessionIds` 含该 id、索引状态为 `new|active` — `source`
- [A3] 再次用相关 intent 调 `cowork_route` 复用同一 thread 并投递 prompt；无关 intent 不会误复用 — `source`、`tests`
- [A4] thread 调 `cowork_handoff` 写入 handoff 文件、更新索引、master 会话收到含 summary/verification 的消息；投递失败时文件与索引保留，status 可重放 — `source`
- [A5] `store`/`router`/`handoff` 纯模块有单测：原子写、锁、损坏 JSON、打分边界、阈值、必填字段 — `tests`
- [A6] `npm run typecheck`、`npm run build`、`npm run check`、`npm test` 全绿；无第三方协作依赖 — `packaging`
- [A7] 文档同步：M1 结果与证据写入 docs，`docs/publish.json` 分类，`npm run check` 通过 — `publication`
- [A8] 角色越权返回 `role/forbidden`；`exec.agent` 缺失时返回明确错误而不是猜测项目 — `source`

## Risks

- preset 结构化 `plugins` 不可得（S0 实测）→ 改用显式行；代价是行清单可能随宿主版本漂移，靠 `compositionInventory()` 对照。重审条件：宿主暴露结构化 preset 定义，或 standard 行变化。
- 中文关键词路由误判 → 保守阈值、返回 `needs_subject`/候选，master 可显式建房；重审条件：真实需求样本出现系统性误判。
- master 模型收到 handoff 后不行动 → M1 只验收“投递成功”，不验收“自动修复”；重审条件：M3 review 闭环。
- 并发写索引 → 项目级锁 + 原子替换；单测覆盖并发写与半写恢复；重审条件：出现跨进程写者。
- `exec.agent` 在 PTC 路径不可用 → 工具 fail closed；重审条件：宿主工具执行面变化。
- 运行时 preset 重启消失 → M1 如实记录，M4 bundle patch 解决；重审条件：M4 提前。
- 角色只做工具层校验、未硬限制 master 写文件 → 文档写明；重审条件：出现 preset-scoped 插件模块可调用 `ctx.tools.restrict`。

## Delivery stages

1. S0 preset 组合与调用者身份探针 — 已完成：空 preset 只有全局工具，`standard` 只有 YAML 文本，`exec.agent` 可用；证据见 [S0 结果](../../../docs/M1_S0_RESULT.md)。
2. S1 store + 单测 — 索引/handoff 原子写与锁可用。
3. S2 session-slice + workspace 解析 — create/prompt/rename/list 封装可用。
4. S3 router + 单测 — 打分与阈值可复现。
5. S4 handoff + 单测 — 校验、落盘、投递、重放可用。
6. S5 tools + presets + M1 E2E — 六个工具在真实宿主跑通 §6 验收。
7. S6 文档与证据 — M1 结果、限制、未验证项入 docs；检查全绿。
