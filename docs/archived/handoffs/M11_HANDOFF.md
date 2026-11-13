# M11 交接文档

## 交付状态（2026-11-08）

**M11 已交付**（代码 artifact `6b7beab`，四命令 exit 0、`npm test` 732/732）。交付事实、A1–A10 证据、真实 Chrome 记录、偏差与未验证项见 [M11_RESULT.md](../results/M11_RESULT.md)。本文件保持为 **M11 启动交接（历史）**，不复制交付证据；下方「M10 交付后的状态」「第一步」等段落记录的是启动时的基线，其中被交付状态推翻的表述已就地标注。

- 状态：**M11 启动文档（2026-11-08，历史）**。M10 已交付（[M10 交付结果](../results/M10_RESULT.md)）；本文件写给下一个会话，用于启动 V0.2 M11（HTTP API v2 与 CoWork 面板）。不重新论证 M10 的决定，也不重抄 M11 需求全文。
- 适用：接手 M11 的 agent 或人。范围：M10 交付后的代码基线、M11 的启动方式、实施顺序与证据、影响面、陷阱、完成定义、回滚与未验证清单。
- 事实源：[PLAN-V0.2](../../PLAN-V0.2.md) §2.2/§2.3/§2.4/§4.2/§5.3/§5.6/§5.9/§5.10/§6 M11 拥有需求与验收；[M11 决策记录](../../../.agents/notes/implemented/architecture/2026-11-08-m11-http-api-panel.md) 拥有执行层决定与备选；[面板与会话可见性](../../../.agents/notes/implemented/feature/2026-11-07-panel-and-session-visibility.md) 与 [可见性降级决策](../../../.agents/notes/implemented/feature/2026-11-07-topic-visibility-fallback.md) 拥有交互与决策 (b)；交付事实见 [M11_RESULT.md](../results/M11_RESULT.md)；[KNOWN_ISSUES](../../KNOWN_ISSUES.md) 拥有遗留归属；[AGENTTEAM](../../AGENTTEAM.md) 与 [testing](../../testing.md) 拥有流程与证据规则；本文件只拥有「从哪继续、先验证什么、怎样算完成」。

## M10 交付后的状态（2026-11-08）

- **M10 最终代码 artifact**：HEAD `e25a36f17cf04f04bdff199602886c20506ac451`；`git diff 4e05954..HEAD | shasum -a 256` = `098a0ac4d83babfb4892fa8d56c3321797101a90ad1d9f21bccc5b31b60af9ff`；`git status --porcelain` 空。M10 的文档提交为 `e25a36f`（M10.5）与 `b4f6580`（result fact-sync）；delivery 的合并/PR 可能在其后追加提交，**M11 启动时以实际 HEAD 为准**。
- **验证基线**：`npm test` **701 / 701 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo**；`npm run typecheck`、`npm run build`、`npm run check` 均 exit 0。字节：`src/tools.ts` 2,924 B、`src/store.ts` 48,560 B、`src/**/*.ts` 最大 `src/m2-e2e.ts` 49,923 B（<51,200 B）。
- **依赖**：M9（路由/工具面/预设）、M10（评审请求/工作项/合并）、M6 探针 5/6（工具面与面板同源 POST）。
- **数据模型**：canonical v2 已就绪——`.dsh-cowork/index.json` 的 `topics[]`/`workItems[]`、`activity.jsonl`、`inbox.json`、评审请求文件 `reviews/<topicId>-<requestId>.json`、handoff 文件仅审计。M10 的 15 个工具与 4 个预设不变；reviewer 在 verdict 后归档。
- **面板/API 现状（2026-11-08 在 `b4f6580` 实测）**：`src/api-contract.ts` 11,174 B（v1 thread wire，含 `PanelThread`/`PanelHandoffRecord`/`OVERVIEW_PATH`/`HANDOFF_PATH`）；`src/api.ts` 23,218 B（只注册 overview 与 legacy handoff，overview 读 legacy `readIndex`、评审卡取 `latestReviewPath`）；`src/client/*` 合计 110,436 B（thread 列表/详情/交接单）；`tests/api.test.mjs` 39,029 B、`tests/api-contract.test.mjs` 8,356 B、`tests/panel-model.test.mjs` 14,917 B。M11 已重写这些文件，交付后的字节与交付面见 [M11_RESULT.md](../results/M11_RESULT.md)「交付面」。
- **M11 要承接的遗留**：KI-18（`api.ts` 仍读 `latestReviewPath`，面板评审卡需切到请求文件）、KI-22（真实宿主 E2E 与真实数据未跑，M12）、KI-28（live reviewer 仍可能在左侧栏出现；面板不列、verdict 后归档是上限）、KI-6（旧 API 字段/路由移除的破坏性变更由 M12 README 记录）；KI-27（provider 仅 clone）与 M11 无关。

