# Proposal: 评审按请求触发，每次新建独立 reviewer

Status: proposed
Date: 2026-11-07
Class: feature

## Problem

M4 的评审由交接触发：只要主题进入 `awaiting_review`，master 或主题调用 `cowork_review_request`，插件就新建一个 reviewer 会话，读最新交接并复跑命令。这带来四个问题：

1. **评审单位不清楚。** 交接是「一个主题本轮做完的事」，不是一次可复核的改动范围；同一主题多轮交接、多个执行单元、多个分支时，reviewer 不知道评哪一段。
2. **master 在链路中间。** 每次 verdict 都会 `prompt` master，`pass` 也发；master 既要接收，又要决定下一步。评审的机械推进不需要模型参与。
3. **reviewer 会话不回收。** 成功 verdict 后会话留在列表里；两个 case 就有两个常驻评审会话。
4. **成本与文档改动不匹配。** 文档改动也走完整 review；reviewer 冷启动读仓库、跑命令，成本接近主题本身。讨论中又确定了并行执行、子代理和 AgentTeams 的场景，需要明确的触发、范围和单一评审负责人。

本记录固定评审模型：单位是评审请求，触发是主题显式请求，执行是每次新建 reviewer，结果只回到插件与主题；详细字段与阶段见 [PLAN-V0.2 §2.2/§5.4](../../../../docs/PLAN-V0.2.md)。

## Proposal

**单位。** 评审单位是一次「评审请求」定义的改动范围，不是 thread、不是任务、也不是每次提交。请求写清楚：`purpose`、`baseCommit`、`headCommit`、`path`、`branch`、`changedPaths`、`verification`、`previousRequestId`、`notes`、`extra`。最小必需字段是 `purpose`、`baseCommit`、`headCommit`、`path`、`verification`；`extra` 允许模型增加预设外字段（最多 20 项，值有界），但插件的确定性检查只依赖最小集。

**触发。** 主题会话显式调用 `cowork_review_request`；master 不能调用，插件按角色拒绝。低频/低风险改动由分级规则决定是否建 reviewer；不让插件根据聊天内容猜「是否完成」。

**检查。** 插件在创建 reviewer 前做确定性检查：范围内有改动、`base` 是 `head` 的祖先、`path` 在仓库或该主题的隔离目录内、隔离目录工作区干净、`verification` 非空、没有同一主题的未决请求。任一不满足就返回明确错误，不创建 reviewer。

**执行。** 每次请求新建一个独立 reviewer 会话，不继承主题对话，不共享上下文；verdict 完成后归档。每次请求都新建，不复用旧会话；上一轮的请求文件、问题与修复情况通过 `previousRequestId` 和评审说明带过去。

**verdict。** reviewer 调用 `cowork_review_verdict({requestId, verdict, findings, verification})`；插件校验调用者必须是该请求登记的 `reviewerSessionId`。`needs_revision` 只把 findings 投回主题，不唤醒 master；`pass` 更新主题与交付确认，如需合并则写 master 收件箱；`reject` 置 `blocked` 并写收件箱。

**分级。** L0 讨论/调研不建评审会话；L1 文档/配置/单文件小改且已验证只保留机器检查与 handoff 记录；L2 公共接口、数据结构、迁移、安全、并发、跨模块、多分支合并、改动超阈值才建独立 reviewer；L3 破坏性迁移、发布、外部副作用由人批准，reviewer 不能替代。阈值与字段细节由 M10 实施，但分级本身是本决策的一部分。

**一个评审负责人。** 同一改动只保留一个最终评审负责人。AgentTeams 的内部 review 算团队自检；cowork reviewer 做最终评审；或者反过来采用 AgentTeams 的 verdict，不再重复评审。两层都全量评审会多花成本，并可能给出一致性冲突的结论。

**评审范围。** reviewer 只看请求范围、改动差异和证据，不重新探索整个仓库，不重跑全套测试。reviewer 不合并、不解决冲突、不修改代码；只读目前仍靠约定（KI-15），不是沙箱。

