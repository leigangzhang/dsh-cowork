# Decision: M1 master/thread 闭环

Status: implemented
Date: 2026-11-05
Class: feature

## Problem

M0 证明了五项宿主 API，但仓库还没有产品：没有项目索引、没有路由、没有 handoff、没有可用的 `cowork-*` preset，也没有 `cowork_*` 工具。用户无法初始化项目、把一个需求交给 thread，或让 thread 把结果交回 master；M2/M3 的项目记忆、worktree、review 也无处附着。

M1 的完成定义由 [PLAN §6](../../../../docs/PLAN.md) 固定：初始化项目生成 `index.json` 且 master 正确；master 发需求自动新建 thread 并出现在侧栏；再次发相关需求能路由到已有 thread；thread 调 handoff 后 master 收到结构化消息；不使用第三方协作运行时。M0 同时纠正了两条前提：`sessionController.create` 只有传 `workspaceId` 才挂 workspace；运行时注册的 preset 重启即消失。M1 还必须回答一个新事实：本部署的工具挂在 preset 的 `plugins` 列表里，空 `plugins` preset 是否能支撑 thread 工作。

## Decision

M1 交付 host-only 闭环（client 面板仍属 M3），由纯模块与薄宿主适配层组成，已按下列契约落地。

**模块边界**

- [`src/store.ts`](../../../../src/store/project-store.ts) 是 `index.json` 与 handoff 文件的唯一写者：`withFileLock` + `writeFileAtomic` + 目录 fsync；锁 target 为 `.dsh-cowork/.write.lock`，`withFileLock` 在其旁创建 `.write.lock.lock`；损坏文件带路径报 `store/corrupt`，不静默重建。
- [`src/session-slice.ts`](../../../../src/platform/session-slice.ts) 封装 `sessionController` 的 create/prompt/rename/list 与 workspace 解析；索引不缓存 workspaceId。
- [`src/routing.ts`](../../../../src/routing.ts) 是纯函数关键词路由，无 I/O、无内部时钟。
- [`src/handoff.ts`](../../../../src/handoff.ts) 负责 handoff 校验、落盘、索引更新、投递与重放，只以类型方式引用 store。
- [`src/tool-model.ts`](../../../../src/platform/tool-model.ts) 负责调用者身份、角色校验与错误包络；[`src/tools.ts`](../../../../src/tools.ts) 提供六个工具。
- [`src/presets.ts`](../../../../src/platform/presets.ts) 注册两个运行时 preset；[`src/index.ts`](../../../../src/index.ts) 装配工具、preset 与既有探针。

**数据模型（v1）**

- `<repo>/.dsh-cowork/index.json`：`version:1`、`projectId`、`masterSessionId`、`createdAt`、`threads[]`；thread 字段为 `threadId`、`subject`、`status`（`new|active|awaiting_review|done|blocked|archived`）、`cwd`、`worktreePath`、`createdAt`、`updatedAt`、`lastHandoffAt`。
- `<repo>/.dsh-cowork/handoffs/<threadId>-<stamp>.json`：PLAN §4.3 的 handoff 字段加 `version`、`createdAt`、`deliveredAt`。文件名只保证唯一性，排序与比较一律用 `createdAt` 的 epoch；`deliveredAt` 为 null 表示待投递。
- `projectId` 优先取规范化的 `git remote get-url origin`（如 `github.com-owner-repo`），没有 remote 时取 `sha256(realpath(repoPath))` 前 12 位；时间统一 ISO 8601 UTC，文件名用 `YYYYMMDDTHHmmssSSSZ`。
- 状态推进：`new → active`（首次 prompt 成功）；handoff 按自身 `status` 写 `awaiting_review|blocked|done`；route 排除 `done|archived`；`archived` 只由用户操作。

**项目发现与调用者身份**

- 工具执行面用 `exec.agent` 取会话 id 与 `session.header.cwd`；缺失时 fail closed 返回 `exec/agent-unavailable`，不猜项目。
- 从 `cwd` 向上找 `.dsh-cowork/index.json`；找不到报 `project/not-initialized`。`cowork_project_init` 以调用者 cwd 为根、幂等、永不覆盖已有 master。
- workspace 解析先 `workspaceRegistry.resolveByPath`，没有时 `workspaceRegistry.create(repoPath)`（不传 title），索引不缓存 id。

**路由与工具面**

