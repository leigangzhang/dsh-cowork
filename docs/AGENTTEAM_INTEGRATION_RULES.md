# AgentTeams 集成与 E2E 规则（项目级）

- 状态：生效（2026-11-06）。本文件是 [AGENTS.md](../AGENTS.md) 的扩展，适用于本仓库所有 AgentTeams 运行；队长在创建计划前读本文。它补充而不推翻 AgentTeams 协议/质量门禁；与用户明确指令冲突时按用户指令，并在任务描述里记录例外。
- 基线：M3 主会话 + 5 个子会话中，verifier 等待 **1,080.3s**（集成 marker 694.5s + E2E 385.8s），其中两次失败 E2E 占 301.5s。目标不是减少验证，而是减少排队、轮询、重复跑和失败重跑。

## R1 就绪是任务/事件，不是文件轮询

- 建一个 `integration-ready` 工作/构建门禁任务（不是质量模式里的 `integration` 质量任务）：合并 → build → inject/health → 写 marker，完成后 `send_message` 通知 verifier。
- `verification` / `review` 任务的 `dependencies` 必须包含 `integration-ready`；不要在集成 commit 可构建前启动 verifier。
- 禁止 10s 文件轮询；若必须轮询 marker，单次 ≤60s，并记录原因。
- 验收：verifier 的 marker 等待 ≤60s；任务图里能看到 `verification → integration-ready`。

## R2 真机 E2E 前先跑快速契约测试

- 对 review-request/verdict 竞态、旧 tool schema、client 缓存这类“真机才暴露”的问题，先写 host-free / fake-host 契约测试（确定性、无 LLM），绿了再跑真机 E2E。
- 同一种原因连续两次 E2E 失败 → 停止重跑，把失败固化成快速测试/断言，修好后再跑一次真机；失败尝试必须产出 finding + 回归测试。
- 真机 E2E 只保留最终一次通过；不重复同一形状。
- 验收：失败 E2E 重跑 0；最终真机 E2E 1 次通过。

## R3 一次集成门禁，验证者独立跑一次

- 每个实现任务只跑定向 verify；在 `integration-ready` 的候选 commit 上跑一次 `check/test/typecheck/build`（互不依赖的命令并行）。
- verifier 仍独立跑四命令 + 一次真机 E2E，实现者不自审；不要在每个 worktree、feature 分支、verifier 里重复全量。
- 队长独占合并；可以用 merge queue，但合并决策与最终质量门禁仍由队长负责。
- 验收：重复全量门禁 ≤1；预合并墙钟 <5m；四命令矩阵有记录。

## R4 暖构建、单次注入

- 增量构建；每个集成门禁只 inject/reload 一次；固定测试宿主/端口；用 health/ready 判断，不用反复 clean uninject→inject。
- 遇到旧 fiber：先记录证据；只在必要时 clean re-inject 一次，并记录原因。
- 验收：每门禁 inject ≤1；无 stale-fiber 重试；health 200。

## R5 E2E 按变更范围触发

- 文档-only 变更不跑真机 E2E；只有影响 review/merge/client/插件装载的代码变更才跑。
- E2E 状态用事件/终态通知，不用 10s 轮询；每步 fail-fast 超时；A/B thread 在安全时并行。
- 验收：docs-only 0 次 E2E；代码变更最终 1 次完整通过；轮询次数下降。

## R6 并行预检，串行合并

- 各实现任务的预检（定向测试、diff、健康）可并行；合并决策串行由队长执行，避免串行读/跑命令拖长门禁。
- 预合并能发现的问题在派发实现任务前用快速检查覆盖；预合并修复应在 `integration-ready` 前完成，不要夹在 verifier 等待中。
- 验收：预合并墙钟 <5m；无“verifier 等修复”的空白段。

## R7 记录与复盘

- 每次 AgentTeams 收口记录：`integration-ready` 开始/结束、marker 等待、E2E 尝试与耗时、四命令次数、inject 次数、失败原因。
- 若规则没有降低等待，保留旧流程并记录原因；不要为了指标伪造证据。
- 指标目标：verifier 等待 ≤300s（基线 1,080.3s；marker ≤60s、失败 E2E 0）；团队“等待/后台”≤800s（基线 1,453.6s）。

## 反模式

- verifier 在集成 commit 可构建前启动，靠 10s marker 轮询等 10 分钟。
- 每个 worktree/feature/verifier 都跑全量四命令，重复 3–4 次。
- 真机 E2E 失败后不改测试/代码，直接原样重跑。
- 文档-only 变更也跑完整 E2E。
- 每轮集成都 clean uninject→inject，或让旧 fiber 继续服务。
- 队长串行读文件/跑检查，把并行预检拖成串行门禁。

## DAG 模板（质量模式）

- requirements（可选）→ implementation / worktree
- `integration-ready`（work；deps 所有实现/预合并修复；verify：四命令 + build + inject + health；写 marker）
- `fast-contract`（work；可与 `integration-ready` 并行；只跑确定性测试）
- verification（verification；deps `integration-ready` + `fast-contract`）
- review（review；deps verification；`reviewedTaskId`=实现）
- repair（repair；deps review 失败）→ verification r2 → review r2
- 最终 integration（integration；deps 全部 review）——这是质量门禁里的集成，不是 `integration-ready`。
- 门禁生成的 repair/review 用可读 subject；质量任务写全 objective/acceptance/inScope/verify。

## 权威性

- 本文件由 AGENTS.md 的 AgentTeams 段落引用；队长建计划前读，成员任务描述里带“integration-ready 依赖 / 快速契约测试”要求。
- 与 profile 模板冲突时，以更具体的项目规则为准；与用户明确指令冲突时，按用户指令并记录例外。
- 推广到其他项目前先在本项目稳定运行两个阶段；再考虑提升到用户级 AGENTS 或 skill。
