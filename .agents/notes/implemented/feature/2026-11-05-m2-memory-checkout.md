# Decision: M2 项目记忆与 thread checkout 隔离

Status: implemented
Date: 2026-11-05
Class: feature

## Problem

M1 只交付主从闭环：项目索引、路由、handoff、六个工具、两个运行时 preset（[M1 结果](../../../../docs/handoff/M1_RESULT.md)）。它没有解决 PLAN M2 的两个问题：

1. **知识不沉淀。** 每个 thread 都从零开始。用户纠正过的约束、master 确认过的决策、项目事实（口径、精确数字、外部约定）只存在于某次对话里，新 thread 读不到；thread 之间也没有共享渠道。
2. **实现不隔离。** 所有 thread 共用同一个工作区。两个 thread 同时改代码会互相覆盖，master 也没有可审查的“一个 thread 的完整改动集”；合并动作没有边界，无法回答“这个 thread 到底改了什么、有没有污染主工作区”。

PLAN §5.5/§5.6 与 §6 M2 给出了目标验收。M1 留下两个事实：会话 `create` 必须传 `workspaceId` 才挂 workspace（[M0 结果](../../../../docs/handoff/M0_PROBE_RESULT.md)）；preset 是运行时注册、重启即消失。M2-P0 又证实第三个事实：会话 cwd 创建后不能重绑，沙箱只允许写会话 cwd 与临时目录（[M2-P0 结果](../../../../docs/handoff/M2_PROBE_RESULT.md) §1、§4）。

## Decision

M2 仍是 host-only：新增项目记忆与 thread checkout 两个能力，工具面扩到九个，不改 M1 的路由、handoff 与角色语义；客户端面板仍属 M3。隔离实现采用 **F 方案：每 thread 一个本地 clone**（经用户确认），不是 `git worktree`。

**模块边界**

- [`src/memory.ts`](../../../../src/memory.ts)：记忆文件的解析、校验、按预算拼注入块、关键词检索与追加写；文件 IO 由调用方注入，时钟可替换。
- [`src/checkout.ts`](../../../../src/checkout.ts)：`git` CLI 适配器，负责 clone/checkout/inspect/merge/remove 与错误码映射；所有 git 调用带 cwd、超时与参数数组。
- [`src/memory-prompt.ts`](../../../../src/memory-prompt.ts)：把记忆块注册为 agent 作用域的 system prompt 段落，按 preset 与项目根过滤，跟踪 disposer。
- [`src/tools.ts`](../../../../src/tools.ts) / [`src/tool-model.ts`](../../../../src/tool-model.ts) / [`src/store.ts`](../../../../src/store.ts) / [`src/session-slice.ts`](../../../../src/session-slice.ts) / [`src/index.ts`](../../../../src/index.ts)：工具面、错误包络、索引字段、clone 会话创建与装配。

**数据模型（索引 version 仍为 1）**

- `<repo>/.dsh-cowork/memory/{constraints,decisions,facts}.md`；每条一个二级标题 + 正文 + 来源行：

```markdown
## 提交信息使用中文

正文一句话说明约束或事实。

(来源: user / thread session-abc / src/file.ts:12; 2026-11-05T12:00:00Z)
```

- `cowork_memory_write({kind, title, text, source})`：`kind` 只接受 `constraint|decision|fact`；三个字段非空；单条正文 ≤8000 字符、拒绝控制字符；追加写，写入前解析整个文件，损坏则带行号报错且不改文件；目录锁 + 原子替换。
- `cowork_memory_search({query, limit?})`：默认 5、上限 20；用 router 的 `tokenize`（ASCII 词 + CJK bigram）对 title×3 + text×2 + source×1 打分，按分数降序、再按来源时间降序；返回 `{kind, title, text, source, file, createdAt, score}`；不做向量检索。
- 注入预算默认 3000 tokens，按 `ceil(chars/4)` 估算；按 constraints → decisions → facts 拼整条，超预算即停止并追加 `[memory truncated]`。
- thread 记录字段 `checkoutPath`（由 M1 的 `worktreePath` 归一化而来，旧索引仍可读）；它是 checkout 的唯一事实源。
- checkout 路径 `<repo>/.dsh-cowork/threads/<threadId>`，分支 `cowork/<threadId>`；目录在 `.gitignore` 内。

