# M1 结果：master/thread 闭环

- 结论：M1 把 PLAN §6 的闭环落成真实宿主行为——master 初始化项目、route 创建并复用 thread、thread 交回 handoff、master 收到结构化消息；六个 `cowork_*` 工具与两个运行时 preset 生效，纯模块有单测，角色越权由工具层拒绝。S1–S6 全部交付。
- 证据容器：`.dsh-cowork/e2e/M1_E2E.json`（gitignored）中的 run `e2e-9f61bf5b-5320-42e0-8064-cae7c605b0d2`，`state: done`，8/8 phase `passed`。宿主：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2，web profile `http://127.0.0.1:3080`。
- 会话：master `session-65c8337f-f5c1-4dc4-90bb-b6b4d9466db6`，thread `session-a9072f0b-72f3-4113-a56a-c0d6a71a43f9`，workspace `70ec5443-a9e2-4368-9cce-ae06d9babb9e`。下文原始输出均摘自该文件 `phases[].evidence`，只省略重复结构，不改字段值。

## 交付面

| 落点 | 职责 |
|---|---|
| [`src/store.ts`](../../src/store/project-store.ts) | `index.json` 与 handoff 文件的唯一写者：`withFileLock` + `writeFileAtomic` + 目录 fsync；损坏文件带路径报错、不重建。 |
| [`src/session-slice.ts`](../../src/platform/session-slice.ts) | `sessionController`/`workspaceRegistry` 薄封装：workspace 解析、create + preset 校验 + rename、queue prompt、list 探测。 |
| [`src/routing.ts`](../../src/domains/routing/routing.ts) | 纯函数关键词路由：ASCII 词 + CJK bigram；subject×3 + keyword×2 + 状态罚分 + recency；阈值 4 且领先 ≥1。 |
| [`src/handoff.ts`](../../src/domains/topic/handoff.ts) | handoff 逐字段校验、落盘→索引→投递固定顺序、失败保留、`deliveredAt` 仅成功后写、重放。 |
| [`src/tool-model.ts`](../../src/platform/tool-model.ts) | 调用者身份、角色校验、错误包络、brief 与 route payload 的纯函数。 |
| [`src/tools.ts`](../../src/app/tools.ts) | 六个 `cowork_*` 工具。 |
| [`src/presets.ts`](../../src/platform/presets.ts) | `cowork-master` / `cowork-thread` 各 10 行显式注册，第二次注册失败会回滚第一个。 |
| [`src/index.ts`](../../src/app/apply.ts) | 装配工具与两个 preset；M0/S0 探针保留（见限制）。 |

六个工具：`cowork_project_init`、`cowork_project_status`、`cowork_route`、`cowork_thread_create`、`cowork_thread_list`、`cowork_handoff`。角色：init/route/thread_create 仅 master；handoff 仅 thread 且只能报自己的 threadId；status/thread_list 对两者开放（`src/tools.ts:240,271,326,402,443,492`）。preset 由 `agentPresets.register` 运行时注册（`src/index.ts:318-326`），重启消失。

## A1–A4 真实宿主 E2E

每条的证据命令（把 `<phase>` 换成对应 phase id）：

```sh
node -e "const r=require('./.dsh-cowork/e2e/M1_E2E.json');console.log(JSON.stringify(r.phases.find(p=>p.id==='<phase>').evidence,null,1))"
```

### A1 init 建索引、登记 master、重复调用幂等 — `source`

phase `init` / `init-idempotent`，`turn 1`（`startSeq 4` → `endSeq 27`，`reason completed`），`toolCalls: ["cowork_project_init"]`。`initResult` 原文摘录（仅删去重复的 `repoPath` 与 `index.projectId`，字段值未改）：

```json
{"ok":true,"projectId":"github.com-leigangzhang-dsh-cowork","masterSessionId":"session-65c8337f-f5c1-4dc4-90bb-b6b4d9466db6","workspaceId":"70ec5443-a9e2-4368-9cce-ae06d9babb9e","created":true,"index":{"version":1,"masterSessionId":"session-65c8337f-f5c1-4dc4-90bb-b6b4d9466db6","createdAt":"2026-11-05T12:50:12.730Z","threads":[]}}
```

第二次调用：`created:false`，`masterBefore` 与 `masterAfter` 都是 `session-65c8337f-…`，`createdAtAfter` 仍是 `2026-11-05T12:50:12.730Z`。master 会话的 `createReturnedPreset` 与 `headerPreset` 都是 `cowork-master`，`headerCwd` 为仓库根，`workspaceSessionIdsIncludesMaster: true`。

### A2 route 创建 thread 并投递初始 brief — `source`

phase `route-create`。evidence 字段摘录（拼接自该 phase 的 `routeResult` 与断言字段，字段值未改）：

