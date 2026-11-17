# Decision: 并发决议同一请求只生效一次、只唤醒一次

Status: implemented
Date: 2026-11-17
Class: bug-fix

## Problem

面板的请求收件箱（`POST /api/cowork.inbox.resolve` → `resolveRequest`）在同一个请求被并发决议时会把丢失方也当成成功：

- 两个调用都返回 `changed: true`，各自向 topic 投递一次 wake-up prompt，topic 收到重复消息、重复消耗模型回合；
- `request-resolved` activity 把失败方的 action 记到获胜方写下的终态上，例如 `action: return` 配 `status: passed`，事后审计看到不存在的操作；
- 同一 action 的幂等重放也不返回 `changed: false`，而是再次 prompt。

根因在 `src/domains/requests/request-lifecycle.ts`：`resolveRequest` 把 `store.update(...)` 返回非 null 当作“本次决议已应用”，但 `RequestStore.updateUnlocked` 在 mutator 返回 null 时返回**当前记录**而非 null。只有 mutator 在锁内执行，也只有它知道是否看到 pending 并写入了终态；锁外的判断无法区分“我应用了”和“别人先应用了，我只是拿回了结果”。

证据（B1 探针，修复前 5/5 复现）：真实临时项目里构造 pending user-review，两个 `resolveRequest` 并发（一个 `pass`、一个 `return`），观测到 2 次 prompt、2 条 activity。同 action 并发得到 `[changed: true, changed: true]`。

## Decision

`resolveRequest` 的 mutator 在锁内记录 `applied`（只有看到 `pending` 并写入终态才置 true）。`store.update` 返回后按 `!applied || next === null || next.status !== status` 判定本次写入未生效，然后用无锁 `store.read(requestId)` 取当前记录并分类：

- 记录不存在 → 抛既有的 `inbox/request-not-found`（`request <id> vanished`）；
- 同一 action → 返回 `{ changed: false, prompted: false }`，不写 activity、不 prompt；
- 不同 action → 抛既有的 `inbox/request-resolved`。

只有确认本次写入生效的调用才 append `request-resolved` activity、投递 prompt。`RequestStore` 契约、工具参数、错误码与持久格式均不变；非并发路径的行为与措辞保持原样。

## Alternatives considered

**改 `RequestStore.update` 在 mutator 返回 null 时也返回 null。** 否决：现有调用者（`recordDelivery` 等）依赖“拿回当前记录”来继续处理；改契约会波及锁语义与多个调用点，超出这次 bug 修复的范围。

**新增 `RequestStore.updateIf`，返回 `{ record, applied }`。** 否决（本次范围）：语义更清楚，但引入新的 store API 与两条更新路径；本次用 mutator 内一个布尔量已经能精确表达“是否应用”，收益不足以扩大改动面。若未来出现第三个需要判别写结果的调用者，再收敛成 `updateIf`。

**update 前先 `read` 判断 pending，只在 pending 时才 update。** 否决：read 与 update 之间有 TOCTOU 窗口，正是本 bug 的形态；判别必须发生在锁内。

**保留现状，改由调用方去重（面板禁用按钮/幂等键）。** 否决：并发不只来自双击，工具与面板可能同时提交；去重属于调用方约定，无法保证 activity 与 prompt 恰好一次。

## Consequences

- 并发决议恰好一次唤醒、恰好一条 activity，且 activity 的 action/status 与最终记录一致；丢失方得到幂等重放或冲突错误。
- prompt 投递失败仍在 `delivery.lastError` 中报告，不回滚已落盘的终态（既有契约）。
- 不改变 `RequestStore`、面板 API 或错误码；顺序调用、重放、冲突与“请求消失”的既有行为由测试继续钉住。
- 残余风险：并发测试依赖真实 store 的锁时序，断言只看结果不变量；若未来 store 层改成批量/异步批处理，需要重新确认 `applied` 的语义。

## Testing

- [RL1] 不同 action 并发：恰好一个成功、一个 `inbox/request-resolved`，恰好一次 prompt，`request-resolved` activity 的 action/status 与最终记录一致 — `tests`
- [RL2] 同 action 并发：结果集合为 `[changed: true, changed: false]`，恰好一次 prompt — `tests`
- [RL3] 顺序 resolve / 同 action 重放 / 异 action 冲突的错误码与 `changed`/`prompted` 保持原契约 — `tests`
- [RL4] 读到写之间请求消失：抛 `inbox/request-not-found`，不重建卡片、不 prompt — `tests`
- [RL5] create 的非 schema 错误原样上抛；activity 写失败与 prompt 投递失败仍按既有降级路径报告 — `tests`
- [RL6] `request-lifecycle.ts` 行覆盖 100%，`npm test`、`npm run test:coverage` 与 `npm run check` 通过 — `source`, `tests`
