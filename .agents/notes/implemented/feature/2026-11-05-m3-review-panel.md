# Decision: M3 独立 review 门禁与面板 review 呈现

Status: implemented
Date: 2026-11-05
Class: feature

## Problem

M2 交付了项目记忆、thread 隔离 clone 与结构化 handoff，但「谁验收 thread」仍是 master 自己：master 收到 handoff 后直接合并，没有独立 review 会话、没有可审计的 verdict 文件、没有 `needs_revision` 退回路径。PLAN §5.7 要求 reviewer 独立于实现者、读 handoff 与真实文件、运行验证命令并产出 verdict；PLAN §6 M3 要求独立 review 会话、`needs_revision` 退回、侧栏项目 → thread 视图与状态徽章。与此同时，面板已交付但完全看不到 review 状态，用户无法判断一个 thread 是被谁、以什么证据验收的。

## Decision

**review 门禁（host）**

- `cowork_review_request(threadId)`：master 或本项目 thread 调用；thread 必须 `awaiting_review`，重复 `pending` 被拒绝。创建独立 `cowork-reviewer` 会话（cwd 是主仓库，preset 校验 fail-closed，标题 `cowork review: <subject>`）；索引先写 `reviewStatus='pending'`、`reviewRequestedAt`、`reviewerSessionId`，再投 review brief；prompt 失败回滚这三个字段并归档会话。brief 含 handoff 文件、`changedPaths`、verification、隔离 thread 的 `checkoutPath` 与分支。
- `cowork_review_verdict(threadId, verdict, summary, findings?, verification?)`：只接受该 thread 索引里的 `reviewerSessionId`；master 与 thread（实现者/受理方）调用显式返回 `review/self-review`；`needs_revision`/`reject` 至少一条 finding。review 文件 `<repo>/.dsh-cowork/reviews/<threadId>-<stamp>.json`（version 1，排他创建 + 项目锁 + 原子替换）先写，再写索引 `reviewStatus` / `reviewedAt` / `latestReviewPath`。
- 状态路由：`pass → done`；`needs_revision → active` 并把 findings 作为 prompt 投给原 thread；`reject → blocked` 并同样投递；投递失败只进 `deliveryError`，不回滚 verdict。
- 合并门禁：`cowork_checkout_merge` 默认要求 `reviewStatus === 'pass'`；master 用 `allowUnreviewed:true` + 非空 `overrideReason` 显式覆盖，理由清洗后追加进合并提交信息并回显。M2 的 merge teardown 语义（merge 落地后各步独立捕获、索引最后无条件写）不变。
- 索引只增可空字段：`reviewStatus` / `reviewRequestedAt` / `reviewedAt` / `reviewerSessionId` / `latestReviewPath`；旧 `worktreePath` 与缺 review 字段的索引读为 null，`version` 仍为 1。
- `cowork-reviewer` preset：persona + agent-instructions + tool-bash + tool-fs-search，**不挂 `tool-fs`**（因此没有 read/write/edit 工具）。reviewer 用 bash 读文件、跑验证命令，写路径只剩 bash，靠 protocol 约束；不是只读沙箱。
- `cowork-master` persona 增加：handoff 后立即调用 `cowork_review_request`；禁止 dev_*/host/插件管理工具；只有 `pass`（或显式 override）才 merge；needs_revision 等 thread 修好后复审。

**面板（只读 v0）**

- `/api/cowork.overview` 的 thread 行追加 `reviewStatus` / `reviewedAt` / `reviewerSessionId`；`/api/cowork.handoff` 追加 `review:{record,filePath}|null`。缺字段/指针文件删除为 null，坏文档 `store/corrupt`；未知字段忽略；仍只读、`no-store`、只按索引 `latestReviewPath` 读。
- 客户端：列表 review 徽章（审查中/审查通过/需修改/已拒绝，带可见文本与时间 title）；详情「审查」区展示 verdict、reviewedAt、reviewer 短 id、summary、findings（severity/problem/requiredFix/file:line）、reviewer verification、review 文件绝对路径；`reviewerSessionId` 存在时提供「打开 review 会话」（`uiWorkspace.openSession`，失败/不可用有反馈）。

**E2E 与文档**

- `src/m3-e2e.ts` + `src/m3-e2e-support.ts`：真实宿主 15 步驱动，覆盖 pass → 合并、needs_revision → 修复 → 复审 pass → 合并；证据 `.dsh-cowork/e2e/M3_E2E.json`。reviewer 的确定性 verdict 指令以 `mode:'steer'` 在 reviewer 自主首轮前送达；master 的 handoff 自主回合被 adopt/steer，不再靠长 `waitIdle`。
- `/dsh-cowork/e2e/m3/run` / `status` 两条 loopback 路由。
- 工具计数 9 → 11（另有 2 个探针工具，运行中 `Tool.listTools` 可见 13 个 `cowork_*`）。

## Alternatives considered

**合并只允许 review pass、不允许覆盖。** 否决：review 超时、误判或用户明确要合并时没有出口，只能手改索引。选定「默认 pass + 显式覆盖」，覆盖理由进合并提交信息，审计上不弱于强制路径。

**M3 不收紧合并（review 仅呈现）。** 否决：独立 verdict 会变成没人看的旁证，满足不了「实现者不得自审」的验收意图。