## 先读什么

1. [AGENTS.md](../../../AGENTS.md) 与 [docs/AGENTTEAM.md](../../AGENTTEAM.md)：纪律、R8 浏览器验证、R9 面板 fixture、DAG/artifact/交付规则。
2. [PLAN-V0.2](../../PLAN-V0.2.md) §2.4（界面与会话可见性）、§5.9（HTTP API 与面板）、§6 M11（范围/完成标准/证据/不做）、§7（测试与验收总则）。
3. [M11 决策记录](../../../.agents/notes/implemented/architecture/2026-11-08-m11-http-api-panel.md)：wire v2 字段、读/写路由、client 结构、备选与后果。
4. [M10 交付结果](../results/M10_RESULT.md)：「偏差与未验证」与「审查与修复」两节；不要复制它的证据。
5. [KNOWN_ISSUES](../../KNOWN_ISSUES.md)：KI-18/22/28 与各自的重估条件。
6. [M6 探针结果](../results/M6_PROBE_RESULT.md) §3（archive 后行为）、§5（preset 工具面）、§6（同源 POST 与真实 Chrome 的限制）；[M6 交接](M6_HANDOFF.md) 的决策 (b)。
7. [docs/testing.md](../../testing.md)（tiers、commands、fixture 规则）与 [面板交互记录](../../../.agents/notes/implemented/feature/2026-11-07-panel-and-session-visibility.md)。
8. [M10 交接文档](M10_HANDOFF.md) 作为本文件的模板（只读，启动版保留）。

## 第一步：M11 启动顺序

1. `git fetch origin`；工作区必须干净（`git status --porcelain` 为空）；记录实际基线 sha。
2. 确定基线：**如果 M10 PR 已合并**，用 `origin/main` 的 merge sha；**未合并**时用 `origin/feat/m10-review-request-workitems` 的 HEAD（若远端还没有该分支，用本地该分支 HEAD 并记录）。不要猜测 sha。
3. 新建 `feat/m11-http-api-panel`（不在 M10 分支上继续开发，不 rebase/force）。
4. 先跑基线四命令：`npm test`（期望 **701/701**）、`npm run typecheck`、`npm run build`、`npm run check`，全部 exit 0 才改代码；任何红先停下报告。
5. 建团队前读 [docs/AGENTTEAM.md](../../AGENTTEAM.md)，用已配置 profile；先派 **impact-scan** 任务：`grep -rn "latestReviewPath\|listReviews\|latestReviews\|writeReview\|HANDOFF_PATH\|OVERVIEW_PATH\|PanelThread\|PanelHandoff" src tests`、`wc -c src/api-contract.ts src/api.ts src/client/*.ts src/client/*.tsx`、核对 `tests/api.test.mjs`/`tests/api-contract.test.mjs`/`tests/panel-model.test.mjs` 的既有断言；把必须同改的测试写进 inScope。
6. 并行的 client/API 写任务必须用 `worktree_create` 隔离并把 `worktreePath` 写进任务；合并由队长独占；reviewer 必须能执行只读命令（M10 的 verify-only 做法）。
7. **真实 Chrome 前置（R8/R9）不是最后一步再补**：开始面板工作前确认宿主 health 200、`/api/cowork.overview` 200、BrowserSkill connected；准备隔离 fixture（独立 repo/DSH_HOME/port 或先停宿主），apply/restore 各 ≤5s 且真实 index hash/主题数可恢复。

