# Proposal: M2 project memory and worktree isolation

Status: proposed
Date: 2026-11-05
Class: feature

## Problem

M1 只交付了主从闭环：项目索引、路由、handoff、六个工具、两个运行时 preset（[M1 结果](../../../../docs/M1_RESULT.md)）。它没有解决 PLAN M2 的两个问题：

1. **知识不沉淀。** 每个 thread 都从零开始。用户纠正过的约束、master 确认过的决策、项目事实（口径、精确数字、外部约定）只存在于某次对话里，新 thread 读不到；thread 之间也没有共享渠道。
2. **实现不隔离。** 所有 thread 共用同一个工作区。两个 thread 同时改代码会互相覆盖，master 也没有可审查的“一个 thread 的完整改动集”；合并动作没有边界，无法回答“这个 thread 到底改了什么、有没有污染主工作区”。

PLAN §5.5/§5.6 与 §6 M2 给了目标验收：`cowork_memory_write/search` 跨 thread 生效、新 thread 能读到项目约束、thread 落到 worktree、合并不污染主工作区、冲突保留 worktree 且索引状态正确。M1 留下的两个事实会约束 M2 的做法：会话 `create` 必须传 `workspaceId` 才挂 workspace（[M0 结果](../../../../docs/M0_PROBE_RESULT.md)）；preset 是运行时注册、重启即消失，M2 仍不改变这条。另外 M1 明确把 worktree 与 memory 排除在外，M2 不能让它们破坏已有 A1–A8 的行为。

## Proposal

M2 仍是 host-only：新增项目记忆与 git worktree 两个能力，扩充工具面到十个，不改 M1 的路由、handoff 与角色语义；客户端面板仍属 M3。

**模块边界**

- `src/memory.ts`：记忆文件的解析、校验、按预算拼注入块、关键词检索与追加写。纯逻辑尽量与文件 IO 分离，时钟与路径从参数注入。
- `src/worktree.ts`：`git` CLI 适配器：创建/查询/合并/清理 worktree，冲突与脏树映射为稳定错误码。所有 git 调用带 cwd、超时与参数数组，不拼 shell 字符串。
- `src/tools.ts`：新增四个工具；六个既有工具的行为不变。
- `src/presets.ts` / `src/index.ts`：若 P0 证明可按轮注入，则把记忆块接进 preset 的 system prompt；否则只接初始 brief + 检索工具（见“记忆注入策略”）。

**数据模型（v1 扩展，索引 version 仍为 1）**

- `<repo>/.dsh-cowork/memory/constraints.md`、`decisions.md`、`facts.md`。每条记忆一个二级标题 + 正文 + 来源行：

```markdown
## 提交信息使用中文

正文一句话说明约束或事实。

(来源: user / thread session-abc / src/file.ts:12; 2026-11-05T12:00:00Z)
```

- `cowork_memory_write({kind, title, text, source})`：`kind` 只接受 `constraint|decision|fact`；`title`/`text`/`source` 非空；单条 `text` 上限 8000 字符；以追加方式写对应文件，写入前校验整个文件可解析、写入用内存目录级锁 + 原子替换。不静默去重，重复写入由调用方负责。
- `cowork_memory_search({query, limit?})`：`limit` 默认 5、上限 20；用与 router 相同的 `tokenize`（ASCII 词 + CJK bigram）对 title+text 打分，按分数降序、再按来源时间降序；返回 `{kind, title, text, source, file, score}`。不做向量检索。
- 记忆注入预算：默认 3000 tokens，按 `ceil(chars/4)` 估算；按 constraints → decisions → facts 顺序拼接，超出即截断并在末尾标记 `[memory truncated]`。注入文本与检索结果都不含密钥（记忆写入前做基本长度/控制字符校验，不扫描内容语义）。
- worktree：`<repo>/.dsh-cowork/worktrees/<threadId>`（已在 `.gitignore` 内），分支 `cowork/<threadId>`；thread 记录的 `worktreePath` 是唯一事实源，创建/合并成功后才更新索引。
- 状态推进：`worktree_create` 成功后 thread 仍为 `active`；merge 成功把 `worktreePath` 置 null，状态不变（`done` 仍归 review/M3 或用户操作）；merge 冲突把状态置 `blocked` 并保留 worktree。
- 记忆与 worktree 都只写本仓库 `.dsh-cowork/`，不写 `~/.dsh`，不接 `viking://`，不上传。

**记忆注入策略（P0 先回答）**

PLAN §5.5 要求注入 master 与 thread 的 system prompt。当前宿主是否能做到“每轮按项目读文件并贡献 system prompt 段落”未验证，因此 M2 第一步是 P0 探针，回答：

