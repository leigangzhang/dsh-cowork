# Decision: master 单入口、主题放 CoWork 右侧栏 tab

Status: implemented
Date: 2026-11-07
Class: feature

## Problem

M4 的侧栏把 master、thread、reviewer 都当普通会话平铺。两个使用 case 就留下 3 个主题会话和 2 个评审会话；用户要在会话列表里分辨哪个是主入口、哪个是任务、哪个是评审，注意力被分散。面板本身是一个右侧栏 tab，但还没有承担主题列表与活动流；打开 thread 只是普通会话切换，用户不清楚它和 master 的关系。

讨论中确定了目标交互：主题列表放右侧栏 CoWork tab，默认 tab 仍是普通会话；点开主题只切换主区，不叠在 master 上、不新开窗口；reviewer 不出现在列表；已解决主题仍可打开；面板提供打开、标记已解决、重新打开、改投等操作。详细阶段见 [PLAN-V0.2 §2.4/§5.9](../../../../docs/PLAN-V0.2.md)。

## Decision

**左侧栏。** M6 探针 3 已证明 archive 不是透明的「隐藏但可继续」：归档后 `prompt` 被接受，但 turn 以 `blocked` 结束、无 assistant 文本，归档期间消息不落盘；unarchive 后才恢复，且宿主没有 archive 之外的会话过滤/隐藏接口（见 [M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §3）。用户 2026-11-07 决定采用降级形态：主题会话保留在左侧栏、只隐藏 reviewer（**(b)**，理由与上限见 [会话可见性降级决策](2026-11-07-topic-visibility-fallback.md)）。M11 不再用 archive 隐藏主题；打开主题不需要 unarchive，仅当会话已被用户预先归档时先 unarchive（容错）。真实 Chrome 验证确认左侧栏条目由宿主维护，插件不新增/移除。

**右侧栏。** CoWork 是右侧栏的一个 tab；默认 tab 仍是普通会话；CoWork 不自动打开，用户通过 footer 入口或 guide 进入。tab 里是主题列表、主题详情和活动流（`src/client/panel.tsx`）。不另开独立浮窗，也不占用主区做满页面板。

**主区。** master 和主题都是独立的 DSH 会话，但主区同一时间只显示一个。点开主题是切换主区内容（`uiWorkspace.openSession(topicId)`），不是把主题叠在 master 上层；master 仍在左侧栏，点 master 或面包屑返回。主题会话不新开窗口，不改变右侧栏默认 tab（`src/client/model.ts` 的 `openTopicSteps` 钉住顺序）。

**reviewer。** reviewer 不出现在主题列表，也不出现在左侧栏；它作为一次评审请求的执行会话被创建，verdict 后归档（M6 探针 4：创建后立即归档会让 turn `blocked`）。评审结果以评审卡挂在主题详情，包含请求范围、verdict、findings、verification，数据来自 `reviews/<topicId>-<requestId>.json`（`GET /api/cowork.topic`）。宿主左侧栏仍可能看到 live reviewer，是接受的上限（KI-28）。

**面板操作。** 主题列表显示状态、标记、摘要、最近活动；详情显示摘要、工作项、评审请求、活动与操作。操作包括：打开主题、标记已解决、重新打开、移动到其他主题、复制路径。写操作走三条 `POST` 路由（`resolve`/`reopen`/`route.move`），请求体带当前 `sessionId`，只允许该项目的 master；沿用 loopback，并增加 `Origin`/`Host` 同源与 JSON content-type 检查（`src/api.ts`）。

**活动流。** 路由、状态、评审、合并、错误都写活动；面板读尾部（`GET /api/cowork.activity`，默认 50、上限 200）。流程事件不进 master 对话；master 只接收需要决定的事件。活动流在上限内保留，超出删最旧，不在 UI 里无限增长。

**不做的事。** 不做独立的 CoWork 浮窗；不做主区满页 master/主题同屏；不给 reviewer 列表行；不在打开主题时自动切换右侧栏；不隐藏已解决主题；不做多窗口布局。

## Alternatives considered

**主题继续放左侧栏，按 workspace 分组。** 设计阶段因注意力成本否决；M6 探针 3 证明 archive 后会话不能继续对话后，用户 2026-11-07 改采这一形态作为降级方案 (b)，理由与代价见 [决策记录](2026-11-07-topic-visibility-fallback.md)，本记录不再把它当作备选。

**做一个独立的 CoWork 浮窗/面板。** 否决：DSH 已有右侧栏 tab 机制，独立浮窗会增加窗口管理、主题 token 与打包复杂度；右侧栏 tab 已由 M3 证明可用，M11 沿用。

**主区同屏 master + 主题（分栏或标签）。** 否决：宿主主区同一时间只显示一个会话；强行分屏需要宿主持久化改动，超出插件能力，也不符合现有交互。M11 的真实 Chrome 验证也确认主区同一时间只有一个会话。

**reviewer 也作为列表行显示。** 否决：每评审一次多一行，注意力成本高；评审是过程，不是用户要长期浏览的会话。需要看细节时从评审卡打开。M11 只做到「面板不列 + verdict 后归档」，宿主侧栏不可控（KI-28）。

**打开主题时新开窗口或覆盖 master。** 否决：用户会失去 master 的位置；主区切换 + 面包屑返回更简单，也和宿主现有会话导航一致。

**把 CoWork 设为右侧栏默认 tab。** 否决：用户需要默认看到普通会话；CoWork 是备用入口，不应抢占默认位置。

**把已解决主题从面板隐藏。** 否决：已解决仍可打开、可重开；隐藏会使用户找不到历史主题。列表保留，用状态芯片区分来源（`user`/`master`）。

## Consequences

- **左侧栏没有达到「只留 master」。** 主题与 master 并列，注意力分散是已知代价；CoWork 的列表、状态芯片与面包屑承担可发现性。重审条件：宿主提供会话过滤/分组接口，或用户反馈侧栏噪音不可接受。
- **archive 不是隐藏。** 插件不对主题调用 `archiveSession`；`archiveSession(..., {stopActivity:true})` 只用于 reviewer 回收（verdict 之后），归档失败记录事实、不假装成功。用户手动归档主题后 `prompt` 会被 `blocked`；打开时容错 unarchive，打开状态下被归档会打断当前 turn，记录为限制，不做后台巡检。
- **打开主题只切主区。** 不新增/移除左侧栏条目、不新开窗口、不切右侧栏默认 tab；面包屑与左侧栏可回 master。已解决主题同样可打开，输入后回到 `active`（不提供撤销，重开是显式动作）。
- **右栏状态由宿主按会话记忆（M11 观察）。** 打开新主题后右栏可能关闭；这是宿主行为，不是插件调用（`docs/M11_RESULT.md` D8）。重开 footer 入口可恢复面板。
- **评审卡依赖请求文件。** 面板评审卡从 `reviews/*.json` 读取，legacy `latestReviewPath` 不再是当前状态来源；旧 review/handoff 文件只读。
- **写路由只允许 master。** 面板的打开以外动作都需要当前项目 master 的 `sessionId`；非 master 403，缺 content-type 415，坏 JSON 400，超 8 KiB 413，坏 Origin/Host 403。
- **M12 的可用性检查。** 主题数量增长后的列表/芯片可读性、移动端与多窗口不在 M11 范围，M12 做真实 E2E 与可用性检查；文档不得再写「主题会话隐藏」。

## Testing

- [A1] 左侧栏显示 master 与主题会话（决策 b），reviewer 不在 CoWork 列表；主题可从面板打开并继续对话，不需要 unarchive — `tests`：`tests/panel-model.test.mjs`（无 reviewer 行/主题行模型）与真实 Chrome 截图 01/05（`.dsh-cowork/e2e/m11/`）
- [A2] CoWork 是右侧栏 tab，默认 tab 仍是普通会话；CoWork 不自动打开；footer 入口可用 — `source`：`src/client/panel.tsx`、`src/client/index.tsx`；真实 Chrome 截图 01
- [A3] 打开主题只切换主区，不新增/移除左侧栏条目、不新开窗口；面包屑或左侧栏可回 master — `tests`：`tests/panel-model.test.mjs` 的 `openTopicSteps`；真实 Chrome 截图 05/06
- [A4] reviewer 不出现在列表；评审卡挂主题详情；verdict 后 reviewer 归档 — `tests`：`tests/panel-model.test.mjs`、`tests/api.test.mjs`（评审请求来自请求文件）；真实 Chrome 截图 01（评审卡）
- [A5] 面板写操作只允许 master，校验 session、同源与 content-type；活动流有上限 — `tests`：`tests/api.test.mjs`（403/415/400 与活动上限）；真实 Chrome 写路由 200/403/415/400（`docs/M11_RESULT.md` A4）