## M11 实施顺序

1. **Wire v2（`src/api-contract.ts`）**：按提案第 1 节替换类型与上界，删除 v1 `PanelThread`/`PanelHandoffRecord`/`HANDOFF_PATH`；错误信封保持 M3 形状并补齐写路由错误码。先写 `tests/api-contract.test.mjs` 的边界/拒绝/计数用例。
2. **读路由（`src/api.ts`）**：overview 读前在锁内跑 `evaluateProjectLifecycle` 并传 `activeWorkItemsOf`（复用 `activeWorkItemCount`，KI-24 的读取点约定）；activity 尾部；topic 详情（工作项、评审请求、活动）。评审请求从 `reviews/*.json` 读取，不碰 `latestReviewPath`。
3. **写路由与安全**：resolve/reopen/route.move；master-only、`sessionId` 必填、锁内原子幂等、活动事件；插件侧 `Origin`/`Host` 同源与 JSON content-type 检查（M6 探针 6 已验证该组合）。
4. **Client 模型与列表**：`src/client/contracts.ts`/`api.ts`/`model.ts` 改 v2；主题列表、状态芯片、摘要、计数；无 thread/reviewer 行。
5. **详情、评审卡与操作**：`detail.tsx`/`panel.tsx` 的工作项表、评审卡、活动、打开/已解决/重开/改投；`uiWorkspace.openSession` 只切主区，面包屑回 master；预归档主题才 unarchive。
6. **真实 Chrome 与收口**：R8/R9 验证、截图与 run 记录；`docs/M11_RESULT.md`、本交接、KNOWN_ISSUES、publish.json；四命令全绿后停等确认，不进入 M12。

## 影响面（派单前先扫）

- **新/重写**：`src/api-contract.ts`（v2 wire）、`src/api.ts`（读/写路由、安全、生命周期读取点）、`src/client/contracts.ts`、`src/client/api.ts`、`src/client/model.ts`、`src/client/list.tsx`、`src/client/detail.tsx`、`src/client/panel.tsx`、`src/client/chips.tsx`、`src/client/styles.ts`、`src/client/index.tsx`；`src/index.ts` 只改装配（端口/注册），不承载业务。
- **测试**：`tests/api-contract.test.mjs`、`tests/api.test.mjs`、`tests/panel-model.test.mjs` 重写/扩展；`tests/source-budget.test.mjs`（模块归属与预算）；若 client 拆新文件，`tools/workflow.json` 的 surface 已覆盖 `src/**/*.ts`，无需改 check。
- **基础设施（只读引用）**：`store.readText`/`writeTextAtomic`/`withWriteLock`、`review-request.ts` 的 parse、`topic.ts`/`topic-tools.ts` 的 resolve/reopen 规则、`route-tools.ts` 的 `applyRouteCorrectionToStore`、`session-visibility.ts` 的归档语义、`evaluateProjectLifecycle`/`activeWorkItemCount`。
- **预算**：`src/api-contract.ts` 11,174 B、`src/api.ts` 23,218 B、client 单文件 2–18 KB；重写后仍须每个 `src/**/*.ts` <51,200 B，`tests/source-budget.test.mjs` 会红。
- **文档**：`docs/M11_RESULT.md`（新）、本交接、`docs/KNOWN_ISSUES.md`、`docs/publish.json` 分类；0.2.0 的 wire 破坏性变更由 M12 README 统一记录。
- **不做**：不新增工具/预设、不改 store/schema 语义、不做 M12 的真实全链路 E2E 与数据迁移、不发布 README 0.2.0 变更。

## 陷阱