**用户手动 review。** 用户手动做过的 review 记为一次评审事件（`provenance=user`），不再为该次改动自动拉 reviewer；这条在 M10/M11 实施。

## Alternatives considered

**继续按 handoff 触发评审。** 否决：handoff 是主题本轮总结，不是可复核的改动范围；多轮交接、多执行单元时无法绑定 base/head；文档改动也走完整 review。评审请求能把范围绑定到提交与路径。

**master 创建并转发评审。** 否决：每次评审至少多两次 master 往返，主会话随事件增长；创建 reviewer 是固定动作，不应由模型决定。master 只保留合并/发布等例外决定。

**复用同一个 reviewer 会话做多轮评审。** 否决：重复使用会把上一轮上下文当成事实，影响新判断；用户已确认每次新建、用完回收。上一轮的问题通过请求记录传递，不靠会话记忆。

**按提交或每次改动评审。** 否决：一次任务可能有多个提交，一个提交可能只改一半；评审次数会失控。按请求定义的 base/head 范围才可复核。

**评审请求用完全自由 schema，由模型随意增删字段。** 否决：插件的确定性检查需要稳定的最小字段，UI 也需要可渲染的结构。采用固定最小集 + 可选字段 + `extra`，模型可以在 `extra` 和说明里补充，但不能删掉检查所需字段。

**让 reviewer 作为主题的子代理来做最终评审。** 否决：子代理挂在主题下面，独立性和上下文隔离弱于独立会话；适合日常/咨询性检查，不适合最终评审。插件能否编程创建子代理并拿到 session id 也尚未验证。

**两层都评审（AgentTeams 自检 + cowork 终评）。** 否决：成本翻倍且可能结论冲突；只保留一个最终负责人，另一层作为自检或输入。

## Acceptance criteria

- [A1] 评审请求按最小字段校验；缺少 `purpose/base/head/path/verification`、`base` 不是 `head` 祖先、路径越界、脏工作区都返回稳定错误，且不创建 reviewer — `tests`
- [A2] 每次请求新建 reviewer 会话；verdict 绑定 `requestId` 与 `reviewerSessionId`；verdict 后归档，不复用 — `tests`
- [A3] `needs_revision` 只投回主题，不 `prompt` master；`pass` 只有需要合并时才写收件箱；`reject` 置 blocked 并写收件箱 — `tests`
- [A4] 分级 L0–L3 生效；L0/L1 不建评审会话；L2 才建独立 reviewer；L3 由人批准 — `tests`
- [A5] AgentTeams 场景只保留一个评审负责人；该规则写进评审说明与文档，不在代码里重复评审 — `decisions`

## Risks

- reviewer 只读是约定，bash 仍可写（KI-15）。重审条件：review 变成对外信任边界，或观察到 reviewer 修改被审文件。
- 模型可以决定 `extra` 与说明，但不能删最小字段；如果模型反复遗漏必填，需要把错误文案与示例写进 persona。重审条件：真实会话里出现多次 `review/invalid`。
- 会话隐藏与回收依赖宿主 archive 行为；M6 必须验证 verdict 后归档不影响记录。归档失败时保留会话并记录，不假装成功。
- 评审请求的 `head` 在评审期间可能移动；请求绑定提交，合并前必须重新校验同一 `head`。重审条件：出现过期 verdict 被合并。
- 评审成本仍然存在；L2 的阈值需要真实数据校准。重审条件：评审会话数与 L2 请求数长期明显偏离，或文档改动仍被频繁评审。

## Delivery stages

- M6：探针确认 reviewer 隐藏/回收、`ctx.llm` 与 session event；写本记录与评审模型相关的决策记录。
- M10：实现评审请求、reviewer 生命周期、verdict 绑定、分级、归档。
- M11：面板显示评审卡、请求范围与 verdict，不显示 reviewer 列表行。
- M12：真实 E2E 验证请求→reviewer→verdict→收件箱/主题的完整链路。