- `tokenize` 小写、去标点：ASCII 词按分隔符切分，CJK 取相邻二字 bigram（单字保留）。
- `score = subjectOverlap*3 + keywordOverlap*2 + statusPenalty + recencyBonus`；`blocked -1`、`awaiting_review -0.5`；`updatedAt` 在 7 天内 +1、30 天内 +0.5、更早 0。
- 复用条件：最高分 ≥ 4（`DEFAULT_ROUTE_THRESHOLD`）且比第二名高 ≥1；否则新建或返回 `needs_subject`。候选按 total 降序、threadId 升序。
- 六个工具：`cowork_project_init`、`cowork_project_status`、`cowork_route`、`cowork_thread_create`、`cowork_thread_list`、`cowork_handoff`；统一输出 JSON，错误为 `{ok:false, error:{code, message, details?}}`。
- 角色校验在工具层：init/route/thread_create 仅 master，handoff 仅 thread 且只能报自己的 threadId，status/thread_list 对 master 与 thread 开放；越权返回 `role/forbidden`。

**handoff**

- 必填 `status`（仅 `awaiting_review|blocked|done`）、`summary`、非空 `verification[]`（每项 `command`、整数 `exitCode`、`evidence`）；可选 `decisions`、`changedPaths`、`artifacts`、`openIssues`、`nextStep`。
- 顺序固定：校验（失败不写文件）→ 写 handoff 文件 → 更新索引 → 投递 master。投递失败保留文件与索引并返回 `delivered:false`；仅成功投递后写 `deliveredAt`；`cowork_project_status` 重放 `deliveredAt` 为 null 的文件，只标记成功项。
- master 收到的是文本摘要（主题、status、summary、verification、changedPaths、文件路径），不塞整份 JSON。

**preset 策略（S0 结论）**

- S0 实测：空 `plugins` preset 能完成一轮，但只挂 profile 级全局工具，没有 bash/fs 等 preset-scoped 工具；`agentPresets.resolve('standard')` 只返回 `{id}`，`readDocument` 只给含 `!!js` 的 YAML 文本，`compositionInventory()` 不含 config——结构化 plugins 不可得，空 preset 不可用于 thread（[S0 结果](../../../../docs/handoff/M1_S0_RESULT.md)）。
- 因此 `cowork-master` / `cowork-thread` 以运行时显式行注册：persona 覆盖 + 10 行最小工具集（agent-instructions、time-context、bash、fs、fs-search、jobs、ask-user、todo、present）；第二次注册失败会回滚第一个。M1 不解析 YAML、不写 profile patch。
- `exec.agent` 在 standard 与空 preset 下均可用；`ctx.tools.restrict` 只在 `agent.ctx` 上可用，M1 没有 preset-scoped 模块调用它，故不硬限制 master 的写工具。

## Alternatives considered

**先做项目记忆而不是主从闭环。** 否决：记忆要有 master/thread 才有消费者；先做记忆会得到一个没有调用方的存储层，也无法验证 PLAN §6 的 E2E。

**把 route 做成纯查询，由 master 自己创建/投递。** 否决：PLAN §2.2 要求 route 命中即投递、未命中即新建；拆成多次工具调用会把“是否正确路由”分散到模型的多步决策里，E2E 也更难断言。保留 `needs_subject` 分支，让 subject 仍由 master 生成。

**用向量/模型语义检索做路由。** 否决：PLAN §1.3 明确 MVP 不做向量检索；本地关键词 + 阈值足以支撑 M1，误判时 master 可以显式 `cowork_thread_create` 纠正。

**把 handoff 直接塞进 master 的 prompt，不落盘。** 否决：PLAN §5.4 要求投递失败不丢 handoff，且 master 下次 status 可重放；没有文件就没有重放源。

**为 M1 同时引入 AgentTeams 或第三方协作运行时。** 否决：PLAN §8 与 AGENTS.md 的 no-multi-orchestrator 明确禁止；M1 只用 `sessionController`。

**把 preset 声明直接写进 profile patch。** 否决：M0 已证明运行时注册可用，M1 用热注入做 E2E；写 profile 会污染用户环境，持久化属于 M4 的 bundle 安装路径。