**记忆注入**

- 全局插件在 `agent/created` 与 `listAgents()` 上拿到 agent，只对 `agentPreset ∈ {cowork-master, cowork-thread}`、`session.header.cwd` 非空、`findProjectRootSync(cwd)` 命中 `.dsh-cowork/index.json` 的 agent 注册段落。
- 段落 `name: 'cowork:memory'`、`order: 900`、`interpolate: false`；`text` 是函数，每次 assembly 重读三个文件。digest（sha1）不变时复用缓存文本，变化时替换；缓存按 agent 隔离。
- 注册失败（同名重复等）只计数、记录日志并跳过该 agent，不中断其他 agent；`dispose` 幂等，先解监听再释放所有 section disposer。
- 注入内容只含三条 kinds 的标题、正文与来源，不含 handoff 全文或隐藏状态。

**thread checkout 生命周期**

- 创建顺序：`threadId → git clone --local → git checkout -b cowork/<threadId> → workspace.create(clone) → session.create({sessionId, workspaceId, agentPreset}) → 索引 → brief`。显式 sessionId 让分支名在会话存在前就确定；宿主会规范化路径（`/tmp` → `/private/tmp`），索引存规范化后的 clone 路径。任一步失败补偿删除索引记录、clone 与本次创建的 workspace。
- `cowork_checkout_merge({threadId, message?})`（master only）：前置 thread 存在、`checkoutPath` 非空、状态 ∈ `{awaiting_review, done}`、clone 干净（`git status --porcelain` 为空，含 untracked）。合并执行 `git fetch <clone> +refs/heads/cowork/<id>:refs/heads/cowork/<id>`，再 `git merge --no-ff`。
- 成功：删 clone 与分支、删 workspace、归档会话、索引 `checkoutPath=null`、`status='done'`。
- 冲突：`git merge --abort`、保留 clone 与分支、索引 `blocked`、返回冲突文件；thread 在 clone 内 fetch 主分支、解决并提交后重新 handoff，master 重试即走成功路径。
- 其他失败（脏树、merge 非冲突失败、fetch/删除失败）返回稳定错误码并保留现场；`cowork_project_status` 提供只读 checkout 摘要，不做自动修复。
- 角色：`memory_write` / `memory_search` 对 master 与 thread 开放；`checkout_merge` 仅 master；越权仍 `role/forbidden`。

**工具面（九个）**

`cowork_project_init`、`cowork_project_status`、`cowork_route`、`cowork_thread_create`、`cowork_thread_list`、`cowork_handoff`、`cowork_memory_write`、`cowork_memory_search`、`cowork_checkout_merge`。`cowork_route` 与 `cowork_thread_create` 增加 `isolated?: boolean`：仅当显式传 true 才建 clone，M1 行为保持。`cowork_review_request` 仍未实现，属 M3。

**为什么不是 `git worktree`**

- P0 实测：linked worktree 的 git 元数据在 `<repo>/.git/worktrees/<id>`，而 thread 会话的沙箱根是它自己的 cwd；在 workspace-write 策略下 `git add/commit` 被拒（`Unable to create '…/.git/worktrees/…/index.lock': Operation not permitted`，exitCode 128）。thread 能改文件但不能提交（[M2-P0 §4](../../../../docs/handoff/M2_PROBE_RESULT.md)）。
- 另一个可选路径是「thread 保持仓库 cwd、按绝对路径操作 worktree」，它能提交，但隔离退化为行为约定，且同一会话仍可写主工作区。
- clone 的 `.git` 在会话 cwd 内，thread 自己能提交；master 用 `fetch` + `merge --no-ff` 合并，冲突与重试语义与 worktree 流程相同（[M2-P0 §5](../../../../docs/handoff/M2_PROBE_RESULT.md)）。workspace-write 是插件必须支持的最小权限，F 在该前提下成立，不依赖全权限。

## Alternatives considered

**只做 worktree，不做记忆。** 否决：PLAN §6 M2 与 §5.5 把两者放在同一里程碑；只有 worktree 会得到“隔离得很好但每个 thread 仍然重复踩坑”的系统，且记忆的验收（新 thread 读到约束）没有交付窗口。