1. preset 作用域里能否注册一个按 agent 项目根动态渲染的 prompt 段落（`ctx.systemPrompt.section` 的求值时机、`agent/pre-step` 之类钩子是否可用）；
2. 若不能，退化为：新建 thread 的初始 brief 注入记忆块 + 两个工具按需检索，并在文档写明“不是 system prompt 注入”；
3. 已在运行的 master/新写入的记忆如何让现有会话看到：P0 验证 `cowork_memory_search` 在任意会话可用即可，不承诺热更新 system prompt。

注入内容只含 constraints/decisions/facts 的标题+正文+来源，不注入 hid den 状态或交接单全文。

**worktree 生命周期（P0 先回答会话绑定）**

- `cowork_worktree_create({threadId, baseRef?})`（master only）：校验 thread 存在、`worktreePath` 为空、`git rev-parse --verify <baseRef>` 通过；执行 `git worktree add -b cowork/<threadId> <path> <baseRef|HEAD>`；成功后更新索引 `worktreePath`，失败不改索引、清理半成品目录。
- thread 如何“落到” worktree 是 P0 的第二问：会话 header 的 `cwd` 在创建时决定，M1 创建的 thread 已绑定仓库根。P0 要验证三条路径中哪条成立：(a) 先建 worktree，再用 `cwd: worktreePath` 创建 thread 会话并 `workspace.attachSession` 让它仍出现在 workspace/侧栏；(b) 无法改 cwd，则 thread 保持仓库 cwd、由 brief 与工具约定用 worktree 绝对路径工作（M0 已证明该路径可写），并在状态与文档写明“cwd 未切换”；(c) 其他宿主支持的重绑方式。实现只采用 P0 证明成立的那条，不假设。
- `cowork_worktree_merge({threadId, message?})`（master only）：前置条件 `worktreePath` 非空、worktree 存在、**工作树干净**（有未提交改动返回 `worktree/dirty`，不自动提交）、分支存在；在项目级 `.worktree.lock` 内串行执行 `git merge --no-ff cowork/<threadId> -m <message>`。成功：`git worktree remove`、`git branch -d`、索引 `worktreePath=null`；冲突：`git merge --abort`，保留 worktree 与分支、索引置 `blocked`、返回冲突文件列表；其他失败映射 `worktree/git-failed` 并保留现场。
- `cowork_project_status` 增加只读的 worktree 摘要（路径是否存在、是否 dirty、分支是否存在），供 master 判断；不自动修复。
- 不在 M2 做：自动合并到远端、自动解决冲突、把 worktree 删除当作清理用户数据（只删自己创建的路径）、跨仓库操作。

**工具面（M2 新增四个）**

| 工具 | 调用者 | 作用 |
|---|---|---|
| `cowork_memory_write` | master/thread | 追加一条带来源的项目记忆 |
| `cowork_memory_search` | master/thread | 关键词检索记忆并返回预算内片段 |
| `cowork_worktree_create` | master | 为 thread 建隔离 worktree 并写入索引 |
| `cowork_worktree_merge` | master | 串行合并 thread 分支；冲突保留现场并置 blocked |

统一输出 JSON；错误沿用 `{ok:false, error:{code, message, details?}}`。新增错误码：`memory/invalid`、`memory/write-failed`、`worktree/not-found`、`worktree/already-exists`、`worktree/create-failed`、`worktree/dirty`、`worktree/merge-conflict`、`worktree/git-failed`、`worktree/locked`。角色越权仍 `role/forbidden`；`exec.agent` 缺失仍 `exec/agent-unavailable`。

**不在 M2**

review 门禁与客户端面板（M3）、模型辅助记忆整理、向量检索、OpenViking 或其他外部记忆、跨项目记忆共享、worktree 的远端推送、自动冲突解决、修改 PLAN 范围。

## Alternatives considered

**只做 worktree，不做记忆。** 否决：PLAN §6 M2 与 §5.5 把两者放在同一里程碑；只有 worktree 会得到“隔离得很好但每个 thread 仍然重复踩坑”的系统，且记忆的验收（新 thread 读到约束）没有交付窗口。

**先做记忆，worktree 留到 M3。** 否决：worktree 决定 thread 的 cwd 与合并语义，会改动 M1 的 thread 创建与索引状态；越晚引入，返工越大。两者共用索引与工具装配，同一里程碑内先 P0 定契约更省成本。

**记忆用向量/模型检索。** 否决：PLAN §1.3 明确 MVP 不做向量检索；M2 的记忆量小，关键词 + 预算足以支撑，误召回由 `cowork_memory_search` 的返回与 master 判断兜底。

