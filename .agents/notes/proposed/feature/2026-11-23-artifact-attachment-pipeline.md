# Proposal: 工作项附件双向管线（cowork_artifact_attach）

Status: proposed
Date: 2026-11-23
Class: feature

## Problem

工作项附件当前是「用户上传单向」：字节唯一写入口是浏览器 `POST /api/cowork.artifact.upload`，`cowork_artifact_reply` 只接受已存 ref。模型无法把项目内新产出的文件登记为附件——它生成一张图表 PNG 或一份 JSON 后，只能靠用户再手动上传，才能出现在 thread 和附件页。这违背「模型回复可带图片/文件」的目标（[work-item-frontend.md](../../../../docs/design/work-item/work-item-frontend.md) §多模态与附件），也让模型产出的中间文件无法自动归档。

同时现状的 `attachmentCount` 在**上传时**计数，而附件页/线程只展示**被评论引用**的附件，两个口径不一致：用户上传后未提交评论的孤儿 upload 会被计数但不展示（[artifact-api.ts](../../../../src/panel/artifact-api.ts) `handleUpload` vs [viewer-side-tabs.tsx](../../../../src/client/work-item/viewer-side-tabs.tsx) `AttachmentsPanel`）。

用户已确认：模型可引用已有 `attachmentId` 或登记项目内 `sourcePath`；只允许项目内非凭据文件；v1 沿用现有类型白名单（png/jpeg/webp/gif + txt/md/markdown/csv/tsv/json，禁 SVG/HTML）；生成后自动展示、带「模型生成」标识、不要求二次确认；附件读取复用现有 attachment route，新增一个只发布已存字节的浏览器写路由；v1 不支持 PDF/DOCX/任意工作区文件。

## Proposal

新增 `cowork_artifact_attach` 工具，只接受 `sourcePath`（项目相对 POSIX），返回 `AttachmentRefV1` + `source:'model'`。模型引用已有上传仍走 `cowork_artifact_reply.attachments`，不在 attach 工具里重复 attachmentId 路径，避免把用户 upload 误标成模型生成。设计详见 [attachment-pipeline.md](../../../../docs/design/work-item/attachment-pipeline.md)。

- **三条发布路径**：模型 `sourcePath` 工具；浏览器 `POST /api/cowork.artifact.attach` 发布已上传字节（source=user，Markdown 粘贴图片也走这条）；用户评论/回复引用已上传 ref（source=user）。三条路径共用同一发布函数。
- **两条字节写入**：`sourcePath` 经 `normalizeArtifactPath`（词法）+ `resolveInsideRepo`（realpath + regular file，符号链接逃逸拒绝）+ `attachmentMediaType`（白名单 + 魔数/UTF-8）后 `saveUpload` 落盘；浏览器 attach 只接受已存 upload，不从浏览器读项目路径。
- **attach 随时，reply 仅 batch 内**：`cowork_artifact_attach` 不要求 in-flight dispatch（它只登记/发布，不关闭批次）；`cowork_artifact_reply` 保留 `inFlightFor` 校验（它关闭投递）。
- **发布即计数**：`attachmentCount` 改为「已发布附件数」；新增追加式 `attachments.jsonl` 作为发布清单与 `source:'user'|'model'` 来源事实源；孤儿 upload（只落盘未发布）不计数不展示，修正现状口径不一致。
- **幂等**：浏览器 attach 的 `attachmentId` 重入返回已有 ref 且不重复计数；`sourcePath` 每次 mint 新 id，不做 content-addressed 去重（同路径内容可变，按 sha 去重会静默返回旧附件）。
- **模型生成不可伪造**：`source:'model'` 只由工具路径写入；浏览器 attach、评论/回复引用都写 `source:'user'`。评论 `author` 与附件 `source` 都经 schema 校验。
- **展示**：附件页数据源从「评论引用」扩展为 `detail.publishedAttachments`；thread 内缩略图继续从评论 `attachments` 取；「模型生成」badge 由来源推导。`handleAttachment` 的查找从评论引用改为发布清单优先、旧记录回退评论引用。
- **图片预览**：弹层占满可用视口；宽图按宽度贴边、长图默认适合宽度并纵向滚动，普通图 contain 居中；可切「适应页面」、缩放/拖拽/Esc；细节见 [设计文档](../../../../docs/design/work-item/attachment-pipeline.md) §9.2。
- **端到端写文档**：模型生成图表/图片 → `cowork_artifact_attach(sourcePath)` → 在 Markdown 中写 `cowork-attachment://<attachmentId>` → 核对改动块 → `cowork_artifact_reply` 带同一 AttachmentRef。文档内不写绝对本地路径/`data:`/`blob:`；attach 失败不写坏链接，reply 失败不留假回复。完整时序见 [设计文档](../../../../docs/design/work-item/attachment-pipeline.md) §9.1。