**先做记忆，checkout 留到 M3。** 否决：checkout 决定 thread 的 cwd 与合并语义，会改动 M1 的 thread 创建与索引状态；越晚引入，返工越大。两者共用索引与工具装配，同一里程碑内先 P0 定契约更省成本。

**记忆用向量/模型检索。** 否决：PLAN §1.3 明确 MVP 不做向量检索；M2 的记忆量小，关键词 + 预算足以支撑，误召回由 `cowork_memory_search` 的返回与 master 判断兜底。

**记忆接入外部服务（OpenViking / dsh-project-memory）。** 否决：PLAN §8 要求默认只读自己的 `.dsh-cowork`，不接 OpenViking；M2 用文件 provider，适配器接口等有第二个消费者再抽象，避免过早造 seam。

**合并时自动提交 thread 的未提交改动。** 否决：自动提交会把“半成品/调试残留”固化成历史，且让 master 失去审查边界。改为脏树拒绝（`checkout/dirty`），由 thread 自己提交后再 merge。

**冲突时自动 rebase 或强制合并。** 否决：M0/M1 的纪律是不自动解决冲突；保留 clone 现场、置 `blocked`、返回冲突文件，由原 thread 或人处理，重试才 merge。

**每个 thread 一律强制隔离。** 否决：M2 是增量能力；只读/小改动 thread 不需要额外目录与 merge 成本。`isolated: true` 显式开启，M1 行为保持。

**C 方案：thread 会话 cwd = worktree，强制隔离。** P0 实测否决：沙箱根是会话 cwd，而 linked worktree 的 git 元数据在仓库 `.git/worktrees/` 下，thread 侧 `git add/commit` 得到 EPERM（exitCode 128）；要保住强制隔离只能由插件代 thread 提交，改动面与审查边界都更大。

**B 方案（F 的对比项）：thread 保持仓库 cwd，按绝对路径在 worktree 中工作。** 保留为备选（P0 证明可以提交、`git -C` 可操作），但否决：隔离只是行为约定，同一会话能写主工作区，且与 PLAN “thread 落到独立目录”的承诺不符。

**F 方案：每 thread 一个本地 clone（采用）。** 经用户确认。代价是 clone 成本、thread 读不到主工作区、依赖要自己装；换来 workspace-write 下的强制隔离与 thread 自主提交（[M2-P0 §5](../../../../docs/handoff/M2_PROBE_RESULT.md)、[E2E 证据](../../../../docs/handoff/M2_RESULT.md)）。

## Consequences

- clone 成本：`--local` 约 101 ms、磁盘为 tracked 工作树量级；thread 需要 `node_modules` 时必须在 clone 内安装。重审条件：clone 时间或磁盘成为实际瓶颈。
- 隔离边界：thread 读不到主仓库工作区；master 审查要在主仓库看 fetch 后的分支或 `git -C <clone>`。
- preset 仍是运行时注册，重启即消失；记忆 section 随 agent 存活，插件卸载由 dispose 释放。重审条件：M4 提供持久化安装路径。
- 热重载可能与活着的 agent 上旧 section 同名：实现捕获异常、计数并 warn，不中断其他 agent；旧 provider 是否残留取决于上一代插件是否正常 dispose。重审条件：宿主提供作用域回收保证。
- 冲突不自动解决：保留 clone 与分支、索引 `blocked`，由 thread 或人处理。重审条件：需要自动合并策略时另立决策。
- 记忆只追加，不更新、不删除、不压缩；预算与检索 limit 防止无界注入。重审条件：真实项目记忆超过预算。
- merge 成功后的 teardown（删 clone/workspace/会话、写索引）不是事务；一步失败会留下“已合并但清理不全”的现场，由 status 对照人工收尾（[M2 结果 · 限制](../../../../docs/handoff/M2_RESULT.md)）。重审条件：M3 把 teardown 失败降级为可读明细。
- 中文关键词检索会误召回；返回来源与文件路径供判断。重审条件：出现系统性误召回。
- 路径守卫只删 `<repo>/.dsh-cowork/threads/<threadId>` 与分支 `cowork/<threadId>`；`.gitignore` 必须持续忽略 `.dsh-cowork/`。

## Testing

