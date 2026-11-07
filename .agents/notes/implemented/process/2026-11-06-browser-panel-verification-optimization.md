# Decision: 浏览器与面板验证优化（真实 UI / fixture）

Status: implemented
Date: 2026-11-06
Class: process

## Problem

M3 主会话里，浏览器操作 **797.1s / 103 次调用**、面板 fixture **567.3s / 5 次调用**，是除集成/E2E 之外最大的验证开销。具体表现：

- `bsk_session` 61 次（470.8s）：宿主重启后扩展未连接、reload 失败（“Previous operation is still settling”）、面板 tab body 丢失、旧 fiber 下 panel API 悬挂；每次重试都 stop/start 一个 Agent Window。
- 浏览器交互 22 次（222.6s，最大 71.2s）：大型 session transcript 的 sync 很重；会话树点击目标频繁移动，需要重新 sync；`/api/cowork.overview` 有 25s 超时、`/api/session/list` 17s/1.2MB，面板 skeleton 期间用 20/40/60s sleep 等。
- 面板 fixture 5 次（567.3s）：302.9s 的 apply+store 校验和 220.7s 的 restore+profile patch 都**成功输出**；同一脚本在宿主恢复后的 apply 只需 6.9s。离群值不是文件 I/O，而是宿主 event loop/结果投递被 panel API 阻塞；fixture 直接改真实 `.dsh-cowork`，又必须 restore。
- 根因：先动浏览器/真实数据，后修宿主；浏览器 session 不复用；fixture 与 live 数据共用目录；用 sleep 当 readiness。

## Decision

项目现在把浏览器与面板 fixture 的验证流程写成规则，作为 [AgentTeams 集成与 E2E 规则](../../../../docs/AGENTTEAM_INTEGRATION_RULES.md) 的 R8/R9，并在 [AGENTS.md](../../../../AGENTS.md) 的 `## AgentTeams` 段要求队长/验证者遵守：

- **R8 浏览器验证**：开始前 health 200、`/api/cowork.overview` 200、BrowserSkill 扩展 connected；不满足先修宿主/clean inject，不用重启浏览器掩盖后端故障。每次验证复用一个长生命周期 session/tab，不每步 stop/start；reload/extension 失败最多重开一次。使用专用小 profile/会话/测试 repo，避免加载 1.2MB session 列表和长 transcript；选择器优先 `data-testid`/稳定 CSS；目标移动时 sync 一次再点，不盲目重试；截图是证据，结束主动 stop。
- **R9 面板 fixture**：不在宿主服务 panel 请求时直接改真实 `.dsh-cowork`；优先 fixture repo/独立 DSH_HOME/profile/port，或先停宿主。fixture 脚本只写 fixture 数据目录，直接 fs 写入，不调用 host API、不等待 project lock；apply 前备份、restore 幂等；数据目录不写 Markdown（KI-13）。302.9s/220.7s 的离群值是宿主 event loop/结果投递延迟，不是 fixture I/O；先修 health/API 再测 apply/restore。
- **指标**：单次验证 `bsk_session` ≤10（基线 61）；无 >60s 的 sleep/API 等待；fixture apply/restore 各 ≤5s（基线离群 302.9/220.7s）；真实 index 的 hash/线程数恢复；截图来自 fixture 视图。

这次决策不改变验证内容：最终仍要在真实 Chrome + 真实 panel API 上截图，fixture 只提供可复现状态；不把 mock 截图当最终证据。

## Alternatives considered

**宿主 API 还挂着就反复重启浏览器/重开 session。** 否决：M3 的 61 次 `bsk_session` 多数是这种重试；后端 stale fiber 不会因为换浏览器窗口修好，反而把一次后端故障放大成几十次前端操作。

**继续在 live `.dsh-cowork` 上 apply/restore。** 否决：真实数据必须备份/恢复，且宿主服务 panel 请求时写入会竞争；303s/221s 的离群值说明现场不可控。隔离 fixture repo/profile 才可重复计时。

**用 mock API 或只做 DOM 截图替代真实 Chrome。** 否决：M3A8 的证据要求真实 Chrome 与真实 overview/handoff；mock 可用于布局迭代，但不能作为最终验收。规则要求 fixture 只隔离数据，不隔离宿主。

**只修 M3L-1 的超时，不改验证流程。** 否决：超时让失败可重试，但不减少 61 次 session 重建、live 数据互改和 60s sleep；流程规则必须同时落地。

## Consequences

收益：浏览器验证从“遇到问题就重开”变成“先证明宿主/API ready，再复用一条 session”；fixture 从改 live 数据变成隔离 fixture 视图；离群调用有明确归因，不再把宿主卡顿误判为 fixture 慢。代价：需要准备专用小 profile/测试 repo 或隔离 DSH_HOME；fixture 脚本要维护备份/恢复；首次搭建比直接改 live 数据多一步。

没有改变：最终真实 Chrome + 真实 API 的截图要求；BrowserSkill 本身的能力边界；产品代码。规则只在本项目生效；稳定两个阶段后再考虑提升到用户级 AGENTS/skill。若 BrowserSkill 支持稳定 tab/选择器、或宿主提供隔离测试 profile 的正式入口，重估 R8/R9。

## Testing

- [P1] AGENTS.md 的 `## AgentTeams` 段链接规则文档，并写明 R8/R9 的宿主健康、复用 session、隔离 fixture 要求 — `context-rules`
- [P2] 规则文档在 `docs/publish.json` 分类为 internal，且包含 R8/R9 的验收指标 — `publication`
- [P3] `tools/panel-fixture.mjs` 提供 apply/restore 且直接写 fixture 目录，不调用 host API/project lock；此条由本次代码审查确认，尚无自动化测试 — `decisions`（unpinned）
- [P4] 下一次真实 Chrome 验证的 `bsk_session` 次数、最长等待、fixture apply/restore 耗时被记录并与基线对照 — `decisions`（下一次运行前 unpinned；收口报告是证据）
