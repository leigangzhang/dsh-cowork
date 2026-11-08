# AgentTeams 集成、质量门禁与 E2E 规则（项目级）

- 状态：生效（2026-11-08）。本文件是 [AGENTS.md](../AGENTS.md) 的扩展，适用于本仓库所有 AgentTeams 运行；队长在创建计划前读本文。它补充而不推翻 AgentTeams 协议/质量门禁；与用户明确指令冲突时按用户指令，并在任务描述里记录例外。
- 基线（M3）：verifier 等待 **1,080.3s**（集成 marker 694.5s + E2E 385.8s），其中两次失败 E2E 占 301.5s；同一轮浏览器 797.1s、面板 fixture 567.3s。目标不是减少验证，而是减少排队、轮询、重复跑和失败重跑。
- 本次调整依据（M7/M8/M9，2026-11-08）：任务数 20/10/23；功能完成后的质量尾部约 20/24/42 分钟。反复出现的问题是影响面遗漏、gate 未绑定产物、低风险 finding 微任务化、reviewer 无执行权、失败任务未闭环；以下规则据此收敛流程。

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
- **gate artifact**：首个 verification 记录 `git rev-parse HEAD`、`git diff <base>..HEAD | shasum -a 256`、`git status --porcelain`；同一 artifact 复用证据，产物变化才重跑。
- **reviewer 可执行**：reviewer 使用 `verify-only` 等带 bash 的只读策略，在隔离副本/工作树执行；不能执行时只能报“静态审查”，不得把 verifier 结果写成自己复跑。
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

## R6 预检影响面，并行写，串行合并

- 派单前扫描影响面：用 grep 查改动符号/常量/guard 引用的测试与配置，用 `wc -c` 检查文件预算；把必须同步修改的既有测试写入 inScope，禁止靠事后 amend 才发现。
- 并行写只在 base 验证通过后开始；每个写任务显式 `worktreePath`，`inScope` 用显式路径；合并由队长独占。
- 各实现任务的预检（定向测试、diff、健康）可并行；预合并修复应在 `integration-ready` 前完成，不要夹在 verifier 等待中。
- 验收：派单后无 inScope 外测试文件；预合并墙钟 <5m；无“verifier 等修复”的空白段。

## R7 记录与复盘

- 每次 AgentTeams 收口记录：`integration-ready` 开始/结束、marker 等待、E2E 尝试与耗时、四命令次数、inject 次数、artifact identity、失败原因。
- 若规则没有降低等待，保留旧流程并记录原因；不要为了指标伪造证据。
- 指标目标：verifier 等待 ≤300s（基线 1,080.3s；marker ≤60s、失败 E2E 0）；团队“等待/后台”≤800s（基线 1,453.6s）。
- 浏览器/面板验证目标：单次验证 `bsk_session` ≤10（基线 61）、无 >60s 的 sleep/API 等待；fixture apply/restore 各 ≤5s（基线离群 302.9/220.7s），真实数据 hash/线程数恢复。

## R8 浏览器验证：先修宿主，再动浏览器

- 开始前确认 health 200、`/api/cowork.overview` 200、BrowserSkill 扩展 connected；不满足先修宿主/clean inject，不要用重启浏览器掩盖后端故障。
- 每次验证复用一个长生命周期 session/tab；不要每步 stop/start；reload/extension 失败最多重开一次，并记录原因。
- 用专用小 profile/会话/测试 repo，不加载用户 1.2MB 的 session 列表和长 transcript；选择器优先 `data-testid`/稳定 CSS；目标移动时 sync 一次再点，不盲目重试。
- 截图是证据，不要反复 inspect 同一状态；结束主动 stop。
- 验收：单次验证 `bsk_session` ≤10（基线 61）、无 >60s 的 sleep/API 等待、截图齐全、结束 stop。

## R9 面板 fixture：隔离、原子、可恢复