**克隆 `standard` 的 `plugins` 结构来拼 preset。** 否决（S0 实测）：`resolve('standard')` 只返回 `{id}`，`readDocument` 只有含 `!!js` 的 YAML 文本，`compositionInventory()` 不含 `config`；没有结构化数组可克隆，重新解析 Loader 方言不属 M1 范围。改用显式行清单。

## Consequences

- preset 行清单可能随宿主版本漂移；用 `compositionInventory()` 对照。重审条件：宿主暴露结构化 preset 定义，或 standard 行变化。
- 中文关键词路由会误判；保守阈值 + `needs_subject`/候选，master 可显式建房。重审条件：真实需求样本出现系统性误判。
- master 收到 handoff 后不行动不在 M1 验收范围；M1 只验收“投递成功”。重审条件：M3 review 闭环。
- 索引并发写由项目级锁 + 原子替换保护；单测覆盖并发与损坏。重审条件：出现跨进程写者。
- `exec.agent` 在 PTC 路径不可用；工具 fail closed。重审条件：宿主工具执行面变化。
- 运行时 preset 重启即消失；M1 如实记录，M4 bundle patch 解决。重审条件：M4 提前。
- 角色只做工具层校验、未硬限制 master 写文件；文档写明。重审条件：出现 preset-scoped 插件模块可调用 `ctx.tools.restrict`。
- 侧栏 DOM、desktop profile、PTC 内层 dispatch 仍未验证；探针与 E2E 设施是临时证据代码，收口时保留在 `src/index.ts` 与 `.dsh-cowork/`。

## Testing

- [A1] `cowork_project_init` 建 `index.json`、`masterSessionId` 等于调用会话、重复调用幂等且不覆盖 master — `source`：E2E run `e2e-9f61bf5b-5320-42e0-8064-cae7c605b0d2` 的 `init`（`created:true`）与 `init-idempotent`（`created:false`，master 不变）；证据见 `docs/handoff/M1_RESULT.md` A1 与 `.dsh-cowork/e2e/M1_E2E.json`。
- [A2] `cowork_route({intent, subject})` 无匹配时创建 thread：会话进 `sessionController.list` 与 `workspace.sessionIds`，索引状态为 `active` — `source`：同一 run 的 `route-create`（`threadInSessionList:true`、`threadInWorkspace:true`、`status:active`）。
- [A3] 相关 intent 复用同一 thread 并投递 prompt，无关 intent 不误复用 — `source`、`tests`：run 的 `route-reuse`（score 10、同 threadId）与 `route-unrelated`（`needs_subject`、线程数不变）；边界由 `tests/router.test.mjs` 10 用例钉住。
- [A4] thread 调 `cowork_handoff` 写文件、更新索引、master 收到含 summary/verification 的消息；投递失败保留且 status 可重放 — `source`：run 的 `handoff`（`delivered:true`、文件与 `deliveredAt`、`masterReceivedHandoff:true`）与 `status`（`pendingHandoffs:[]`）；失败保留与重放由 `tests/handoff.test.mjs` 10 用例覆盖。
- [A5] `store`/`router`/`handoff`/`session-slice`/`tool-model` 纯模块单测覆盖原子写、锁、损坏 JSON、打分边界、必填字段 — `tests`：`npm test` 65/65 通过，其中 M1 用例 52 个（store 11、handoff 10、router 10、session-slice 14、tool-model 7）。
- [A6] `npm run typecheck`、`npm run build`、`npm run check`、`npm test` 全绿，且无第三方协作依赖 — `packaging`：四条命令 exit 0（`docs/handoff/M1_RESULT.md` A6）；`package.json` 只有 `@deepseek-ai/*` 宿主 peer 依赖，`src/` 无 `dsh-agent-hub`/`dsh-forge`/`dsh-team-conductor` 或 AgentTeams 的 import。
- [A7] 文档同步：M1 结果与证据写入 `docs/handoff/M1_RESULT.md`，提案迁至 implemented，`docs/publish.json` 分类且 `npm run check` 通过 — `publication`：本记录与 `docs/handoff/M1_RESULT.md` 均有 internal 条目且 `npm run check` 恰好一次分类。
- [A8] 角色越权返回 `role/forbidden`；`exec.agent` 缺失返回明确错误 — `source`：run 的 `role-forbidden`（thread 调 init 得到 `role/forbidden`）；`src/tool-model.ts` 的 `readCaller` 与 `exec/agent-unavailable` 由 `tests/tool-model.test.mjs` 7 用例覆盖。
