# M2 结果：项目记忆与 thread checkout

- 结论：M2 交付 PLAN §6 的两项能力——项目记忆跨 thread 生效并注入每个 cowork agent 的 system prompt；写代码的 thread 在独立本地 clone 中工作，master 独占合并，冲突保留现场并置 `blocked`。工具面从 6 个扩到 9 个，纯模块有单测，真实宿主 E2E 10/10 步通过。
- 依据：P0 探针结论见 [M2-P0 结果](M2_PROBE_RESULT.md)；F 方案（每 thread 本地 clone）经用户确认。
- E2E 证据容器：[`.dsh-cowork/e2e/M2_E2E.json`](../.dsh-cowork/e2e/M2_E2E.json)（gitignored），run `m2-2d375750-cb9d-470f-ac8a-7bd5de68c4d2`，`state: done`、`error: null`。
- 宿主：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2；插件 `@dsh-external/dsh-cowork` 以 `dev_inject_plugin` 注入。下文原始输出摘自证据文件的 `steps[].evidence`，只省略重复结构，字段值未改。

## 交付面

| 落点 | 职责 |
|---|---|
| [`src/memory.ts`](../src/memory.ts) | 记忆解析/校验/预算渲染/关键词检索/追加写；文件格式 `## 标题 + 正文 + (来源: …; ISO 时间)`；损坏文件带行号报错、不写入（`parseMemoryFile` :265、`validateMemoryEntry` :357、`renderMemoryBlock` :423、`searchMemory` :466、`appendMemoryEntry` :559）。 |
| [`src/checkout.ts`](../src/checkout.ts) | thread checkout 的 git 适配器：clone/checkout/inspect/merge/remove；路径守卫、分支名前缀 `cowork/`、30s 超时、参数数组（`CHECKOUT_ROOT_RELATIVE` :36、`CHECKOUT_BRANCH_PREFIX` :39、`createCheckout` :233、`mergeCheckout` :376、`removeCheckout` :523）。 |
| [`src/memory-prompt.ts`](../src/memory-prompt.ts) | 在 agent 作用域注册 `cowork:memory` system prompt 段落（order 900、`interpolate:false`、按轮求值、digest 缓存），跟踪 disposer（`registerMemoryPrompt` :86）。 |
| [`src/tool-model.ts`](../src/tool-model.ts) | 调用者身份、角色校验、错误包络、brief；M2 新增 13 个稳定错误码（:20-32）。 |
| [`src/tools.ts`](../src/tools.ts) | 9 个 `cowork_*` 工具，含 `isolated` 创建与 `cowork_checkout_merge`（:463/498/546/643/709/730/811/876/914）。 |
| [`src/store.ts`](../src/store.ts) | 索引唯一写者；M2 把 thread 字段 `worktreePath` 归一化为 `checkoutPath`（:194），记忆文件复用项目锁与原子写；新增 `findProjectRootSync`（:741）。 |
| [`src/session-slice.ts`](../src/session-slice.ts) | 显式 sessionId + clone workspace 建会话（:135）、删除 workspace、归档会话。 |
| [`src/index.ts`](../src/index.ts) | 装配记忆注入（:428-455）、注册工具与 9 个工具面。 |
| [`src/m2-e2e.ts`](../src/m2-e2e.ts) | 真实宿主 E2E 驱动：10 步、证据原子写 `M2_E2E_EVIDENCE_RELATIVE`（:31）、fixture 路径守卫（:1375）。 |

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
| `cowork_checkout_merge` | master | 合并 thread 分支并清理 clone/workspace/会话 |

`cowork_review_request` 仍未实现，属 M3。

### 记忆

- 文件：`<repo>/.dsh-cowork/memory/{constraints,decisions,facts}.md`；每条一个 `## ` 块，正文后接 `(来源: …; ISO 时间)`。
- 写入：目录锁 + 原子替换；写入前解析整个文件，损坏则返回带行号的错误、不改文件；单条正文上限 8000 字符，拒绝控制字符。
- 注入：`resolveProjectRoot(cwd)` 向上找到 `.dsh-cowork/index.json` 才注册；预算默认 3000 tokens（`ceil(chars/4)`），按 constraints → decisions → facts 整条拼接，超预算追加 `[memory truncated]`。
- 求值：段落 `text` 是函数，每次 assembly 重读三个文件；digest 不变时复用上次文本，变化时替换；缓存按 agent 隔离。因此写入后下一次 assembly 会读到新内容、无需重启会话（机制由 P0 seam 与单测证明；E2E 断言的是 thread 侧检索命中，没有从模型回复反证注入文本可见）。
- 失败隔离：同名 section 重复注册、project lookup 抛错都只记录并跳过该 agent，不影响其他 agent。

