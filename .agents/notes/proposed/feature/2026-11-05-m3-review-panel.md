# Proposal: M3 独立 review 门禁与面板 review 呈现

Status: proposed
Date: 2026-11-05
Class: feature

## Problem

M2 交付了项目记忆、thread 隔离 clone 与结构化 handoff，但「谁验收 thread」仍是 master 自己：master 收到 handoff 后直接合并，没有独立 review 会话、没有可审计的 verdict 文件、没有 `needs_revision` 退回路径。PLAN §5.7 要求「reviewer 读 handoff 与真实文件、运行验证命令、产出 verdict；实现者不得自审」，PLAN §6 M3 要求独立 review 会话、`needs_revision` 退回原 thread、侧栏项目 → thread 树与状态徽章——这三项当前都不存在。

M3 开始前的事实与提案初稿编写时不同，初稿里的「待 M2 修复后定」已经可以定稿：

- **代码基线是 `main`。** M2 收口的 `fix/m2-closeout`（`d774fde`）已合并进 `main`（合并提交 `90f41cd`，树与 `d774fde` 相同，`git diff d774fde origin/main` 为空）；M3 从 `main` 开 `feat/m3-review-panel`，不再依赖审阅分支。
- **客户端能力探针已经做过。** 面板提案已交付：client bundle、右侧栏 tab、14 个公开 token、`/api/cowork.overview` 与 `/api/cowork.handoff` 都在真实宿主验证过（[PANEL_RESULT](../../../../docs/PANEL_RESULT.md)）。M3 的未知项不再是「client 能不能挂载」，而是「review 会话能不能闭环」与「review 字段能不能按既有 wire 契约只增不改地返回」。
- **工具面是 9 个**（M1 六个 + `cowork_memory_write` / `cowork_memory_search` / `cowork_checkout_merge`）；合并前置仍是 `awaiting_review | done` 且没有 review 字段。M2 的合并 teardown 已改为「merge 落地后各步独立捕获，索引最后无条件写」。
- **索引已存在旧字段 `worktreePath`。** store 读时归一化为 `checkoutPath`；本仓库真实索引就是旧形状。新的 review 字段必须按同样方式向后兼容，缺字段的旧索引要能读。

## Proposal

**基线与分支**

- 从 `main`（`90f41cd`，已合并 `fix/m2-closeout`）开 `feat/m3-review-panel`；不改写 `main`，不 force push。
- 客户端能力探针不重复；M3 的 P0 只验证两件事并写入 `docs/M3_PROBE_RESULT.md`：①`sessionController.create({workspaceId, agentPreset:'cowork-reviewer'})` 能建出可唤醒的 review 会话并写回 verdict；②`/api/cowork.overview` / `/api/cowork.handoff` 在旧索引上返回新增 review 字段、缺字段时取 `null`。

**review 门禁（host）**

- 新增 `cowork_review_request(threadId)`：master 或本项目的 thread 可调用。要求 thread 状态为 `awaiting_review`；同一 thread 已 `pending` 时拒绝并返回现有 `reviewerSessionId`。
  - 用 `sessionController.create({ workspaceId: resolveWorkspaceId(repoPath), agentPreset: 'cowork-reviewer' })` 建普通会话，cwd 是**项目主仓库**（不是 clone；reviewer 需要主仓库上下文），标题 `cowork review: <subject>`；宿主返回的 `agentPreset` 不符时 fail-closed，不写索引。
  - 先写索引 `reviewStatus='pending'`、`reviewRequestedAt`、`reviewerSessionId`，再投递首条 review prompt；投递失败则清回这三个字段并尝试归档该会话，返回 `review/prompt-failed`。
  - review prompt 自包含：项目路径、thread id/subject、handoff 文件绝对路径、`changedPaths`、handoff 的 verification 行、隔离 thread 的 `checkoutPath` 与分支 `cowork/<threadId>`；说明「隔离 thread 的改动在 clone 的分支上，用 `git -C <checkoutPath> diff <base>...HEAD` 看差异；非隔离 thread 直接看主仓库工作区」；要求 reviewer 实际运行验证命令，并且只调用一次 `cowork_review_verdict`。