**记忆接入外部服务（OpenViking / dsh-project-memory）。** 否决：PLAN §8 要求默认只读自己的 `.dsh-cowork`，不接 OpenViking；M2 用文件 provider，适配器接口等有第二个消费者再抽象，避免过早造 seam。

**worktree 合并时自动提交 thread 的未提交改动。** 否决：自动提交会把“半成品/调试残留”固化成历史，且让 master 失去审查边界。改为脏树拒绝（`worktree/dirty`），由 thread 自己提交后再 merge。

**冲突时自动 rebase 或强制合并。** 否决：M1/M0 的纪律是不自动解决冲突；保留 worktree 现场、置 `blocked`、返回冲突文件，由人或原 thread 处理，重试才 merge。

**每个 thread 一律强制 worktree。** 否决：M2 是增量能力；只读/小改动 thread 不需要额外目录与 merge 成本。`cowork_worktree_create` 显式开启，M1 行为保持。

## Acceptance criteria

- [M2A1] `cowork_memory_write` 追加带来源的条目到对应 `memory/*.md`，`cowork_memory_search` 在另一个 thread 中能检索到同一内容；写入原子、目录锁、损坏文件返回带路径错误 — `source`
- [M2A2] 新建 thread 的初始 brief 含 constraints/decisions/facts 的预算内注入块（若 P0 支持动态注入则改为 system prompt），且 `cowork_memory_search` 对已有会话可用 — `source`
- [M2A3] `cowork_worktree_create` 在 `.dsh-cowork/worktrees/<threadId>` 建出分支 `cowork/<threadId>`，索引写入 `worktreePath`；失败不改索引、不留半成品 — `source`
- [M2A4] thread 在 worktree 中的改动经 `cowork_worktree_merge` 合入仓库分支后，主工作区没有该 thread 的未提交改动；merge 成功后 worktree 与分支被清理、索引 `worktreePath=null` — `source`
- [M2A5] 冲突场景：merge 返回冲突文件、保留 worktree 与分支、索引 `blocked`；人工解决后重试成功；脏 worktree 被 `worktree/dirty` 拒绝且不产生合并提交 — `source`
- [M2A6] `src/memory.ts` / `src/worktree.ts` 纯逻辑有单测：记忆解析/预算截断/评分、worktree 命令构造/错误映射/索引状态转换、损坏输入 — `tests`
- [M2A7] `npm run typecheck`、`npm run build`、`npm run check`、`npm test` 全绿；`package.json` 不新增第三方协作运行时或记忆依赖 — `packaging`
- [M2A8] M2 结果与限制写入 docs、`docs/publish.json` 分类、M2 交接文档更新，`npm run check` 通过 — `publication`

## Risks

- 会话 cwd 不能在创建后重绑（P0 未定）→ 退化为“thread 保持仓库 cwd、按绝对路径在 worktree 工作”；代价是隔离靠约定，文档与状态必须写明。重审条件：宿主提供 rebind 或 attachSession 方案。
- 记忆动态注入不可用（P0 未定）→ 只做 brief 注入 + 工具检索；新写入的记忆对运行中的会话不热更新。重审条件：宿主提供按轮 prompt 扩展点。
- git 合并与索引写入是两个资源（文件 + git），崩溃窗口可能让索引与磁盘不一致 → merge 先做 git 再写索引，`cowork_project_status` 只读报告存在的差异，不自动“修复”。重审条件：出现跨进程并发合并。
- 记忆增长无界 → 单条上限 + 注入预算 + 检索 limit；不做自动清理/压缩。重审条件：真实项目记忆超过预算。
- 中文关键词检索误召回 → 返回来源与文件路径，master/thread 自行判断；重审条件：出现系统性误召回。
- worktree 路径位于 `.dsh-cowork/worktrees/`，需要 `.gitignore` 持续忽略；`git worktree add` 失败可能留下空目录 → 创建失败时清理自己创建的路径。重审条件：宿主路径策略变化。

## Delivery stages

1. M2-P0 探针：回答会话 cwd/worktree 绑定、记忆注入时机、git worktree/merge 行为、跨会话记忆可见性；把结论写进提案与 M2 证据文档。
2. M2-1 memory 模块 + 单测：解析/校验/预算/检索/追加写。
3. M2-2 worktree 模块 + 单测：create/status/merge/cleanup 与错误映射。
4. M2-3 工具与装配：四个新工具、preset/ brief 注入、`cowork_project_status` 的 worktree 摘要；真实宿主 E2E。
5. M2-4 文档与证据：M2 结果、限制、未验证项；提案迁入 implemented。
