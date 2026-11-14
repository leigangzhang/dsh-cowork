# M2 结果：项目记忆与 thread checkout

- 结论：M2 交付 PLAN §6 的两项能力——项目记忆跨 thread 生效并注入每个 cowork agent 的 system prompt；写代码的 thread 在独立本地 clone 中工作，master 独占合并，冲突保留现场并置 `blocked`。工具面从 6 个扩到 9 个；真实宿主 E2E 在最终字节上 11/11 步通过，其中 `memory-visible` 用不可猜 nonce 证明约束确实进入模型可见的 system prompt。
- 依据：P0 探针结论见 [M2-P0 结果](M2_PROBE_RESULT.md)；F 方案（每 thread 本地 clone）经用户确认；收口修复的决策与 F1–F8 证据归 [implemented bug-fix note](../../.agents/notes/implemented/bug-fix/2026-11-05-m2-follow-up-fixes.md)。
- E2E 证据容器：本地 gitignored 文件 `.dsh-cowork/e2e/M2_E2E.json`，run `m2-a91984c0-4840-4bc0-bcd1-74fe22d0e679`，`state: done`、无 `error` 字段、11/11 步 `passed`。
- 宿主：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2；插件 `@dsh-external/dsh-cowork` 以 `dev_inject_plugin` 注入。下文原始输出摘自证据文件的 `steps[].evidence`，只省略重复结构，字段值未改。

## 交付面

| 落点 | 职责 |
|---|---|
| [`src/memory.ts`](../../src/domains/memory/memory.ts) | 记忆解析/校验/预算渲染/关键词检索/追加写；文件格式 `## 标题 + 正文 + (来源: …; ISO 时间)`；损坏文件带行号报错、不写入（`parseMemoryFile`、`validateMemoryEntry`、`renderMemoryBlock`、`searchMemory`、`appendMemoryEntry`）。时间策略与可注入时钟见模块注释与单测。 |
| [`src/checkout.ts`](../../src/domains/isolation/checkout.ts) | thread checkout 的 git 适配器：clone/checkout/inspect/merge/remove；路径守卫、分支前缀 `cowork/`、30s 超时、参数数组。失败路径检查 `merge --abort` 退出码，`details.stderr` 统一截断并标记。 |
| [`src/checkout-teardown.ts`](../../src/domains/isolation/checkout-teardown.ts) | merge 成功后的 teardown 编排：workspace resolve、clone 删除、workspace 删除、会话归档、索引更新各自独立捕获；索引更新最后且无条件执行。 |
| [`src/memory-prompt.ts`](../../src/platform/memory-prompt.ts) | 在 agent 作用域注册 `cowork:memory` system prompt 段落（order 900、`interpolate:false`、按轮求值、digest 缓存）；null 渲染清空缓存，duplicate 计数按唯一 agent。 |
| [`src/tool-model.ts`](../../src/platform/tool-model.ts) | 调用者身份、角色校验、错误包络、brief；M2 新增 13 个稳定错误码。 |
| [`src/tools.ts`](../../src/tools.ts) | 9 个 `cowork_*` 工具，含 `isolated` 创建与 `cowork_checkout_merge`；冲突状态更新错误进入 `statusUpdateError`。 |
| [`src/store.ts`](../../src/store/project-store.ts) | 索引唯一写者；`checkoutPath` 是 checkout 唯一事实源，旧索引 `worktreePath` 读兼容；记忆文件复用项目锁与原子写。 |
| [`src/session-slice.ts`](../../src/platform/session-slice.ts) | 显式 sessionId + clone workspace 建会话；宿主返回不同 sessionId 时 fail-closed；删除 workspace、归档会话。 |
| [`src/index.ts`](../../src/index.ts) | 装配记忆注入、注册工具与 9 个工具面。 |
| `src/m2-e2e.ts` / `src/m2-e2e-support.ts` | 真实宿主 E2E 驱动：11 步、证据原子写 `.dsh-cowork/e2e/M2_E2E.json`；两个文件均 ≤50 KB，证据 host 块不含 hostname。 |

### 工具面