- 新增 `cowork_review_verdict(threadId, verdict, summary, findings?, verification?)`：**仅该 thread 的 review 会话可调用**。
  - 角色门：`caller.sessionId !== thread.reviewerSessionId` 时返回 `review/not-reviewer`；若 caller 是 master 或 thread（实现者/受理方），即使 id 恰好相等也返回 `review/self-review`（拒绝自审的显式代码路径）。
  - `verdict` ∈ `pass | needs_revision | reject`；`summary` 必填；`needs_revision` / `reject` 至少一条 finding（id/severity/problem/requiredFix，可带 file/line），`pass` 可带 finding。
  - 写 `<repo>/.dsh-cowork/reviews/<threadId>-<stamp>.json`（version 1，排他创建 + 项目锁 + 原子替换），字段：`threadId`、`reviewerSessionId`、`verdict`、`summary`、`findings`、`verification`、`createdAt`。文件是 verdict 的唯一事实源，先写文件再写索引。
  - 索引追加可空字段：`reviewStatus`（`pending|pass|needs_revision|reject|null`）、`reviewRequestedAt`、`reviewedAt`、`reviewerSessionId`、`latestReviewPath`；`version` 仍为 1，旧索引缺这些字段时归一化为 `null`。
  - 状态路由：`pass` → thread `done`；`needs_revision` → `active` 并把 findings 作为 prompt 投给原 thread（投递失败进 `deliveryError`，不回滚 verdict）；`reject` → `blocked` 并同样投递 findings。投递是异步的：工具返回的 `delivered` 表示 host 接受了 queue。
- **合并门禁**：`cowork_checkout_merge` 默认要求 `reviewStatus === 'pass'`，否则返回 `review/not-passed` 并附当前状态与 review 文件路径。保留显式覆盖：`allowUnreviewed: true` + 非空 `overrideReason`，覆盖时在合并提交信息后追加 `(unreviewed: <reason>)`，并在响应里返回 `reviewOverride`；只给 `allowUnreviewed` 不给理由返回 `review/override-reason-required`。覆盖不走索引新字段，git 提交信息就是审计痕迹。
- `cowork_project_status` 的每 thread 视图追加 `reviewStatus` / `reviewedAt` / `reviewerSessionId` / `latestReviewPath`，并附 `latestReviews`（每 thread 最新 verdict 的 `verdict` / `summary` / `reviewedAt` / `filePath`）；`cowork_thread_list` 同步 thread 视图。
- `cowork-reviewer` preset（运行时注册，与两个既有 preset 同一路径）：persona 要求独立、只读证据、不改实现文件；**不挂 `tool-fs`**（因此没有 `read`/`write`/`edit`），只挂 `tool-bash`、`tool-fs-search`（`glob`/`grep`）、`persona`、`agent-instructions`。cowork 工具是全局注册的，verdict 的权限由上面的角色门保证，不靠 preset 隐藏。reviewer 读文件走 bash，这是**工具面硬限制 + bash 内 protocol 约束**，不是只读沙箱；该限制写进结果文档与 `KNOWN_ISSUES`。
- 工具计数从 9 变为 11（PLAN §5.8 同步）。

**面板（客户端，v0 仍只读）**

- `/api/cowork.overview` 的 thread 行追加 `reviewStatus`、`reviewedAt`、`reviewerSessionId`；既有字段语义不变，缺字段取 `null`，未知字段忽略。
- `/api/cowork.handoff` 追加 `review: {record, filePath} | null`（该 thread 最新一条 verdict 原文 + 绝对路径）；没有 review 时为 `null`，不是错误。
- 列表行在状态点旁追加 review 徽章：审查中 / 审查通过 / 需修改 / 已拒绝；与 thread 状态并排，不只靠颜色。
- 详情追加「审查」区：verdict、reviewedAt、reviewer 短 id、summary、findings（severity / problem / requiredFix / file:line）、reviewer 的 verification 行、review 文件绝对路径；`reviewerSessionId` 存在时给「打开 review 会话」按钮（复用 `uiWorkspace.openSession`），缺失时禁用并给提示。
- 保持只读：不在面板发起 review、不写 verdict。七种既有面板状态与两档宽度（>480 分栏 / ≤480 钻取）不改变；review 徽章在两种宽度都要可读。

**E2E 与证据**

