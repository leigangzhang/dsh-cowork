# Decision: 评审按请求触发，每次新建独立 reviewer

Status: implemented
Date: 2026-11-07
Class: feature

## Problem

M4 的评审由交接触发：只要主题进入 `awaiting_review`，master 或主题调用 `cowork_review_request`，插件就新建一个 reviewer 会话，读最新交接并复跑命令。这带来四个问题：

1. **评审单位不清楚。** 交接是「一个主题本轮做完的事」，不是一次可复核的改动范围；同一主题多轮交接、多个执行单元、多个分支时，reviewer 不知道评哪一段。
2. **master 在链路中间。** 每次 verdict 都会 `prompt` master，`pass` 也发；master 既要接收，又要决定下一步。评审的机械推进不需要模型参与。
3. **reviewer 会话不回收。** 成功 verdict 后会话留在列表里；两个 case 就有两个常驻评审会话。
4. **成本与文档改动不匹配。** 文档改动也走完整 review；reviewer 冷启动读仓库、跑命令，成本接近主题本身。讨论中又确定了并行执行、子代理和 AgentTeams 的场景，需要明确的触发、范围和单一评审负责人。

本记录固定评审模型：单位是评审请求，触发是主题显式请求，执行是每次新建 reviewer，结果只回到插件与主题；详细字段与阶段见 [PLAN-V0.2 §2.2/§5.4](../../../../docs/PLAN-V0.2.md)。

## Decision

**单位。** 评审单位是一次「评审请求」定义的改动范围，不是 topic、不是任务、也不是每次提交。请求记录 `ReviewRequestRecord`（`src/review-request.ts`）写清楚：`purpose`、`baseCommit`、`headCommit`、`path`、`branch`、`changedPaths`、`verification`、`previousRequestId`、`notes`、`extra`。最小必需字段是 `purpose`、`baseCommit`、`headCommit`、`path`、`verification`；`extra` 允许模型增加预设外字段（最多 20 项、值有界）；`changedPaths` 由 `git diff --name-only base..head` 派生，模型传入的值必须与派生结果一致。请求文件是 `.dsh-cowork/reviews/<topicId>-<requestId>.json`，`requestId` 由插件生成；旧 verdict-only 文件保留只读，新代码不读它们作为当前状态。

**触发。** 主题会话显式调用 `cowork_review_request`；master 调用会被角色校验拒绝。插件不根据聊天内容猜「是否完成」，也不做风险分级（见 Consequences）。

**检查。** 插件在创建 reviewer 前做确定性检查：`base` 是 `head` 的祖先且两者不同、`path` 是仓库根或该主题的工作项目录（canonical 路径校验）、工作区干净、`git diff` 非空且与 `changedPaths` 一致、同一主题与工作项没有未决请求、`previousRequestId` 存在且已终结。任一不满足返回稳定错误码，`review-tools.ts` 在这些检查之前不创建 reviewer、不写文件、不写索引。

**执行。** 每次请求新建一个独立 reviewer 会话（`cowork-reviewer` 预设），不继承主题对话；`session-visibility.ts` 负责创建与归档。请求写入后索引置 `awaitingReview=true`、`reviewStatus='pending'`、`latestReviewRequestId`、`reviewerSessionId`，然后投递 brief（范围、证据、上一轮）。任何一步失败按「请求文件 → 索引 → reviewer 归档」回滚并写 `error` 活动。verdict 完成后归档 reviewer（`stopActivity:true`）；归档失败保留会话并记录，不把 verdict 变成失败。M6 探针 4 证明创建后立即归档会让 turn 以 `blocked` 结束，因此禁止创建后立即归档（[M6 探针结果](../../../../docs/archived/results/M6_PROBE_RESULT.md) §4）。

**verdict。** reviewer 调用 `cowork_review_verdict({requestId, verdict, findings, verification})`；插件校验调用者必须是该请求登记的 `reviewerSessionId`，且一个请求只接受一次 verdict。verdict 先写入请求文件，再更新 canonical 索引与主题/工作项。`needs_revision` 只把 findings 投回主题，不唤醒 master；`pass` 在工作项需要合并时写 `merge-needed` 收件箱；`reject` 置 `blocked` 并写 `review-reject` 收件箱。索引写失败时已落盘的 verdict 保留并报告。

**一个评审负责人。** 同一改动只保留一个最终评审负责人。AgentTeams 的内部 review 算团队自检；cowork reviewer 做最终评审；或者反过来采用 AgentTeams 的 verdict，不再重复评审。

**评审范围。** reviewer 只看请求范围、改动差异和证据，不重新探索整个仓库，不重跑全套测试；persona 明确要求不读 handoff 全文。reviewer 不合并、不解决冲突、不修改代码；只读目前仍靠约定（KI-15），不是沙箱。

## Alternatives considered

**继续按 handoff 触发评审。** 否决：handoff 是主题本轮总结，不是可复核的改动范围；多轮交接、多执行单元时无法绑定 base/head；文档改动也走完整 review。评审请求能把范围绑定到提交与路径。

**master 创建并转发评审。** 否决：每次评审至少多两次 master 往返，主会话随事件增长；创建 reviewer 是固定动作，不应由模型决定。master 只保留合并/发布等例外决定。