| 工具 | 调用者 | 说明 |
|---|---|---|
| `cowork_project_init` | master | 初始化项目索引（M1 不变） |
| `cowork_project_status` | master/thread | 概览；M2 增加每 thread 的 checkout 摘要（存在/脏/分支/HEAD） |
| `cowork_route` | master | 路由；`isolated: true` 时走 clone 创建 |
| `cowork_thread_create` | master | 显式建 thread；`isolated: true` 时先 clone 再建会话 |
| `cowork_thread_list` | master/thread | 列出 thread（M1 不变） |
| `cowork_handoff` | thread | 结构化汇报（M1 不变） |
| `cowork_memory_write` | master/thread | 追加一条带来源的记忆 |
| `cowork_memory_search` | master/thread | 关键词检索，limit 默认 5、上限 20 |
| `cowork_checkout_merge` | master | 合并 thread 分支并清理 clone/workspace/会话；teardown 失败只进 `cleanupErrors` |

`cowork_review_request` 仍未实现，属 M3。

### 记忆

- 文件：`<repo>/.dsh-cowork/memory/{constraints,decisions,facts}.md`；每条一个 `## ` 块，正文后接 `(来源: …; ISO 时间)`。
- 写入：目录锁 + 原子替换；写入前解析整个文件，损坏则返回带行号的错误、不改文件；单条正文上限 8000 字符，拒绝控制字符。
- 注入：`resolveProjectRoot(cwd)` 向上找到 `.dsh-cowork/index.json` 才注册；预算默认 3000 tokens（`ceil(chars/4)`），按 constraints → decisions → facts 整条拼接，超预算追加 `[memory truncated]`。
- 求值：段落 `text` 是函数，每次 assembly 重读三个文件；digest 不变时复用上次文本，变化时替换；缓存按 agent 隔离。写入后下一次 assembly 会读到新内容、无需重启会话；`renderMemory` 返回 null 时缓存被清空。
- 模型可见性：E2E `memory-visible` 让 thread 在不调用工具的情况下复述 master 写入的约束。约束带固定 nonce `M2-E2E-CONSTRAINT-7F3A`，prompt 不包含该值；实测回复含该文本且 `toolCalls=0`。
- 失败隔离：同名 section 重复注册、project lookup 抛错都只记录并跳过该 agent，不影响其他 agent。

### thread checkout 与状态机

- 路径：`<repo>/.dsh-cowork/threads/<threadId>`；分支 `cowork/<threadId>`；thread 会话 cwd = clone 路径（独立 workspace，出现在侧栏）。索引字段 `checkoutPath` 是唯一事实源。
- 创建：`threadId → git clone --local → git checkout -b cowork/<threadId> → workspace → session({sessionId, workspaceId}) → 索引 → brief`；宿主返回的 sessionId 与请求不一致时在 rename/索引前失败，工具层补偿删除 clone 与本次 workspace。
- 合并前置：thread 存在、`checkoutPath` 非空、状态 ∈ `{awaiting_review, done}`、clone `git status --porcelain` 为空（含 untracked）。
- 合并：`fetch <clone> +refs/heads/cowork/<id>:refs/heads/cowork/<id>` → `merge --no-ff`；成功后按序 `resolveByPath` → `removeCheckout` → `deleteWorkspace` → `archiveSession` → 索引 `checkoutPath=null` + `status=done`。teardown 任一步抛错仍返回 `ok:true`，错误进入 `cleanupErrors`，索引更新仍执行。
- 冲突：`merge --abort` 检查退出码；abort 成功时保留 clone 与分支、索引 `blocked`、返回冲突文件。`updateThread` 失败不吞错，在冲突响应中返回 `statusUpdateError`。thread 在 clone 内解决并重新 handoff 后可重试。
- `git merge --abort` 失败返回 `checkout/git-failed`，`details` 标明 abort/merge 阶段，不把半完成清理伪装成成功。
- 失败码：`checkout/not-found`、`already-exists`、`create-failed`、`invalid-base-ref`、`path-guard`、`dirty`、`merge-conflict`、`merge-failed`、`git-failed`、`not-ready`；角色越权仍 `role/forbidden`。

## E2E 证据摘要

run `m2-a91984c0-4840-4bc0-bcd1-74fe22d0e679`：`setup → memory-write → isolated-thread → thread-work → memory-visible → memory-cross-thread → merge-success → conflict-thread → conflict-merge → conflict-retry → cleanup`，11/11 `passed`，`endedAt 2026-11-06T01:23:58.020Z`；最终索引两条 thread 均 `status: done`、`checkoutPath: null`，fixture 已清理。

