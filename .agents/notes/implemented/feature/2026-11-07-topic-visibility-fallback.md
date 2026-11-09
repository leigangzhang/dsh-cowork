# Decision: M11 会话可见性采用降级方案：主题留在左侧栏

Status: implemented
Date: 2026-11-07
Class: feature

## Problem

M6 探针 3 在真实宿主上证明：`workspaceRegistry.archiveSession` 之后 `prompt` 虽然返回 `accepted:true`，但 turn 以 `blocked` 结束、没有 assistant 文本，归档期间的消息不落盘；`unarchiveSession` 后才恢复；宿主没有 archive 之外的会话过滤/隐藏接口（[M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §3）。这推翻了 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §2.4/§5.9「主题会话隐藏且仍可打开继续」的原假设，也让 §8「改用宿主过滤」的处理路径落空。

M11 只能在两条路里选：打开前 unarchive、离开再 archive 的可见性翻转；或计划 §8 已定义的降级——主题会话保留左侧栏、只隐藏 reviewer。2026-11-07 用户决定采用后者。本记录固定这个决定、它的代价与验收，避免实现阶段重新讨论可见性。

## Decision

**决定。** M11 采用降级方案 (b)：主题会话与 master 一样保留在左侧栏；reviewer 不出现在左侧栏与 CoWork 列表，评审结果只以评审卡挂在主题详情。CoWork 面板仍是主题列表、详情、活动与打开入口。PLAN-V0.2 §4.5 的会话表已按此修正（主题「左侧栏可见」、reviewer「隐藏；面板不列，verdict 后归档；宿主左侧栏可能仍可见（KI-28）」）。

**打开主题。** 用 `uiWorkspace.openSession(topicId)` 切换主区。主题会话没有被归档，所以不需要 unarchive。唯一例外：打开时发现该会话已被用户手动归档（或来自旧数据），M11 先 `unarchiveSession` 再打开；这是容错路径，不是常规流程（`src/client/model.ts` 的 `openTopicSteps` 固定 unarchive → openSession 的顺序）。真实 Chrome 只覆盖了未归档主题的主区切换；预归档路径由单测钉住（`docs/M11_RESULT.md` D4）。

**归档的使用边界。** 插件不用 `archiveSession` 隐藏主题。`archiveSession(..., { stopActivity: true })` 只用于 reviewer 回收（verdict 之后）；归档失败记录事实、不假装成功。M11 的真实 Chrome 验证确认左侧栏条目由宿主维护，插件的打开/操作不新增或移除条目。

**已解决主题。** 与普通主题一样留在左侧栏；CoWork 列表继续显示，用状态芯片区分 active/idle/resolved，并显示 `resolvedBy`（`user`/`master`）；用户打开并输入后回到 active，显式「重新打开」清空 `resolvedAt`/`resolvedBy`。不再有「已解决主题被隐藏」的表述。

**配置与计划表述。** 不引入 `visibility.mode`（没有 filter/archive 两档）；`reviewer.reclaim` 固定 `after-verdict`。PLAN-V0.2 的 §4.5 会话表由 M11 收口修正；§2.4/§5.9/§5.10/§6(M11/M12)/§8/§10.1 已按本决定书写。M6 探针结果 §9 与本记录互链。

**代价。** 左侧栏同时出现 master 与每个主题，注意力被分散；这与 V0.2「左侧栏只留 master」的原目标相反，是宿主能力限制下的已知取舍。可发现性由 CoWork 列表、状态芯片与面包屑承担，不假装主题被隐藏。

## Alternatives considered

**（a）打开前 unarchive、离开后重新 archive。** 否决（用户 2026-11-07 决定）：每次打开/离开要两次宿主调用；打开期间主题仍在左侧栏，等于暂时回到 (b)；`clearArchivedCurrent` 的 reconcile 竞态与「离开时忘记再 archive」让行为不确定，而 M11 没有可靠的生命周期钩子保证「离开」。

**等待宿主提供会话过滤接口。** 否决：M6 扫描 5 个宿主包、`hideSession` 类候选 0 命中；等待会把 M11/M12 拖成无期限。重估条件：宿主新增按会话过滤/分组的展示接口（KI-28 的重估条件）。

**主题放独立浮窗或主区满页面板。** 否决：主题是会话、CoWork 是右侧栏 tab 的设计已经确定；浮窗要额外窗口管理与打包成本，并偏离「主区同一时间一个会话」。

**reviewer 也保留在侧栏。** 否决：每次评审新建一个会话，保留会持续累积；verdict 后归档没有副作用（M6 探针 4 证明 verdict 后归档不影响已完成的工作）。M11 沿用 M10 的 verdict 后归档，面板不列 reviewer。

**把主题会话合并进 master。** 否决：与「一个主题一个会话、主题内可有多个执行单元」的架构记录冲突，已由该记录否决。

## Consequences

- **注意力成本**：左侧栏每个主题一行，主题多时会挤占 master。重审条件：用户反馈侧栏噪音不可接受，或宿主提供会话过滤/分组接口。
- **用户手动归档主题**：归档后 `prompt` 会被 blocked；本决定只在打开时容错 unarchive，用户若在打开状态下归档，当前 turn 会被打断。记录为限制，不做后台巡检。
- **已解决主题累积**：靠 CoWork 状态芯片与排序区分，不自动隐藏。重审条件：宿主提供折叠/分组。
- **reviewer 归档失败**：verdict 后归档失败会留下侧栏行；按 M10 规则记录并重试，不假装成功。
- **面板侧可见性的实现边界**：插件只能保证「CoWork/面板不列 reviewer」与「verdict 后归档」；宿主左侧栏的 live reviewer 仍可能可见（KI-28 接受上限），重估条件同上。
- **打开主题的宿主行为**：打开新主题后宿主可能关闭右栏（按会话记忆右栏状态）；这是宿主行为，不是插件调用，重开 footer 入口恢复面板（`docs/M11_RESULT.md` D8）。
- **与 M12 文档同步**：README、context、glossary 在 M12 按本决定改写；在此之前任何文档不得写「主题会话隐藏」。M11 已修正 PLAN §4.5 的会话表。

## Testing

- [A1] 左侧栏显示 master 与主题会话；reviewer 不出现在左侧栏与 CoWork 列表 — `tests`：`tests/panel-model.test.mjs`（列表模型无 reviewer 行）；真实 Chrome 截图 01（左侧栏与面板列表）
- [A2] 打开主题不调用 unarchive；仅当会话已被归档时先 unarchive 再打开 — `tests`：`tests/panel-model.test.mjs` 的 `openTopicSteps`（顺序与分支）
- [A3] 插件不用 archiveSession 隐藏主题；archiveSession 只出现在 reviewer 回收路径（verdict 后、`stopActivity:true`） — `source`：`src/session-visibility.ts` 与 `src/client/**`（打开路径不 archive）
- [A4] PLAN-V0.2 §4.5 会话表、M11_HANDOFF 指针按本决定更新；`npm run check` 通过 — `decisions`：`docs/PLAN-V0.2.md`、`docs/M11_HANDOFF.md`、`docs/M11_RESULT.md`
- [A5] M12 真实 E2E 覆盖「主题在左侧栏可见 → 经 CoWork 打开 → 对话」与「reviewer verdict 后归档」，不再验证隐藏 — `tests`：待 M12（`docs/KNOWN_ISSUES.md` KI-22/KI-28）
