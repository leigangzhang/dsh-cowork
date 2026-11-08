# Proposal: master 单入口、主题放 CoWork 右侧栏 tab

Status: proposed
Date: 2026-11-07
Class: feature

## Problem

M4 的侧栏把 master、thread、reviewer 都当普通会话平铺。两个使用 case 就留下 3 个主题会话和 2 个评审会话；用户要在会话列表里分辨哪个是主入口、哪个是任务、哪个是评审，注意力被分散。面板本身是一个右侧栏 tab，但还没有承担主题列表与活动流；打开 thread 只是普通会话切换，用户不清楚它和 master 的关系。

讨论中确定了目标交互：左侧栏只留 master；主题列表放右侧栏 CoWork tab，默认 tab 仍是普通会话；点开主题只切换主区，不叠在 master 上、不新开窗口；reviewer 不出现在列表；已解决主题仍可打开；面板提供打开、标记已解决、重新打开、改投等操作。详细阶段见 [PLAN-V0.2 §2.4/§5.9](../../../../docs/PLAN-V0.2.md)。

## Proposal

**左侧栏。** M6 探针 3 已证明 archive 不是透明的「隐藏但可继续」：归档后 `prompt` 被接受，但 turn 以 `blocked` 结束、无 assistant 文本，归档期间消息不落盘；unarchive 后才恢复，且宿主没有 archive 之外的会话过滤/隐藏接口（见 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §3）。用户 2026-11-07 决定采用降级形态：主题会话保留在左侧栏、只隐藏 reviewer（**(b)**），决定、代价与验收见 [会话可见性降级决策](2026-11-07-topic-visibility-fallback.md)。M11 不再用 archive 隐藏主题；打开主题不需要 unarchive（会话已被用户归档时先 unarchive，属容错）。真实 UI 点击与客户端 `clearArchivedCurrent` 的行为仍在 M11 验证。

**右侧栏。** CoWork 是右侧栏的一个 tab；默认 tab 仍是普通会话；CoWork 不自动打开，用户通过 footer 入口或 guide 进入。tab 里是主题列表、主题详情和活动流。不另开独立浮窗，也不占用主区做满页面板。

**主区。** master 和主题都是独立的 DSH 会话，但主区同一时间只显示一个。点开主题是切换主区内容，不是把主题叠在 master 上层；master 仍在左侧栏，点 master 或面包屑返回。主题会话不新开窗口，不改变右侧栏默认 tab。

**reviewer。** reviewer 不出现在主题列表，也不出现在左侧栏；它作为一次评审请求的执行会话被创建，verdict 后归档（M6 探针 4：创建后立即归档会让 turn `blocked`）。评审结果以评审卡挂在主题详情，包含请求范围、verdict、findings 与评审文件路径。

**面板操作。** 主题列表显示状态、标记、摘要、最近活动；详情显示摘要、工作项、评审请求、活动与操作。操作包括：打开主题、标记已解决、重新打开、移动到其他主题、复制路径。写操作走 `POST` 路由，请求体带当前 `sessionId`，只允许该项目的 master；沿用 loopback，并增加 `Origin`/`Host` 同源与 JSON content-type 检查。

**活动流。** 路由、状态、评审、合并、错误都写活动；面板读尾部。流程事件不进 master 对话；master 只接收需要决定的事件。活动流有上限，超出删最旧，不在 UI 里无限增长。

**不做的事。** 不做独立的 CoWork 浮窗；不做主区满页 master/主题同屏；不给 reviewer 列表行；不在打开主题时自动切换右侧栏；不隐藏已解决主题；不做多窗口布局。

## Alternatives considered

**主题继续放左侧栏，按 workspace 分组。** 设计阶段因注意力成本否决；M6 探针 3 证明 archive 后会话不能继续对话后，用户 2026-11-07 改采这一形态作为降级方案 (b)，理由与代价见 [决策记录](2026-11-07-topic-visibility-fallback.md)，本记录不再把它当作备选。

**做一个独立的 CoWork 浮窗/面板。** 否决：DSH 已有右侧栏 tab 机制，独立浮窗会增加窗口管理、主题 token 与打包复杂度；右侧栏 tab 已由 M3 证明可用。

**主区同屏 master + 主题（分栏或标签）。** 否决：宿主主区同一时间只显示一个会话；强行分屏需要宿主持久化改动，超出插件能力，也不符合现有交互。

**reviewer 也作为列表行显示。** 否决：每评审一次多一行，注意力成本高；评审是过程，不是用户要长期浏览的会话。需要看细节时从评审卡打开。

**打开主题时新开窗口或覆盖 master。** 否决：用户会失去 master 的位置；主区切换 + 面包屑返回更简单，也和宿主现有会话导航一致。

**把 CoWork 设为右侧栏默认 tab。** 否决：用户需要默认看到普通会话；CoWork 是备用入口，不应抢占默认位置。

**把已解决主题从面板隐藏。** 否决：已解决仍可打开、可重开；隐藏会使用户找不到历史主题。列表保留，用状态芯片区分。

## Acceptance criteria

- [A1] 左侧栏显示 master 与主题会话（决策 (b)），reviewer 不在列表；主题可从 CoWork 打开并继续对话，不需要 unarchive；限制写进文档 — `tests`
- [A2] CoWork 是右侧栏 tab，默认 tab 仍是普通会话；CoWork 不自动打开；footer 入口可用 — `source`
- [A3] 打开主题只切换主区，不新增/移除左侧栏条目、不新开窗口；面包屑或左侧栏可回 master — `tests`
- [A4] reviewer 不出现在列表；评审卡挂主题详情；verdict 后 reviewer 归档 — `tests`
- [A5] 面板写操作只允许 master，校验 session、同源与 content-type；活动流有上限 — `tests`

## Risks

- archive 只是展示过滤，不是隔离；被归档的会话仍可能被其他入口看到，且归档后不能继续对话。重审条件：宿主提供真正的会话过滤/分组接口。
- archive 后 `prompt` 已验证不可用（turn `blocked`、消息不落盘）；打开未归档主题不受影响。若用户手动归档某个主题，打开时先 unarchive（容错），打开状态下被归档则会打断当前 turn——记录为限制，见决策记录。
- 写路由的同源/CSRF 检查可能误伤正常面板请求；用真实 Chrome 验证，错误信息要可读。
- 面板重写范围大，可能超出 50 KiB 单文件预算；按 §4.2 拆分组件，先 API/类型后 UI。
- 主题在左侧栏与 master 并列，注意力分散是已知代价；CoWork 的列表、状态芯片与面包屑必须清楚，M12 做可用性检查。

## Delivery stages

- M6：探针 3 已确认 archive 后不能继续对话、没有替代过滤接口；探针 6 已确认面板写路由的同源检查；结论见 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §3/§6；可见性已由 2026-11-07 决策记录定为降级方案 (b)。
- M11：实现 v2 面板、主题列表/详情/活动、打开/已解决/重开/改投、reviewer 卡片。
- M12：真实 Chrome 验证与截图，文档写明降级代价（主题保留左侧栏）。