关键原始输出（均摘自对应步骤的 `evidence`）：

1. 模型看到约束（`memory-visible.prompts[0]`）：

   ```text
   prompt: Do not call any tool. The project memory is already rendered in your system prompt.
           Find the constraint titled "E2E 约束" there and reply with its text verbatim...
   assistantText includes:
     ### constraints
     ## E2E 约束
     M2-E2E-CONSTRAINT-7F3A: 所有提交信息用中文
     (来源: e2e; 2026-11-06T01:22:09.489Z)
   toolCalls: 0
   assertions: 3/3 passed
   ```

2. 记忆跨 thread 检索（`memory-cross-thread`）：thread 调用 `cowork_memory_search`，命中 `{"kind":"constraint","title":"E2E 约束","text":"M2-E2E-CONSTRAINT-7F3A: 所有提交信息用中文","source":"e2e","file":"constraints.md","score":6}`。

3. clone + workspace + 会话（`isolated-thread`）：`checkoutPath` 存在、`sessionCwd` 等于 `checkoutPath`、`sessionPreset cowork-thread`、`git branch --show-current` 输出 `cowork/<threadId>`。

4. 合并与清理（`merge-success`）：`ok:true`、`commit 719e5e9…`、`cleanup {removed:true, branchDeleted:true, workspaceDeleted:true, sessionArchived:true}`、`cleanupErrors:[]`；随后分支不存在（`rev-parse` exitCode 128），`e2e.txt` 已出现在 fixture 主工作区。

5. 冲突与重试（`conflict-merge` / `conflict-retry`）：第一次 `ok:false`、`code checkout/merge-conflict`、`conflictFiles ["conflict.txt"]`、索引 `blocked`、clone 保留、主仓无 `MERGE_HEAD`；thread 解决后重试 `ok:true`、`commit d12ae7b…`、主仓 `conflict.txt = resolved`，最终 thread `done` / `checkoutPath=null`。

6. 清理（`cleanup`）：`tempRepoRemoved: true`、`errors: []`、归档失败列表为空；主仓库工作树只剩本任务源码与文档改动。

收口检查（最终字节实跑）：`npm test` 227/227 通过；`npm run typecheck` exit 0；`npm run build` exit 0；`npm run check` exit 0。构建后 `/dsh-cowork/probe/health` 返回 200。

## 限制 / 已知问题

**设计限制（不修，归 [KNOWN_ISSUES](../KNOWN_ISSUES.md)）**：clone 成本与 thread 读不到主仓库、merge 冲突必须人工或 thread 解决、记忆只追加且关键词检索、preset 运行时注册、全部结论以 workspace-write 为策略前提。逐条影响与重估条件只写在 KNOWN_ISSUES，本文不复制。

**M2 收口修复（已交付，归[implemented bug-fix note](../../.agents/notes/implemented/bug-fix/2026-11-05-m2-follow-up-fixes.md)）**：合并 teardown 失败隔离、冲突 updateThread 错误可见、sessionId fail-closed、memory/checkout/memory-prompt 边界修复、E2E 驱动拆分与 hostname 去除，以及模型可见性证据补强均已落地；F1–F8 的详细证据在该 note，本文不复制。

**证据设施现状**：证据文件 `.dsh-cowork/e2e/M2_E2E.json` 是本地 gitignored 数据；host 块已无 hostname，但按本地可追溯性保留 `repoPath` 与 fixture 绝对路径，不提交、不发布。真实 Chrome 的宿主 GUI 截图保存在 `.dsh-cowork/e2e/browser/`（同样 gitignored）。

## 回滚

- 代码：按提交 revert 本轮收口 merge commits 与文档提交；已交付的 M2 提交不动。
- 运行时：`dev_uninject_plugin dsh-cowork` 移除注入；`cowork:memory` section 由 dispose 释放。
- 数据：`.dsh-cowork/` 是项目数据（`memory/`、`threads/`、`handoffs/`、`e2e/`），除非确认不要，不要删除；clone 目录只删自己创建且已合并的 `<threadId>` 路径。
