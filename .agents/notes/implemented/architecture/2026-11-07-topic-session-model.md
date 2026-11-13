# Decision: 用主题会话取代 thread，master 只做决定

Status: implemented
Date: 2026-11-07
Class: architecture

## Problem

M4 的插件已经能在真实宿主上运行，但两次真实使用暴露了同一个结构问题：协议推进被做成了 master 的对话动作。每次交接和每次评审结论都会 `prompt` master，并留下完整文本；`cowork_project_status` 一次返回整个索引、所有 checkout 和所有最新评审。master 的内容随事件数量增长，而不是随用户交互增长。

同时，thread 被当成任务单位：每个任务新建会话，重复加载 preset、项目记忆和代码；`done` 被路由硬排除，同主题续做只能新开。界面又把 thread 和 reviewer 当普通会话平铺，两个使用 case 就留下 3 个主题会话和 2 个评审会话，用户注意力被分散。

这些问题的共同原因是角色边界不清：master 既做决定又做流程，thread 既是会话又是任务，reviewer 既做质量判断又被 master 调度。M4 之后的讨论已经确定：master 只做决定，插件推进流程，主题会话承载任务，reviewer 由评审请求触发。本记录固定这个角色模型，M6–M12 都以它为前提落地。详细架构与阶段见 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md)，V0.1 实现见 [PLAN V0.1](../../../../docs/PLAN.md) 与 [src/tools.ts](../../../../src/tools.ts)。

## Decision

**术语与载体。** 用「主题会话」取代 thread：一个主题一个普通 DSH 会话，由 `sessionController.create` 创建，用户可通过 CoWork 面板打开；主题不是任务，任务在主题内部以执行单元（子代理、AgentTeams 成员或直接对话）完成。旧 `thread` 只作为兼容名保留一个版本，代码与文档的新概念统一用 topic。

**四个角色。**

- master：项目级入口，负责接需求、定优先级、拆分主题、例外决定（合并、发布、阻塞、跨主题冲突）和对用户汇报。不创建或转发评审，不读代码、不跑测试、不维护每个主题的细节。
- 插件：维护主题三态与标记、路由、评审请求、reviewer 创建与回收、隔离目录、活动流、master 收件箱、记忆文件。插件只按规则执行，不做产品决定、不判断质量。
- 主题会话：一个主题的对话与执行入口；内部可以有多个执行单元；写摘要和证据；自己提交评审请求。不向其他主题发消息，不合并别人的分支。
- reviewer：按一次评审请求独立复核；给出通过、需要修改、驳回；不改代码、不合并、不解决冲突、不安排任务。

**master 的硬边界。** `cowork-master` preset 移除 `tool-fs`、`tool-fs-search`、`tool-bash`、`tool-jobs`、`present`，只保留 persona、agent-instructions、time-context、ask-user、todo。master 不能调用 `cowork_review_request`；插件在工具入口按会话 id 与索引记录拒绝。宿主另有 per-agent 工具策略：preset 行决定该会话注册哪些工具，`agent.ctx.tools.restrict({deny})` 可以再掩宿主全局工具与 preset 继承名，但不能掩该 agent 自身注册的工具（M6 探针 5，见 [M6 探针结果](../../../../docs/archived/results/M6_PROBE_RESULT.md) §5）。两层叠加可以掩蔽已知的全局工具，但需要逐个命名，且不是声明式白名单隔离；master 的工具入口校验继续保留。

**流程归属。** 主题完成或阻塞时写 `cowork_handoff({status:'done'|'blocked'})`；需要评审时由主题调用 `cowork_review_request`；插件做确定性检查后新建 reviewer；verdict 只回到插件和主题，只有需要 master 决定的事件才进入收件箱。master 不再逐条接收交接或评审全文。

**不再保留 thread 实体。** 不按任务新建会话；不设每任务生命周期；不做多段会话；不设独立的讨论型主题类。旧 `cowork_thread_*` 工具和 `cowork-thread` preset 只作为 `cowork_topic_*` / `cowork-topic` 的弃用别名保留一个版本，版本升到 `0.2.0`。

**界面位置由另一份记录拥有。** 主题会话不进左侧栏、CoWork 放右侧栏 tab、打开主题切换主区，这些交互决定见 [面板与会话可见性](../feature/2026-11-07-panel-and-session-visibility.md)，本记录只固定「主题是会话入口」这一点。