- 新增 `src/m3-e2e.ts`（复用 `m2-e2e-support.ts` 的 host 端口、事件缓冲、轮询与证据工具）与 `/dsh-cowork/e2e/m3/run`、`/dsh-cowork/e2e/m3/status` 两条 loopback 路由；证据原子写 `.dsh-cowork/e2e/M3_E2E.json`。
- 步骤：临时 fixture 仓库初始化 → master 会话 → 隔离 thread A → A handoff → master 调 `cowork_review_request` → review 会话说 verdict `pass` → A 变 `done` → master 合并成功；再建隔离 thread B → handoff → review request → verdict `needs_revision`（含 finding）→ B 变 `active` 且收到 findings → B 修复并重新 handoff → 第二次 review request → verdict `pass` → B 合并成功。
- verdict 的**内容**由 E2E 驱动在 review 会话上追加一条确定性指令（“本轮 fixture 期望 needs_revision/pass”），verdict 的**写入通道**仍必须是 review 会话经 `cowork_review_verdict`；驱动不直接改索引，也不代写 verdict 文件。证据记录这一点，禁止拿模型散文当断言。
- 断言源只取持久状态：索引快照、review 文件、git 提交、主仓库文件、会话 id、verdict 路径；每条证据含 sessionId 与时间线。
- 面板截图用真实 Chrome（browser-skill）：一个含 pass / needs_revision / pending / reject 的只读 fixture 项目，分别在分栏与 ≤480 钻取两档宽度截图，核对徽章、findings、打开 review 会话按钮；截图落 `.dsh-cowork/e2e/panel-m3/`（gitignored）。

**文档**

- 新增 `docs/M3_PROBE_RESULT.md`、`docs/M3_RESULT.md`；更新 `docs/M3_HANDOFF.md`（收口状态与实测路径）、`docs/PANEL_RESULT.md`（review 呈现与未验证项）、`docs/KNOWN_ISSUES.md`（reviewer bash 写路径、merge 覆盖、review 会话运行时 preset 等）；`docs/PLAN.md` §5.7/§5.8 与工具计数同步；`docs/publish.json` 为新文档分类。
- 同一交付把本提案迁入 `.agents/notes/implemented/feature/` 并改写为现在时（`## Decision` / `## Consequences` / `## Testing`）。

## Alternatives considered

**合并前只允许 review pass、不允许覆盖。** 丢失的是可操作性：review 会话超时、模型误判或用户明确要合并时没有出口，只能手改索引。用户选定「默认必须 pass + 显式覆盖」；覆盖必须带理由并写进合并提交，审计上不弱于强制路径。

**M3 不收紧合并（review 只做呈现）。** 满足不了「实现者不得自审」的验收意图：独立 verdict 会变成没人看的旁证。用户明确要求保留独立 review 的阻断能力，故仅保留为被否决的历史选项。

**reviewer 也挂完整 `tool-fs`，只靠 persona 不改文件。** 现有 `dsh-tool-fs` 把 `read`/`write`/`edit` 打包成一个插件行，无法只启用读；给了它等于把写工具直接放在 reviewer 手里。改为不挂 `tool-fs`、用 bash 读，工具面上直接没有写文件工具，代价是 bash 仍能写（见 Risks）。

**新建一个只读 fs 工具包给 reviewer。** 隔离最硬，但在 M3 新增一套工具装配路径与另一处类型面；与「借语义、不扩运行时」的纪律相比收益不足，留作后续若要真正 sandbox review 时评估。

**把 reviewer 的 cwd 设成 thread 的 clone。** 否决：reviewer 需要主仓库与合并目标的真实上下文；clone 也不含 `.dsh-cowork` 与本地依赖。改为 cwd = 主仓库，prompt 给出 clone 路径与分支差异命令。

**把 review 数据放进 handoff 文件。** 否决：handoff 是 thread 的单向汇报，verdict 是另一方的独立证据；写进同一文件会让「谁写的」不可区分，也无法保留多轮 review 历史。独立 `reviews/` 目录 + 索引指针。

**面板新增第三条 review 路由。** 否决：M3 的只读契约已经有两处入口，把最新 verdict 挂在 handoff 响应上、状态挂在 overview 行上即可；新增路由只会扩大 wire 面积。

## Acceptance criteria

