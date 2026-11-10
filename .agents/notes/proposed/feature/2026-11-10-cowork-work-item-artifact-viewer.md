# Proposal: Cowork 工作项页：多模态交付物查看器

Status: proposed
Date: 2026-11-10
Class: feature

Design approval: 2026-11-10（审批记录见 `docs/discussion/cowork-feature-todos.json`）。实现落地前，本记录保持 proposed。

## Problem

工作项不是代码分支、提交或合并的容器。用户需要查看、确认、反馈的是 PLAN、设计稿、架构图、Canvas、HTML demo、表格或文章；这些交付物通常带附件，需要在嵌入式查看器里批注、评论和实时讨论。

以分支/commit 为中心的工作项页会把代码管理操作放到主视图，无法承载多模态内容。

## Proposal

工作项页分两部分：

- 左侧主区域：工作项查看器。
  - 类型：PLAN/Markdown、设计稿、架构图、Canvas/Excalidraw、HTML demo/表格/文章。
  - 顶部显示标题、类型和状态；提供预览、评论、版本三类入口。
  - Canvas/文档上支持编号批注 pin；评论与附件一起归档。
  - 附件作为关键图稿展示，评论可附带图片或文本/Markdown 文件。
- 右侧工作项列表：
  - 只显示类型、状态、评论数、附件数、更新时间。
  - 状态：待查看 / 待确认 / 需反馈 / 进行中 / 已确认。
  - 不展示 branch、commit、merge、diff 等代码管理字段。

## Alternatives considered

**A. 保留分支/提交为中心的工作项页。** 它适合代码审阅，但用户明确要的是 PLAN、设计稿、架构图和 Canvas 等可批注交付物；代码管理操作会挤掉主内容。

**B. 只在右栏显示工作项摘要，不提供主区域查看器。** 摘要无法承载 Canvas 批注、附件预览和评论定位，用户仍需跳到别处。

**C. 把工作项做成普通文件列表。** 文件列表没有批注、版本和评论，无法表达“查看/确认/反馈”的协作状态。

## Acceptance criteria

- [A1] 主区域能打开 Canvas、Markdown、HTML 三类工作项并提供预览 — `source`
- [A2] Canvas 支持编号批注 pin，评论能定位到具体 pin — `source`
- [A3] 工作项列表只显示类型、状态、评论数、附件数和更新时间，不显示 branch/commit/merge — `source`
- [A4] 评论可以附带图片和文本/Markdown 文件 — `source`
- [A5] 378px 宽度下工作项列表可读 — `source`
- [A6] 客户端测试覆盖类型状态、评论/附件计数和无代码管理字段 — `tests`

## Risks

- 嵌入 HTML/Canvas 需要隔离和内容安全策略；实际编辑器实现不在本版本范围内。
- 附件上传需要限制类型、大小和数量，避免把工作项查看器变成不受控的文件区。
- “待确认/需反馈”与主题的审查状态容易混淆；工作项状态只表达交付物协作状态。

## Delivery stages

1. 工作项列表与状态模型 — 先做类型、状态和计数字段。
2. 主区域查看器 — 接入 Markdown/HTML/Canvas 预览、批注和附件。
3. 评论与附件 — 支持定位、上传和归档。