## Alternatives considered

**保留 thread 作为一等公民。** 否决：thread 同时承担会话和任务两个含义，导致每任务新建会话、done 不可续做、界面平铺；讨论中已经确认主题才是会话单位，任务只是主题内部的执行单元。

**master 继续编排评审与合并。** 否决：每次评审至少多两次 master 往返，主会话内容随事件线性增长；评审创建是固定动作，不需要模型判断。master 只保留合并、发布等例外决定。

**把任务拆成多个 thread，主题只做分组。** 否决：这会把生命周期重新拉回任务级；并行需求应由主题内的隔离工作项解决，而不是新建会话。相关决定见 [并行隔离与合并](2026-11-07-parallel-isolation-and-merge.md)。

**引入 AgentTeams 或其他多编排器运行时。** 否决：会与 cowork 抢 `sessionController`、`workspaceRegistry` 和子代理池；本插件只借 AgentTeams 的隔离与合并语义，不引入其运行时依赖。

**把讨论型任务单独成类。** 否决：评审已经改为由主题显式提交请求；讨论型主题不提交请求就不会触发评审或合并，不需要额外类型字段。

## Consequences

- profile 级全局工具仍对 master 可见；M6 已确认可用的 per-agent `restrict` 只能按名掩蔽继承工具，插件需要在 master 创建后按需 restrict，且不能掩 agent 自身注册的工具。重审条件：宿主提供声明式 per-agent 工具策略，或 master 再次调用宿主管理工具。
- 已存在的 `cowork-thread` 会话保留旧 preset 与旧提示词；新行为只对新会话生效，迁移期的说明由 README 与 M12 交接承担。
- 「主题」与旧文档中的 `thread` 并存一个版本；若文档混用，读者会误判当前模型。重审条件：`0.3.0` 移除别名时统一清理。
- 落地路径：M6 探针 5 已确认 master preset 去掉 fs/bash 仍工作、工具面 = preset 行 + 宿主全局、`restrict` 边界，探针 2/3 已确认会话事件与 archive 行为，结论见 [M6 探针结果](../../../../docs/archived/results/M6_PROBE_RESULT.md)；M7 落地 v2 索引与迁移；M9 落地 `cowork-topic` / `cowork-master` preset、工具别名与角色守卫（见 [M9 交付结果](../../../../docs/archived/results/M9_RESULT.md)）；M11 把主题作为会话入口接入面板（见 [M11 交付结果](../../../../docs/archived/results/M11_RESULT.md)）；M12 完成文档与真实 E2E 收口，版本 `0.2.0`。
- 本记录由 M12 从 `proposed/architecture/` 下的同名提案迁入 `implemented/architecture/` 并按 implemented 骨架重写；交付事实与证据见 [M9 交付结果](../../../../docs/archived/results/M9_RESULT.md) 与 [M11 交付结果](../../../../docs/archived/results/M11_RESULT.md)。

## Testing

- [A1] 一个主题只对应一个普通 DSH 会话；`cowork_topic_create` 创建、`cowork_route` 复用或新建，旧 `cowork_thread_*` 名称只作为别名返回同样结果 — `tests`：`tests/topic-tools.test.mjs`、`tests/route-tools.test.mjs`
- [A2] `cowork-master` preset 不再挂载 fs/search/bash/jobs/present；宿主全局工具按需用 per-agent `restrict` 掩蔽；master 调用 `cowork_review_request` 被拒绝 — `source`；`tests`：`tests/presets.test.mjs`、`tests/tool-model.test.mjs`
- [A3] 主题完成或阻塞只调用 `cowork_handoff`；评审由主题调用 `cowork_review_request`；master 不再逐条接收交接或评审全文 — `tests`：`tests/topic-tools.test.mjs`、`tests/review-request.test.mjs`
- [A4] 旧 thread 数据与会话可迁移为一个主题；`cowork-thread` preset 别名可用，新会话默认 `cowork-topic` — `tests`：`tests/store-v2.test.mjs`、`tests/presets.test.mjs`
- [A5] 本记录与 `docs/PLAN-V0.2.md` 的角色、边界、阶段一致；不新增第二份架构计划 — `decisions`：本记录、[PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §2.2/§5.3/§6