- [M3A1] `cowork_review_request` 只为 `awaiting_review` 的 thread 建独立 review 会话；review prompt 含 handoff 路径、changedPaths、verification、checkoutPath/分支；索引先写 `pending` + `reviewerSessionId` — `source`、`tests`
- [M3A2] `cowork_review_verdict` 只接受该 thread 的 review 会话；master/thread 自审被显式拒绝；verdict 文件先于索引写入且排他创建 — `source`、`tests`
- [M3A3] verdict 路由：pass → `done`；needs_revision → `active` 并把 findings 投递给原 thread；reject → `blocked` 且同样投递；投递失败只进 `deliveryError` — `source`、`tests`
- [M3A4] `cowork_checkout_merge` 默认要求 `reviewStatus === 'pass'`；`allowUnreviewed + overrideReason` 可覆盖，理由进合并提交信息；缺理由被拒 — `source`、`tests`
- [M3A5] `cowork-reviewer` preset 可创建、真实宿主能唤醒；它不挂 `tool-fs`（无 read/write/edit 工具），能通过 bash 读文件并运行验证命令 — `source`、`packaging`
- [M3A6] `/api/cowork.overview` 与 `/api/cowork.handoff` 追加 review 字段且缺字段取 `null`；旧索引仍可读；面板展示 review 徽章、findings、review 文件路径与打开 review 会话 — `source`、`tests`
- [M3A7] 真实宿主 E2E 覆盖 pass → 合并、needs_revision → 修复 → 复审 pass → 合并；证据含 review 会话 id、verdict 文件、索引快照、合并提交 — `tests`
- [M3A8] 面板 review 状态在分栏与 ≤480 两档宽度用真实 Chrome 截图可复现；未验证项如实记录 — `source`、`publication`
- [M3A9] 文档与发布：M3 探针/结果、面板结果与限制、PLAN 与 KNOWN_ISSUES 同步，提案迁入 `implemented/`，`docs/publish.json` 分类，`npm run check` 通过 — `publication`

## Risks

- **reviewer 仍可用 bash 写文件。** 工具面已经没有 write/edit，但 bash 能 `echo >`；M3 用 protocol + 结果文档约束，不宣称只读沙箱。重审条件：需要把 review 变成可证明的只读执行时，引入只读 fs 工具包或沙箱评审环境。
- **review 会话是真实模型回合。** 超时、模型不调用 verdict 或误判都会让 thread 停在 `pending`；M3 不自动重试、不静默放行，`cowork_project_status` 与面板会一直显示 pending，master 可用 `cowork_review_request` 的拒绝信息定位。重审条件：观测到 pending 卡死成为常态。
- **merge 覆盖可能被误用。** 默认 pass 的门被理由覆盖绕过；覆盖写进合并提交信息是审计下限，不是审批流。M3 不做用户二次确认；重审条件：出现绕过 review 的合并造成返工。
- **索引继续只增字段。** `reviewStatus` 等字段必须对旧索引容错，否则 M2 项目加载即损坏；回归用「旧 `worktreePath` 索引 + 缺 review 字段」的单测钉住。
- **运行时 preset 重启消失（KI-3）。** reviewer preset 与 master/thread 一样是运行时注册；M3 E2E 不承诺跨重启，重启后旧 review 会话仍可读 verdict 文件，但新 review 需要重载插件。
- **M2 E2E 车道受合并门禁影响。** M2 驱动会在合并步骤改用 `allowUnreviewed + overrideReason`，保持旧证据路径可复现；M3 结果必须写明这是刻意覆盖，不是 M3 的 review 路径。
- **并发写者。** 索引、面板契约、文档都可能与另一个会话并行改；分支从 `main` 固定，动手前 `git fetch`，worktree 隔离，索引只增字段、不重排。

## Delivery stages

1. P0 探针：review 会话创建/唤醒/verdict 写回；旧索引上的 review 字段 wire 往返。结论写 `docs/M3_PROBE_RESULT.md`。
2. P1 host：store review 存储与索引字段、`src/review.ts` 纯模型、两个工具、角色门与状态路由、reviewer preset、merge 门禁与覆盖、M2 E2E 覆盖参数 + 单测。
3. P2 面板：overview/handoff review 字段、徽章与详情审查区、打开 review 会话 + 契约/模型测试。
4. P3 E2E 与真机：M3 驱动、真实宿主两轮 review、真实 Chrome 两档截图。
5. P4 文档：M3 结果与限制、PLAN/KNOWN_ISSUES/PANEL_RESULT 同步、提案迁入 `implemented/`、publish 分类、交接更新。