**复用同一个 reviewer 会话做多轮评审。** 否决：重复使用会把上一轮上下文当成事实，影响新判断；用户已确认每次新建、用完回收。上一轮的问题通过请求记录传递，不靠会话记忆。

**按提交或每次改动评审。** 否决：一次任务可能有多个提交，一个提交可能只改一半；评审次数会失控。按请求定义的 base/head 范围才可复核。

**评审请求用完全自由 schema，由模型随意增删字段。** 否决：插件的确定性检查需要稳定的最小字段，UI 也需要可渲染的结构。采用固定最小集 + 可选字段 + `extra`，模型可以在 `extra` 和说明里补充，但不能删掉检查所需字段。

**让 reviewer 作为主题的子代理来做最终评审。** 否决：子代理挂在主题下面，独立性和上下文隔离弱于独立会话；适合日常/咨询性检查，不适合最终评审。插件能否编程创建子代理并拿到 session id 也尚未验证。

**两层都评审（AgentTeams 自检 + cowork 终评）。** 否决：成本翻倍且可能结论冲突；只保留一个最终负责人，另一层作为自检或输入。

## Consequences

- reviewer 只读是约定，bash 仍可写（KI-15）。重审条件：review 变成对外信任边界，或观察到 reviewer 修改被审文件。
- 模型可以决定 `extra` 与说明，但不能删最小字段；如果模型反复遗漏必填，需要把错误文案与示例写进 persona。重审条件：真实会话里出现多次 `review/request-invalid`。
- 会话隐藏与回收依赖宿主 archive 行为；verdict 后归档正常、创建后立即归档会 `blocked`（M6 探针 4）。归档失败时保留会话并记录，不假装成功。
- 评审请求的 `head` 在评审期间可能移动；请求绑定提交，合并前重新校验同一 `head`。重审条件：出现过期 verdict 被合并。
- **分级（L0–L3）与用户手动评审 provenance 没有实现。** 原提案把风险分级当作决策的一部分，但 PLAN-V0.2 §5.4 没有分级要求，M10 的验收也不含分级；插件当前只实现「主题显式请求 → 建 reviewer」这一条路径，不按风险跳过或升级评审，也不记录用户手动 review 事件。需要时写新记录落地（[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) KI-30）。
- 评审成本仍然存在；L2 阈值需要真实数据校准。重审条件：评审会话数与请求数长期明显偏离，或文档改动仍被频繁评审。
- 旧 review 文件与新请求文件同目录：新代码不写 `latestReviewPath`/`reviewRequestedAt`/`reviewedAt`，`src/api.ts` 仍读 legacy 字段；M11 面板切到请求文件（KI-18）。
- 本记录取代原 `proposed/feature/2026-11-07-review-request-model.md`；实现与证据见 [M10 交付结果](../../../../docs/archived/results/M10_RESULT.md)。

## Testing

- [A1] 评审请求按最小字段校验；缺少 `purpose/base/head/path/verification`、`base` 不是 `head` 祖先、`base=head`、路径越界、脏工作区、空 diff、`changedPaths` 不一致、重复 pending 都返回稳定错误，且不创建 reviewer、不写文件/索引 — `tests`：`tests/review-request.test.mjs`（`a complete request validates and keeps every field`、`purpose, base, head, path, and verification are required`、`base and head must name different commits and stable commit ids`、`the path must stay inside the repository or the work-item checkout`、`each merge-gate refusal carries its stable code and a message`、`every failed pre-check leaves no reviewer, no file, and no index change`、`a second pending request for the same topic and work item is refused`、`the previous request must exist, belong to the same chain, and be answered`）
- [A2] 每次请求新建 reviewer 并由 `reviewerSessionId` 绑定；brief 失败按「请求文件 → 索引 → reviewer」回滚；verdict 后归档且不立即归档、不复用 — `tests`：`tests/review-request.test.mjs`（`a shared-tree request writes the pending file, the index, and the brief`、`a brief failure rolls the request back in order and records it`、`an index write failure archives the reviewer and removes the file`）、`tests/session-visibility.test.mjs`（`the reviewer session is created with the reviewer preset and its id`、`after a verdict the reviewer is archived with stopActivity`、`an archive failure is reported and never throws or drops the verdict`）
- [A3] `needs_revision` 只投回主题，不 `prompt` master；`pass` 只有需要合并时才写收件箱；`reject` 置 blocked 并写收件箱；verdict 绑定 requestId 与 reviewerSessionId、一次生效 — `tests`：`tests/review-verdict.test.mjs`（`a pass verdict with a work item records, merges, and archives`、`a pass verdict on a shared work tree wakes nobody and writes no inbox`、`needs_revision goes back to the topic only, never to the master`、`a reject verdict blocks the topic and wakes the master`、`only the recorded reviewer may answer the request`、`a request accepts exactly one verdict`、`a failed inbox delivery keeps the item undelivered and reports it`）
- [A4] L0–L3 分级与用户手动评审 provenance 未落地 — `decisions`：本记录 Consequences 与 [KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) KI-30 记录未实现原因与归属（M11/M12）
- [A5] AgentTeams 场景只保留一个评审负责人；规则写进评审说明与文档，不在代码里重复评审 — `decisions`：本记录、[M10 交付结果](../../../../docs/archived/results/M10_RESULT.md)、[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md)