### thread checkout 与状态机

- 路径：`<repo>/.dsh-cowork/threads/<threadId>`；分支 `cowork/<threadId>`；thread 会话 cwd = clone 路径（独立 workspace，出现在侧栏）。索引字段 `checkoutPath` 是唯一事实源。
- 创建：`threadId → git clone --local → git checkout -b cowork/<threadId> → workspace → session({sessionId, workspaceId}) → 索引 → brief`；任一步失败补偿删除索引记录、clone、本次创建的 workspace。
- 合并前置：thread 存在、`checkoutPath` 非空、状态 ∈ `{awaiting_review, done}`、clone `git status --porcelain` 为空（含 untracked）。
- 合并：`fetch <clone> +refs/heads/cowork/<id>:refs/heads/cowork/<id>` → `merge --no-ff`；成功删 clone/分支/workspace、归档会话、索引 `checkoutPath=null` + `status=done`。
- 冲突：`merge --abort`、保留 clone 与分支、索引 `blocked`、返回冲突文件；thread 在 clone 内 fetch 主分支、解决并提交、重新 handoff 后可重试，重试成功走同一清理路径。
- 失败码：`checkout/not-found`、`already-exists`、`create-failed`、`invalid-base-ref`、`path-guard`、`dirty`、`merge-conflict`、`merge-failed`、`git-failed`、`not-ready`；角色越权仍 `role/forbidden`。

## E2E 证据摘要

run `m2-2d375750-cb9d-470f-ac8a-7bd5de68c4d2`：`setup → memory-write → isolated-thread → thread-work → memory-cross-thread → merge-success → conflict-thread → conflict-merge → conflict-retry → cleanup`，10/10 `passed`，`endedAt 2026-11-05T15:28:57.621Z`；最终索引两条 thread 均 `status: done`、`checkoutPath: null`。

关键原始输出（均摘自对应步骤的 `evidence`）：

1. 记忆落盘（`memory-write.observations.memoryText`）：

   ```text
   ## E2E 约束

   所有提交信息用中文

   (来源: e2e; 2026-11-05T15:27:15.004Z)
   ```

2. clone + workspace + 会话（`isolated-thread`）：`checkoutPath=<fixture>/.dsh-cowork/threads/session-66fdc1b7-…`，`sessionCwd` 等于 `checkoutPath`，`sessionPreset cowork-thread`，`git branch --show-current` 输出 `cowork/session-66fdc1b7-…`（exitCode 0）。

3. thread 自己提交（`thread-work`）：`bash` 结果 `[cowork/session-66fdc1b7-… ad71b3e] e2e thread work`；`gitLog` = `e2e thread work`；`gitStatus` = 空；索引 `awaiting_review`，handoff 已投递。

4. 记忆跨 thread 检索（`memory-cross-thread`，thread 会话内调用 `cowork_memory_search`）：

   ```json
   {"ok":true,"hits":[{"kind":"constraint","title":"E2E 约束","text":"所有提交信息用中文","source":"e2e","file":"constraints.md","score":6}],"issues":[],"total":1}
   ```

5. 合并与清理（`merge-success`）：`ok:true`、`commit 86c2650…`、`cleanup {removed:true, branchDeleted:true, workspaceDeleted:true, sessionArchived:true}`、`cleanupErrors:[]`；随后 `rev-parse --verify refs/heads/cowork/…` exitCode 128（分支已删），`e2e.txt` 已出现在 fixture 主工作区。

6. 冲突与重试（`conflict-merge` / `conflict-retry`）：第一次合并 `ok:false`、`code checkout/merge-conflict`、`conflictFiles ["conflict.txt"]`、索引 `blocked`、clone 保留、主仓 `git status --porcelain` 为空（已 abort）；thread 解决后重试 `ok:true`、`commit 84422ac…`、主仓 `conflict.txt` = `resolved`，最终 thread `done` / `checkoutPath=null`。