**reviewer 也挂完整 `tool-fs`，只靠 persona 不改文件。** 否决：`dsh-tool-fs` 把 read/write/edit 打包成一个插件行，给了它等于把写工具放进 reviewer 手里；改为不挂 `tool-fs`，工具面上直接没有写文件工具。代价是 bash 仍能写，见 Consequences。

**新建一个只读 fs 工具包给 reviewer。** 否决：M3 新增一套工具装配路径与类型面，收益不足；留作需要真正只读评审环境时评估。

**reviewer 的 cwd 设成 thread 的 clone。** 否决：reviewer 需要主仓库与合并目标的真实上下文，clone 也不含 `.dsh-cowork` 与本地依赖；改为 cwd = 主仓库，prompt 给出 clone 路径与分支差异命令。

**把 review 数据放进 handoff 文件。** 否决：handoff 是 thread 的单向汇报，verdict 是另一方的独立证据；写进同一文件会让「谁写的」不可区分，也无法保留多轮 review 历史。

**面板新增第三条 review 路由。** 否决：overview 行放状态、handoff 响应挂最新 verdict 即可覆盖呈现，新增路由只会扩大 wire 面积。

**用 AgentTeams 承担 review。** 否决：仓库纪律禁止引入多编排运行时；只借语义。

## Consequences

- 真实宿主 E2E 已证明 review 门禁闭环：15/15 步、thread A pass → 合并、thread B needs_revision → 修复 → 复审 pass → 合并；review 文件先于索引、自审拒绝、findings 投递均成立。
- **面板两档真实 Chrome 截图已取得**（M3A8 通过）：重启宿主并 clean re-inject 后，原包 client 加载；fixture 下 overview/handoff 都来自真实宿主，分栏与 900 宽（右栏 <480）截图保存于 `.dsh-cowork/e2e/panel-m3/`。早先的面板 API 悬挂是 reload 留下旧 fiber 所致（clean re-inject 后即恢复），不是面板代码错误；大会话列表冷启动仍偏慢（KI-12）。
- reviewer 仍可用 bash 写文件；工具面已去 write/edit，但 bash 不是只读沙箱（KI/结果限制）。
- 合并覆盖可绕过 review；理由进 git 提交信息，M3 不做用户二次确认（后续可收紧）。
- `cowork` 会话仍能看到 profile 全局 dev_*/host 工具；M3 只把「禁止使用」写进 master persona，没有硬限制（KI-10）。
- 同名包 client 缓存问题（KI-11）与失败 E2E 留下 Markdown 夹具（KI-13）是环境/工具限制；`src/tools.ts` 距 50 KiB 读上限仅 16 B（KI-14）。
- reviewer preset 与 master/thread 一样是运行时注册，重启消失属 M4（KI-3）。
- 旧索引与字段兼容：缺 review 字段读为 null；面板对未知字段忽略。

## Testing

- [M3A1] `cowork_review_request` 为 `awaiting_review` thread 建独立 review 会话；brief 含 handoff 路径、changedPaths、verification、checkoutPath/分支 — `source`、`tests`：`src/tools.ts` request 流程；`tests/review.test.mjs`；E2E `review-a-request` / `review-b-request`（master 自主请求 + adopt）。
- [M3A2] verdict 只接受该 thread 的 `reviewerSessionId`、master/thread 自审被拒、review 文件先于索引 — `source`、`tests`：`src/review.ts` 调用者门；`src/tools.ts` 写序；`tests/review.test.mjs`；E2E review 文件。
- [M3A3] pass/needs_revision/reject 路由与 findings 投递 — `source`、`tests`：`verdictTransition`；E2E thread A/B；`tests/review.test.mjs`。
- [M3A4] 合并默认 pass、`allowUnreviewed+overrideReason` 可覆盖且理由进提交 — `source`、`tests`：`src/tools.ts` merge 门禁；`tests/review.test.mjs`；E2E 两次 pass 合并。
- [M3A5] `cowork-reviewer` 可创建、无 `tool-fs`、真实运行验证命令 — `packaging`：`src/presets.ts`；E2E reviewer 运行 `test -f` 并写 verdict。
- [M3A6] overview/handoff review 字段、旧索引兼容、面板徽章/详情/跳转 — `source`、`tests`：`tests/api-contract.test.mjs`、`tests/api.test.mjs`、`tests/panel-model.test.mjs`；真实宿主截图 `01-split-review-states.jpg` / `02-drill-list.jpg` / `03-drill-needs-revision.jpg`。
- [M3A7] 真实宿主 E2E 两轮 review 与合并 — `tests`：run `m3-d06cc6a6-3a97-4d3d-8cfc-92a2220ad1f7`，15/15，merge commits `2aa02856` / `6981bb94`。
- [M3A8] 两档真实 Chrome 截图 — `source`：`.dsh-cowork/e2e/panel-m3/01-split-review-states.jpg`（分栏）与 `02-drill-list.jpg` / `03-drill-needs-revision.jpg`（900 宽、右栏 <480 钻取），显示 review 徽章、chips、findings 与 reviewer 验证。
- [M3A9] 文档与发布 — `publication`：`docs/archived/results/M3_RESULT.md`、`docs/archived/results/M3_PROBE_RESULT.md`、PLAN/KNOWN_ISSUES/PANEL_RESULT/M3_HANDOFF 同步、`docs/publish.json` 分类、本记录迁入 implemented；`npm run check` 通过。
