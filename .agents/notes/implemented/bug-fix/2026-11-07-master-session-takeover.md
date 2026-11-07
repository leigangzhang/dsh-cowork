# Decision: master 会话可显式接管（cowork_project_init 的 takeOver）

Status: implemented
Date: 2026-11-07
Class: bug-fix

## Problem

项目索引把 master 绑定为一个会话 id：`<repo>/.dsh-cowork/index.json` 的 `masterSessionId`。`checkRole` 用严格相等判断（`caller.sessionId === index.masterSessionId`），而 `initIndex` 只在首次创建时写这个字段、之后永不替换，全仓库也没有第二条重绑路径。后果是：用户换一个会话打开同一个项目后，任何 `cowork_*` 调用都返回 `role/forbidden`；`cowork_route` / `cowork_thread_create` 在角色门就被拒绝，`sessionController.create` 根本执行不到，表现为「创建 thread 失败」。

现场证据（2026-11-07）：`.dsh-cowork/index.json` 的 master 是 11-05 M1 E2E 留下的 `session-65c8337f…`（preset `cowork-master`，仍存在但已不是当前会话）；当前会话 `session-b7b4f358…`（preset `router-standard`）调 `cowork_project_status` 返回 `role/forbidden`，错误里写明 master 是 `session-65c8337f…`。同一现象在 `session-c91cf416…` 复现。cowork 工具是 profile 全局工具（KI-10），所以非 master preset 的会话也看得见它们，但没有接管入口。

## Decision

`cowork_project_init` 增加可选参数 `takeOver`（布尔，默认 false），并抽出纯决策 `claimMaster(caller, index, { takeOver })`：

- 调用者就是当前 master：`current`，不写索引（`takeOver` 为 true 也不写）。
- 调用者被索引登记为 thread：`role/forbidden`，thread 不能接管（thread 的职责是 handoff 回 master）。
- 其他会话且未传 `takeOver: true`：`role/forbidden`，错误消息指出当前 master 并提示用 `takeOver: true` 接管。
- 其他会话且 `takeOver: true`：`takeover`，返回前任 master。

`ProjectStore.rebindMaster(sessionId)` 在既有 project lock 内读改写，只替换 `masterSessionId`，`projectId` / `createdAt` / threads 原样保留；同一 id 是幂等 no-op；缺索引时在取锁前失败，不创建 `.dsh-cowork/`。`cowork_project_init` 的响应保留原有键，新增 `rebound` 与 `previousMasterSessionId`。并发接管时后写者胜，由锁串行化。

文档同步：README 的初始化步骤、PLAN §2.2 与 §5 工具表。

## Alternatives considered

**按 preset 限制接管（只有 cowork-master 会话能接管）。** 否决：cowork 工具是 profile 全局注册的（KI-10），用户的会话 preset 是 `router-standard`；按 preset 加门会把「已装插件、索引在、却无法接管」原样留下，而且 preset 只描述提示词，不构成可靠的授权信号。

**旧 master 不可用时自动回收。** 否决：宿主没有可靠的「已归档/空闲」判据，把不可判定状态当成接管许可会破坏 fail-closed；一次误判就把项目从仍在使用中的 master 手里抢走。

**删除/重建索引（删 `.dsh-cowork/index.json` 后重新 init）。** 否决：会丢掉 thread 清单、review 状态与 handoff 的索引关联，且没有审计；这正是本次要消除的运维手段。

**新增独立 `cowork_project_rebind` 工具。** 否决：工具面已 11 个，init 本来就是唯一写 `masterSessionId` 的地方；一个显式参数足以表达接管，且让创建/接管共用同一条写入路径与同一个错误契约。

**把 master 从「会话 id」改成「preset 身份」或允许多 master。** 否决：handoff 的投递目标是单个 master 会话；多 master 会让同一份 handoff 被重复消费，改绑定语义则要迁移全部索引与投递路径，超出本次修复面。

## Consequences

- 默认行为不变：不传 `takeOver` 时仍是 fail-closed；现有调用方与错误码 `role/forbidden` 不变，只是消息多了一句接管提示。
- 接管是显式的、有响应证据的：调用者拿到 `previousMasterSessionId`；旧 master 立即失去项目权限，pending handoff 会在新 master 下次 `cowork_project_status` 时重放。
- 信任边界与首次 init 同级：任何能解析到该仓库的会话都可以在显式 flag 下接管；索引里登记为 thread 的会话被排除。项目级仍是单 master，不引入多主。
- 不记录 master 历史字段：审计依赖工具响应与会话日志，索引保持 version 1 不变。
- 运行中的宿主仍装载旧代码：本机 DSH 的插件热重载只替换 entry 模块 URL，静态 import 命中 Node ESM 缓存（KI-16），所以 `takeOver` 参数要宿主重启后才可用；当前项目的现场解锁用同一 store 方法直接改索引，再由线上旧工具真实建 thread 验证。
- 如果两个会话同时接管，后写者胜；被覆盖的一方下一次调用会收到 `role/forbidden`，可以再用 `takeOver` 夺回。

## Testing

- [MS1] `claimMaster` 四态：current 不写、stranger 未传 flag 拒绝且消息含接管提示、thread 带 flag 仍拒绝、stranger 带 flag 返回前任 master — `source`, `tests`
- [MS2] `rebindMaster` 只替换 master 并保留 projectId/createdAt/threads；同 id 幂等；缺索引报 store/not-found 且不创建目录；文件 0600、无残留 — `source`, `tests`
- [MS3] `cowork_project_init` 接受 `takeOver` 并在响应给出 `rebound` / `previousMasterSessionId`；typecheck 与 build 通过 — `source`, `packaging`
- [MS4] README 与 PLAN 的接管说明与新参数一致；`npm run check` 通过 — `publication`
- [MS5] 四命令：`npm run check`、`npm test`、`npm run typecheck`、`npm run build` 全绿（npm cache 指向可写临时目录） — `packaging`, `publication`
- [MS6] 真机（2026-11-07）：备份后把真实索引从 `session-65c8337f…` 接管到本会话，`cowork_project_status` 返回 ok，`cowork_thread_create` 真实建出 `session-bc935d5b…`（session header preset `cowork-thread`、索引 `status=new`）；旧会话随即失去项目权限。备份 `.dsh-cowork/e2e/rebind-backup-20261107T101037Z.json`（与改前索引 sha256 一致） — `source`, `packaging`