```json
{"action":"created","threadId":"session-a9072f0b-72f3-4113-a56a-c0d6a71a43f9","subject":"路由演示","title":"cowork: 路由演示","prompted":true,"thread":{"status":"active","cwd":"/Users/ray/Workspace/dsh-cowork"},"threadInSessionList":true,"threadInWorkspace":true,"briefPromptAccepted":true}
```

`threadInWorkspace` 是 `workspace.sessionIds.includes(threadId)` 的直接结果（E2E 断言；原始数组未落盘）；索引记录 `status: active`、`createdAt 2026-11-05T12:50:21.028Z`。

### A3 相关 intent 复用同一 thread，无关 intent 不误复用 — `source`、`tests`

phase `route-reuse` 的 evidence 字段摘录：`{"action":"routed","threadId":"session-a9072f0b-…","score":10,"reusedSameThread":true,"promptDeliveredToThread":true}`。phase `route-unrelated`：`{"action":"needs_subject","candidates":[],"threadCountBefore":1,"threadCountAfter":1,"reusedWrongThread":false}`。打分与阈值边界另由 `tests/router.test.mjs`（10 用例）钉住。

### A4 thread handoff 落盘、更新索引、master 收到消息 — `source`

phase `handoff`：`delivered:true`，文件 `.dsh-cowork/handoffs/session-a9072f0b-72f3-4113-a56a-c0d6a71a43f9-20261105T125044236Z.json`，记录 `deliveredAt 2026-11-05T12:50:44.252Z`；索引 thread `status: awaiting_review`、`lastHandoffAt 2026-11-05T12:50:44.236Z`；`masterReceivedHandoff: true`。master 收到的消息文本（摘录）：

```text
handoff from thread session-a9072f0b-72f3-4113-a56a-c0d6a71a43f9
status: awaiting_review
subject: 路由演示
...
file: /Users/ray/Workspace/dsh-cowork/.dsh-cowork/handoffs/session-a9072f0b-72f3-4113-a56a-c0d6a71a43f9-20261105T125044236Z.json
```

phase `status`：`pendingHandoffs: []`，`replay: {attempted:0, delivered:0, failed:0}`。投递失败保留与重放由 `tests/handoff.test.mjs`（10 用例）覆盖。

## A5–A8

- **A5 单测** — `tests`：`store 11` / `handoff 10` / `router 10` / `session-slice 14` / `tool-model 7`，共 52 个 M1 用例；`npm test` 全量 65 个通过（含 M0 的 `probe-model` 5 与 `workflow` 8）。
- **A6 构建与门禁** — `packaging`：`npm run typecheck`、`npm run build`、`npm run check`、`npm test` 均 exit 0（本轮实跑）；`package.json` 仍只有 `@deepseek-ai/*` 宿主 peer 依赖，`src/` 无 `dsh-agent-hub`/`dsh-forge`/`dsh-team-conductor` 或 AgentTeams 的 import。
- **A7 文档与发布** — `publication`：本文与 `.agents/notes/implemented/feature/2026-11-05-m1-master-thread-loop.md` 已进 `docs/publish.json` 的 internal 分类（`npm run check` 验证恰好一次分类）。
- **A8 角色与身份** — `source`：phase `role-forbidden` 中 thread 调 `cowork_project_init` 返回 `{"ok":false,"error":{"code":"role/forbidden",…}}`（`forbidden: true`）；`exec.agent` 缺失时 `readCaller` 返回 null、工具统一报 `exec/agent-unavailable`（`src/tool-model.ts:13,52`，`tests/tool-model.test.mjs` 7 用例）。

## 限制 / 未验证

- 运行时 preset 重启即消失；跨重启保留要等 M4 的 bundle patch。
- master 的写工具未硬限制：只有 persona + 工具内角色校验（M1 没有 preset-scoped 模块可调 `ctx.tools.restrict`）。
- 侧栏 DOM 未验证：只到 `sessionController.list` 与 `workspace.sessionIds` 数据层。
- `exec.agent` 在 PTC 内层 dispatch 未单独验证；模型直接调用工具的路径已证。
- 探针与 E2E 设施是临时证据工具：`cowork_probe`/`cowork_identity_probe` 与 `/dsh-cowork/probe/*`、S0 路由仍留在 `src/index.ts`；`.dsh-cowork/{probe,e2e}/` 保留作原始证据。
- E2E 的 handoff 内容是夹具（`summary` 含 runId、`changedPaths: ["src/tools.ts"]`）；master 收到后质疑该改路径声明。A4 只验收“投递并被收到”，不验收内容真实性。

## 回滚

- 代码：按提交 revert（S1–S5 已分阶段提交，`git log --oneline`）。
- 运行时：`dev_uninject_plugin dsh-cowork` 移除注入；`.dsh-cowork/` 是项目数据，保留。
- 文档：回退本提交即恢复提案与旧索引；`docs/publish.json` 与 README 行在同一提交内成对回退。