- 不在宿主正在服务 panel 请求时直接改真实 `.dsh-cowork`；优先 fixture repo / 独立 DSH_HOME/profile/port，或先停宿主；否则 apply/restore 必须一次完成并校验 hash。
- fixture 脚本只写 fixture 数据目录，直接 fs 写入，不调用 host API、不等待 project lock；apply 前备份、restore 幂等；数据目录不写 Markdown（KI-13）。
- 302.9s/220.7s 的离群值是宿主 event loop/结果投递延迟，不是 fixture I/O；先修 health/API，再测 apply/restore。
- 验收：apply/restore 各 ≤5s（基线离群 302.9/220.7s）、真实 index 恢复（hash/线程数）、截图来自 fixture 视图。

## R10 收口顺序与交付任务

- 顺序：实现 → `integration-ready` → verification → review → **一次性批量修复所有 finding** + 文档/记录同步 → final integration → delivery。
- review 后的修复必须合并成批；行为变更才重跑全量 verify 和 review，纯注释/文档变更只跑 `npm run check`、对应定向测试和 delta review，不再逐条派生微任务。
- 代码冻结后不再接受功能性改动；最后一轮 `integration-ready` 之后只允许 docs/记录变更，docs-only 跑 `npm run check`，不重跑全量/E2E；若必须改行为，回到 `integration-ready` → verification → review。
- `delivery` 是显式任务：合并/推送/建 PR，记录最终 HEAD、artifact sha256、`git status`、分支/PR URL；不能只在聊天里说已完成。
- 任务板：质量任务写全 objective/acceptance；最终 integration 用 `kind=integration`，验证用 `verification`，不要用 `work` 代替；门禁生成的 repair/review 用可读 subject；failed 修复后用 `supersededBy` 或 output 收口。

## 反模式

- verifier 在集成 commit 可构建前启动，或靠 10s marker 轮询等待。
- 每个 worktree、feature 分支、verifier 都跑全量四命令。
- 真机 E2E 失败后不改代码/测试，直接原样重跑。
- 文档-only 变更跑完整 E2E。
- 每轮集成都 clean uninject→inject，或让旧 fiber 继续服务。
- 队长串行读文件/跑检查，把并行预检拖成串行门禁。
- reviewer 无执行能力，却把 verifier 结果写成自己复跑。
- 单条注释级 finding 派生 repair 任务并触发完整复审。
- failed 修复后不写 `supersededBy`/收口说明。

## DAG 模板（质量模式）

- impact-scan（work；grep 引用、测试、guard、字节预算）→ requirements（可选）→ implementation / worktree（并行写只在 base 验证后）
- `integration-ready`（work；deps 所有实现/预合并修复；verify：定向测试 + 四命令 + build + inject + health；写 marker + artifact identity）
- `fast-contract`（work；可与 `integration-ready` 并行；只跑确定性测试）
- verification（verification；deps `integration-ready` + `fast-contract`）
- review（review；deps verification；`reviewedTaskId`=实现；在隔离副本执行）
- batch-cleanup（repair；汇总所有 review finding + docs/记录；可读 subject）→ final integration（integration；行为变更才重跑全量，否则 `npm run check` + delta review）
- delivery（integration；deps final integration；merge/push/PR + 最终 HEAD/artifact/URL）
- 门禁生成的 repair/review 用可读 subject；质量任务写全 objective/acceptance/inScope/verify；review 通过前不进入 delivery。

## 权威性

- 本文件由 AGENTS.md 的 AgentTeams 段落引用；队长建计划前读，成员任务描述里带“integration-ready 依赖 / 快速契约测试”要求。
- 预定义 profile 只负责角色、模型档位、工具策略和短协议；DAG、artifact、收口和交付细节以本文件为准。
- 与 profile 模板冲突时，以更具体的项目规则为准；与用户明确指令冲突时，按用户指令并记录例外。
- 本文件先在本项目运行两个阶段；稳定后再考虑提升到用户级 P18，P18 只保留跨项目原则。