收口检查（本次文档提交前实跑）：`npm test` 145/145 通过；`npm run typecheck` exit 0；`npm run check` exit 0。`npm run build` 在 M2-9 集成验证与 M2-11 E2E 驱动验证中 exit 0，本次未重跑。E2E 的 fixture 目录与临时 workspace 已清理，运行后仓库工作树为空（`cleanup.tempRepoRemoved: true`、`errors: []`）。

## 限制 / 已知问题

- **合并 teardown 不是事务**（M2 审查 I1，medium）：`cowork_checkout_merge` 在 `git merge` 成功后依次执行 `resolveByPath`、`removeCheckout`、`deleteWorkspace`、`archiveSession`、`updateThread`，这串步骤没有整体 try/catch。任一步抛错会出现「git 已合并、工具报失败、索引未更新、清理不全」。影响：master 需要用 `cowork_project_status` 对照现场，必要时人工清理 clone/分支。后续：M3 修复，teardown 失败降级为 `cleanupErrors` 明细返回，不改变已发生的 merge 结果。
- **E2E 驱动超出单文件字号指引**（M2 审查 E2，low）：`src/m2-e2e.ts` 63 KB / 1573 行，超过仓库 50 KB 的单文件指引；内容是内嵌中文 prompt 的真实宿主证据设施，不是产品逻辑。未拆分是因为拆分后必须重跑 E2E 才能绑定新字节。后续：M3 若继续扩展该驱动，先拆分再改。
- 其余 low（不阻塞）：merge 失败后的 `merge --abort` 结果未检查；git stderr 进入错误 details 时未截断；`mkdirSync` 失败未映射为 `checkout/create-failed`；记忆来源时间只校验正则形态与 `Date.parse` 可读性，不校验时区顺序；`MemoryValidationIssue.field` 用一次 cast 承载 `'kind'`；`createCheckoutThread` 未对 sessionId 做 fail-closed 校验；merge teardown 中先 `resolveByPath` 再删 clone（为在 canonical 路径失效前匹配）与契约文字顺序相反，但结果等价。
- E2E 证据 JSON 含宿主 hostname（本机 gitignored 文件）：文档与提交不得复制该机器标识。
- clone 成本与依赖：`--local` clone 约 101 ms（P0 实测），只含已提交文件；thread 需要 `node_modules` 时得在 clone 内自行安装，master 审查要在主仓库看 fetch 后的分支。
- 隔离的边界：thread 不能读主仓库工作区（沙箱根 = clone）；它仍能通过自己的 clone 提交任意改动，master 合并前应审查。
- preset 仍是运行时注册，重启消失（M4 解决）；记忆 section 随 agent 存活，插件卸载时由 `registerMemoryPrompt` 的 dispose 释放，热重载期间同一 agent 若已有同名 section 会被计数跳过并 warn。
- 冲突不自动解决：冲突交给 thread（在 clone 内 merge 主分支并解决）或人工；master 只重试合并。
- 记忆注入的模型可见性没有从模型回复反证：证据是 P0 的 assembly seam、注入模块单测与 E2E 的检索命中；若要断言“模型确实读到了记忆块”，需在 E2E 中新增一步让模型复述约束（M3 可做）。
- 记忆只追加，不去重、不删除、不压缩；检索是关键词（ASCII 词 + CJK bigram），无向量。
- 所有结论以 workspace-write 策略为前提；`danger-full-access` 下 worktree 也许可用，但 F 是选定方案，不依赖全权限。

## 回滚

- 代码：按提交 revert——`5ace705`（E2E 驱动）、`9db9cbe`（工具与装配）、`2a4bdc0`（模块集成分支）；模块提交可单独 revert `086d60e`（memory-prompt）、`df586f9`（memory）、`c2b4531`（checkout）。
- 文档：回退本次文档提交即恢复提案与旧索引；`docs/publish.json`、`docs/README.md`、`README.md` 的改动在同一提交内成对回退。
- 运行时：`dev_uninject_plugin dsh-cowork` 移除注入；已存在的 `cowork:memory` section 由 dispose 释放（不重启时也生效）。
- 数据：`.dsh-cowork/` 是项目数据（`memory/`、`threads/`、`handoffs/`、`e2e/`），除非确认不要，不要删除；clone 目录只删自己创建且已合并的 `<threadId>` 路径。