- [M2A1] `cowork_memory_write` 追加带来源的条目到对应 `memory/*.md`，另一个 thread 能检索到同一内容；写入原子、目录锁、损坏文件带行号报错 — `source`、`tests`：E2E run `m2-2d375750-…` 的 `memory-write`（原文见 [M2 结果](../../../../docs/handoff/M2_RESULT.md)）与 `memory-cross-thread`（`hits[0].title='E2E 约束'`、`score=6`）；`tests/memory.test.mjs` 29 用例覆盖损坏、预算与评分。
- [M2A2] 新建或已存在的 cowork agent 在其 system prompt 中看到预算内记忆块；写入后下一次 assembly 重新求值 — `source`、`tests`：注入 seam 由 P0 证明（[M2-P0 §2](../../../../docs/handoff/M2_PROBE_RESULT.md)），`tests/memory-prompt.test.mjs` 19 用例覆盖 preset 过滤、digest 复用/更新、dispose；E2E 的 `memory-cross-thread` 证明 thread 可检索同一记忆（注入文本本身未从模型回复反证）。
- [M2A3] `isolated: true` 的 thread 落到 `.dsh-cowork/threads/<threadId>`、分支 `cowork/<threadId>`，索引写 `checkoutPath`；失败不改索引、不留半成品 — `source`、`tests`：E2E `isolated-thread`（`sessionCwd == checkoutPath`、branch 输出）；`tests/checkout.test.mjs` 26 用例覆盖命令序列与失败清理。
- [M2A4] thread 在 clone 中的提交经 `cowork_checkout_merge` 合入主分支后，主工作区没有该 thread 的未提交改动；clone 与分支被清理、索引 `checkoutPath=null` — `source`：E2E `thread-work`（commit `ad71b3e`）与 `merge-success`（`cleanup` 四项 true、`rev-parse` 分支 128、`e2e.txt` 进入主工作区）。
- [M2A5] 冲突保留 clone/分支、索引 `blocked`；thread 解决后重试成功；脏树被 `checkout/dirty` 拒绝且不产生合并提交 — `source`：E2E `conflict-merge`（`merge-conflict`、`blocked`、主仓 `git status` 空）与 `conflict-retry`（`resolved`、`commit 84422ac…`、最终 `done`）；`tests/checkout.test.mjs` 覆盖 dirty 与 abort。
- [M2A6] `src/memory.ts`、`src/checkout.ts`、`src/memory-prompt.ts` 纯逻辑有单测 — `tests`：`npm test` 145/145，其中 memory 29、checkout 26、memory-prompt 19。
- [M2A7] `npm run typecheck`、`npm run build`、`npm run check`、`npm test` 全绿；`package.json` 不新增第三方协作运行时或记忆依赖 — `packaging`：集成装配验证与 E2E 驱动验证记录 typecheck/build/check/test exit 0；`package.json` 仍只有 `@deepseek-ai/*` peer 依赖。
- [M2A8] M2 结果与限制写入 docs、`docs/publish.json` 分类、M2 交接文档更新，`npm run check` 通过 — `publication`：`docs/handoff/M2_PROBE_RESULT.md`、`docs/handoff/M2_RESULT.md`、本记录均在 `docs/publish.json` 有 internal 条目，`npm run check` 验证每份 Markdown 恰好分类一次。

## Delivery stages

1. M2-P0 探针：回答会话 cwd/workspace 绑定、记忆注入时机、git 行为与 thread 侧 git 写；结论落入 [M2-P0 结果](../../../../docs/handoff/M2_PROBE_RESULT.md) 并选定 F 方案。**已交付。**
2. M2-1 memory 模块 + 单测：解析、校验、预算、检索、追加写。**已交付**（`df586f9`）。
3. M2-2 checkout 模块 + 单测：clone/status/merge/remove 与错误映射。**已交付**（`c2b4531`）。
4. M2-3 注入模块 + 单测：agent 作用域 section、preset/项目根过滤、digest 缓存与 dispose。**已交付**（`086d60e`）。
5. M2-4 工具与装配：九个工具、`isolated` 创建、合并/清理、索引与状态机；真实宿主 E2E。**已交付**（`9db9cbe`、`5ace705`）。
6. M2-5 文档与证据：本记录迁入 implemented，P0 与 M2 结果入 docs，publish/glossary/PLAN/handoff 同步。**已交付。**