## Alternatives considered

**扩展 `cowork_artifact_reply` 直收 `sourcePath`/bytes。** 否决：reply 已承担「关闭投递批次」职责并绑定 `inFlightFor`；把登记与回复耦合到同一个调用，会强迫模型在回复那一刻才能产出附件，无法在 thinking/working 阶段先产出图表再引用；bytes 直传还会绕过 sourcePath 的项目内/凭据校验边界，把路径安全与投递状态机搅在一起。拆成独立 `cowork_artifact_attach` 让「登记」与「回复」各司其职。

**外部媒体工具 + attach（用独立媒体 MCP/工具生成，再 attach 其结果）。** 否决：本仓库规则是「Local only、不引入多编排器」，且 v1 类型白名单只有图片与文本；外部媒体工具引入新依赖和新的字节来源，超出本页范围，无法复用 `saveUpload`/`attachmentMediaType` 的既有校验。模型用现有 `write`/编辑工具产出文件 + `attach(sourcePath)` 已覆盖需求，不额外承担媒体生成责任。

**仅浏览器上传（维持现状，模型只能引用已上传）。** 否决：这正是要解决的问题——模型生成的文件无法自动归档，只能靠用户二次上传；也保留「上传即计数」与「展示即引用」的口径不一致。该方案零成本但零收益。

## Acceptance criteria

- [A1] `cowork_artifact_attach` 工具存在：`artifactId` + `sourcePath`；返回 `AttachmentRefV1` + `source:'model'` + `published:true` — `source`
- [A2] `sourcePath` 逃逸（`..`/绝对路径/symlink 指向仓库外）、凭据文件、SVG/HTML/PDF/DOCX、超 5 MB、超 200 附件均被拒绝且返回稳定错误码 — `tests`
- [A3] 浏览器 `POST /api/cowork.artifact.attach` 发布已存 upload（source=user），同一 attachmentId 重入幂等不重复计数；`sourcePath` 重复 attach 得到新 id（不去重） — `tests`
- [A4] 孤儿 upload 不计数不展示；发布即计数，`detail.publishedAttachments` 与计数一致，刷新后仍在；`handleAttachment` 发布清单优先、旧记录回退评论引用 — `tests`
- [A5] `cowork_artifact_reply` 仍要求 in-flight batch；attach 不关闭批次 — `tests`
- [A6] 附件读取复用现有 attachment route，`nosniff` + `sandbox` + 从字节推导类型 — `tests`
- [A7] 附件页/thread 展示「模型生成」badge；预览弹层填满视口，宽图宽度贴边、长图默认适合宽度纵向滚动，可切适应页面，缩放/Esc/焦点返回正常；1280/1024/768/390 无横向滚动 — `browser`
- [A8] 设计文档与决策记录互相链接，demo HTML + 实际截图存在且可解码 — `plan-docs`
- [A9] 模型生成 PNG → attach → 文档插入 `cowork-attachment://` → WYSIWYG 渲染 → reply 缩略图 → 刷新保持；失败注入不产生坏链接或假回复 — `browser` + `tests`

## Risks

- 新记录 `attachmentCount` 是「已发布附件数」；旧记录无 `attachments.jsonl` 时附件页/读取回退到 comments 引用，不写盘、不做破坏性迁移；旧孤儿字节不可见。若需要统一旧计数，另开显式对账迁移，不在读取路径静默改写。
- 新增 `attachments.jsonl` 是无迁移的追加式文件，但引入第三个 JSONL 日志；若发现发布清单可完全由评论推导，可回退删除该文件。
- `cowork_artifact_attach` 是可选工具，模型可能不调用而仍只用 reply 引用已存 ref；生成即展示是增强路径，需真实模型 E2E 校验提示词。
- 预览弹层在宿主 `viewArea` 内的层级（composer 是 sibling）需真机验证，可能与设计假设不同。

## Delivery stages

1. **工具 + 存储** — `cowork_artifact_attach`、`attachments.jsonl`、发布即计数；单元与路由测试；模型生成图片→attach→Markdown URI 的最小时序。
2. **前端展示** — 附件页 `publishedAttachments`、模型生成 badge、文档内联图片、预览弹层；浏览器 lane。
3. **收口** — 真实模型 E2E 验证 attach 采用率、预览弹层层级、四档响应式；文档与截图同步。