- **`latestReviewPath` 是 legacy 读取**。M10 起新评审不写它；面板评审卡必须从 `reviews/<topicId>-<requestId>.json` 取（requestId/范围/verdict/findings），旧 review/handoff 文件只读。不要为了旧 reader 改文件名或继续写 legacy 字段（KI-18）。
- **reviewer 隐藏是面板不列 + verdict 后归档，不是宿主不可见**。M6 探针 3/4：不能对主题 `archiveSession`（归档后不能继续对话），reviewer 创建后立即归档会让 turn `blocked`。live reviewer 仍可能在左侧栏出现（KI-28），不要声称已隐藏。
- **打开主题不新增/移除左侧栏条目**。用 `uiWorkspace.openSession(topicId)` 切主区；不要用 archive/unarchive 做导航；只有主题已被用户预先归档时才容错 unarchive（非常规路径）。
- **fixture 不能碰真实 `.dsh-cowork`（R9）**。宿主正在服务 panel 请求时不要直接改真实目录；用 fixture repo/独立 DSH_HOME/port，apply/restore 一次完成并校验 hash；`.dsh-cowork` 内不写 Markdown（KI-13）。
- **client 是预打包产物**。仓库没有 dev watcher；改 `src/client/**` 后必须 `npm run build`（含 `scripts/build-client.mjs` → `lib/client.js`）再验证。注入器/宿主可能命中旧 bundle（KI-11 pkgMeta、KI-16 ESM 缓存）：先核对 bundle 内容/重启宿主，不要把旧行为当新证据。
- **同源写路由**。沿用宿主 loopback；插件侧要补 `Origin`/`Host` 同源与 JSON content-type（缺 content-type 415、坏来源 403），错误文案可读。M6 探针 6 未验证认证后的 `/api` POST（401 属宿主认证）；不要读取或绕过 cookie/token。
- **PLAN §4.5 的会话表曾是过时的**：启动时它写「主题会话 | 可见性 隐藏」，与 §2.4/§5.9/§5.10 和决策 (b) 冲突；M11 收口已修正该行（主题左侧栏可见、reviewer 隐藏且宿主侧栏可能仍可见）。
- **上界**：overview ≤500 主题；activity 默认 50、上限 200；详情 workItems ≤50、reviewRequests ≤10、findings ≤20、verification ≤10、changedPaths ≤50；digest/summary ≤200。不要返回完整 handoff/review 全文或 reviewer 会话列表。
- **文档分类**：新增 `docs/M11_RESULT.md` 等必须在 `docs/publish.json` 分类；`npm run check` 会抓未分类 `.md`。

## 验证与证据

- **定向**：`node --test tests/api-contract.test.mjs tests/api.test.mjs tests/panel-model.test.mjs`；阶段收口 `npm test`（701 + 新增）、`npm run typecheck`、`npm run build`、`npm run check`，逐条记录 exit code。
- **真实 Chrome（R8）**：一次验证复用一个长生命周期 session/tab；单次 `bsk_session` ≤10、无 >60s sleep/API 等待；截图是证据，结束主动 stop。记录 health、overview 200、写路由 200+bodyEcho。
- **Fixture（R9）**：apply/restore 各 ≤5s；真实 index hash/主题数恢复；截图来自 fixture 视图。
- **面板 run 记录**：与 M6/M9 的做法一致，记录放在 gitignored 的 `.dsh-cowork/`（不写 `.md`）或 `docs/M11_RESULT.md` 引用的路径；不要把凭据、cookie、token 写进文件或消息。
- **AgentTeams 流程**：impact-scan → 并行写（worktree 隔离）→ 队长串行合并 → `integration-ready`（记录 HEAD + `git diff <base>..HEAD | shasum -a 256` + `git status --porcelain`）→ verification → review（reviewedTaskId=实现）→ 批量修复 → final integration → delivery；docs-only 变更只跑 `npm run check` 与定向测试。
- **真实 E2E 边界**：M11 只做真实 Chrome 面板与 API；完整跨会话 E2E（路由→主题→评审→合并→已解决→重开）归 M12（KI-22）；不得用单测代替真实 Chrome 结论。

## 完成定义

- PLAN M11 完成标准全部满足：面板显示主题列表/详情/活动；无 thread 行、无 reviewer 行；reviewer 评审卡挂详情；打开主题切主区、面包屑回 master、不新增/移除左侧栏条目、预归档主题才 unarchive；写路由同源/loopback 校验、错误状态可读；真实 Chrome 面板检查通过。
- `tests/api-contract.test.mjs`、`tests/api.test.mjs`、`tests/panel-model.test.mjs` 覆盖 v2 wire、读/写路由、边界与错误；`npm test` 全绿（0 fail/skip/todo）。
- `npm run typecheck`、`npm run build`、`npm run check` exit 0；`src/**/*.ts` <51,200 B；client 由 `npm run build` 产出。
- `docs/M11_RESULT.md`、本交接、`KNOWN_ISSUES`、`docs/publish.json` 更新；review pass 后停等确认，不进入 M12。

## 回滚

- **代码**：按 M11 提交序列逆序 `git revert`。wire 与 client 是成对破坏性变更：host 与 `lib/client.js` 必须一起回滚/重装，旧 client 配新 host（或反之）不可用。
- **数据**：M11 只读 canonical v2 与评审请求文件；本阶段不应写索引（写路由只写 `resolved`/`reopened`/`aliases` 与对应活动）。回滚代码不需要数据迁移；已写入的 `resolvedBy/resolvedAt`/`aliases` 与活动保留，属于正常业务状态。
- **文档/记录**：revert 对应文档提交；`docs/publish.json` 的 M11_RESULT 条目随提交回滚。不要 force-push。

## 未验证（归 M12 / 后续）

- 真实宿主全链路 E2E（路由→主题→评审→verdict→合并→已解决→重开→活动流）——M12（KI-22）；M11 只验证面板/API 自身。
- 真实 v1/v2 数据的迁移与回滚演练（KI-22）；M11 的夹具是临时目录。
- 认证后的 `/api` POST 已在 M11 的已认证面板上下文补证据（overview/topic/activity 200、写路由 200 与 403/415/400，见 [M11_RESULT](../results/M11_RESULT.md) A8）；Origin 伪造（浏览器 forbidden header）与剪贴板写入仍未验证，未验证前不得声称生产可用。
- live reviewer 在宿主左侧栏仍可能可见（KI-28，接受上限）；无会话过滤接口。
- 移动端、多窗口与 headless 差异不在 M11 范围。

## 指针

- M11 决策记录（implemented）：[2026-11-08-m11-http-api-panel.md](../../../.agents/notes/implemented/architecture/2026-11-08-m11-http-api-panel.md)；交付事实：[M11_RESULT.md](../results/M11_RESULT.md)。
- 面板交互与可见性（implemented）：[2026-11-07-panel-and-session-visibility.md](../../../.agents/notes/implemented/feature/2026-11-07-panel-and-session-visibility.md)、[2026-11-07-topic-visibility-fallback.md](../../../.agents/notes/implemented/feature/2026-11-07-topic-visibility-fallback.md)。
- M10 交付结果：[M10_RESULT.md](../results/M10_RESULT.md)；M10 启动交接（历史）：[M10_HANDOFF.md](M10_HANDOFF.md)。
- 评审模型与工作项/合并边界（implemented）：[2026-11-07-review-request-model.md](../../../.agents/notes/implemented/feature/2026-11-07-review-request-model.md)、[2026-11-07-parallel-isolation-and-merge.md](../../../.agents/notes/implemented/architecture/2026-11-07-parallel-isolation-and-merge.md)。
- M6 探针与决策：[M6_PROBE_RESULT.md](../results/M6_PROBE_RESULT.md)、[M6_HANDOFF.md](M6_HANDOFF.md)。
- 遗留问题与归属：[KNOWN_ISSUES](../../KNOWN_ISSUES.md)。
