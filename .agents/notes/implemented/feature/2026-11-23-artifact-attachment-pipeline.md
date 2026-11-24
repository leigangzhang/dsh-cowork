# Decision: 工作项附件双向管线（cowork_artifact_attach + attachments.jsonl）

Status: implemented
Date: 2026-11-23
Class: feature

## Problem

工作项附件当前是「用户上传单向」：字节唯一写入口是浏览器 `POST /api/cowork.artifact.upload`，`cowork_artifact_reply` 只接受已存 ref。模型无法把项目内新产出的文件登记为附件——它生成一张图表 PNG 或一份 JSON 后，只能靠用户再手动上传，才能出现在 thread 和附件页。这违背「模型回复可带图片/文件」的目标（[work-item-frontend.md](../../../../docs/design/work-item/work-item-frontend.md) §多模态与附件），也让模型产出的中间文件无法自动归档。

同时现状的 `attachmentCount` 在**上传时**计数，而附件页/线程只展示**被评论引用**的附件，两个口径不一致：用户上传后未提交评论的孤儿 upload 会被计数但不展示（[artifact-api.ts](../../../../src/panel/artifact-api.ts) `handleUpload` vs [viewer-side-tabs.tsx](../../../../src/client/work-item/viewer-side-tabs.tsx) `AttachmentsPanel`）。

用户已确认：模型可引用已有 `attachmentId` 或登记项目内 `sourcePath`；只允许项目内非凭据文件；v1 沿用现有类型白名单（png/jpeg/webp/gif + txt/md/markdown/csv/tsv/json，禁 SVG/HTML）；生成后自动展示、带「模型生成」标识、不要求二次确认；附件读取复用现有 attachment route，新增一个只发布已存字节的浏览器写路由；v1 不支持 PDF/DOCX/任意工作区文件。

## Decision

- **新增工具**：`cowork_artifact_attach` 在 `src/tools/artifact.ts` 注册，参数 `artifactId`（必填）、`sourcePath`（项目相对 POSIX，必填）与可选 `name`（展示名，缺省取 `sourcePath` 的 basename），角色 `master-or-thread`。返回 `{ ok: true, attachment: AttachmentRefV1, source: 'model', published: true, record: ArtifactSummaryV1 }`。它只登记/发布，不关闭投递批次，因此**不要求 in-flight dispatch**；模型引用用户已上传的附件仍走 `cowork_artifact_reply.attachments`，不在本工具里重复 `attachmentId` 路径。
- **两条字节来源**：`sourcePath` 先过 `normalizeArtifactPath`（相对路径、POSIX 分隔符、无空段/`.`/`..`、禁目录与凭据文件名），再由 `readBytesInsideRepo` 做 `realpath` 仓库内校验（解析后的路径重新过同一套禁入规则，拒绝符号链接逃逸）、`O_NOFOLLOW` 打开并在读取前检查大小；随后 `attachmentMediaType` 按扩展名白名单 + 图片魔数/UTF-8 校验，空文件拒绝。上限 `MAX_ARTIFACT_ATTACHMENT_BYTES` 5 MiB 与 `MAX_ARTIFACT_ATTACHMENTS` 200。浏览器 `POST /api/cowork.artifact.attach` 只发布已存 upload（`source: 'user'`），不从浏览器读项目路径；`POST /api/cowork.artifact.upload` 只落盘字节，不再计数。
- **单一发布事务**：`src/platform/artifact-runtime.ts` 的 `publishAttachmentUnlocked` 是 `attachmentCount` 唯一增长点，模型工具、浏览器 attach、评论与回复引用都走它；同一事务内写 record、追加 `attachments.jsonl` 行并追加 `artifact.updated` 事件。`AttachmentPublishV1` 行带 `source: 'user' | 'model'`，`source` 只由调用路径决定，不接受调用方字段。
- **幂等与去重**：浏览器 attach 对同一 `attachmentId` 重入返回已有行且 `published:false`，不重复计数；`sourcePath` 每次 mint 新 `attachmentId`（`attachment-<uuid>`），不做 content-addressed 去重——同一路径内容可变，按 sha 去重会静默返回旧附件。
- **发布即计数**：`attachmentCount` 是「已发布附件数」；`GET artifact.detail` 返回 `publishedAttachments`（按发布顺序，最多 200 行）；附件读取 `GET /api/cowork.artifact.attachment` 先查发布清单，无 `attachments.jsonl` 的旧记录回退评论引用（只读、不写盘、不改计数）；孤儿 upload 既不计数也读不到。附件仍只由存储字节推导 `content-type`、`nosniff`、`sandbox` CSP，文本/未知类型走 `attachment` disposition。
- **展示**：附件页数据源是 `detail.publishedAttachments`，按 `source` 推导「模型生成」badge；thread 内缩略图继续取评论 `attachments`；同一 `attachmentId` 无论被多少评论引用都只出现一行、只计一次。文档内联图片继续走 `cowork-attachment://<attachmentId>` 与同一读取路由。
- **预览弹层**：`src/client/work-item/attachment-preview.tsx` 的 provider 从附件页行与 thread 缩略图打开弹层；`attachment-preview-model.ts` 把附件分成 image/text/other 三类——图片按高度默认「适应页面」或长图「适合宽度」并可切换、缩放 10–400% 每次 10%、缩放/适应切换不重新取图；文本只读前 64 KiB 并提示截断；未知类型只提供下载。Esc、遮罩、关闭按钮三条路径都恢复触发点焦点，弹层填满可用视口并锁背景滚动；尺寸与响应式规格由 [attachment-pipeline.md](../../../../docs/design/work-item/attachment-pipeline.md) §9.2 拥有。
- **端到端写文档**：`cowork:annotation` 的静态规则要求模型生成文件后先 `cowork_artifact_attach`、再在 Markdown 写 `cowork-attachment://<attachmentId>`、最后用同一 ref 调 `cowork_artifact_reply`；禁止写本地绝对路径/`data:`/`blob:`。规则归属见 [annotation-prompt-ux 决策记录](2026-11-23-annotation-prompt-ux.md)。

## Alternatives considered

**扩展 `cowork_artifact_reply` 直收 `sourcePath`/bytes（否决）。** reply 已承担「关闭投递批次」职责并绑定 `inFlightFor`；把登记与回复耦合会强迫模型在回复那一刻才能产出附件，无法在 thinking/working 阶段先产出图表再引用；bytes 直传还会绕过路径安全与投递状态机。拆成独立工具后「登记」与「回复」各司其职，模型可在任意时刻 attach，reply 仍只负责关闭批次。

**外部媒体工具 + attach（否决）。** 本仓库规则是「Local only、不引入多编排器」，且 v1 类型白名单只有图片与文本；外部媒体工具引入新依赖与新的字节来源，无法复用 `saveUpload`/`attachmentMediaType` 的既有校验。模型用现有 `write`/编辑工具产出文件再 attach 已覆盖需求。

**仅浏览器上传（维持现状，否决）。** 这正是要解决的问题——模型生成的文件无法自动归档，只能靠用户二次上传；也保留「上传即计数」与「展示即引用」的口径不一致。该方案零成本但零收益。

**按内容 sha 去重（否决）。** 同一 `sourcePath` 的内容可变，按 sha 去重会在重新生成同名图表时静默返回旧图片；按路径去重同样错误。选择每次 attach 都 mint 新 id，由调用方引用正确的那一个。

## Consequences

- `attachmentCount` 的语义变了：新记录是「已发布附件数」，上传后未发布（浏览器没有 attach、也没有评论/回复引用）的字节不计数、不展示、读不到。旧记录没有 `attachments.jsonl` 时按评论引用派生出只读清单，不写盘、不做破坏性迁移；旧孤儿字节保持不可见，需要统一旧计数时另开显式对账迁移。
- 新增第三个追加式 JSONL 日志 `attachments.jsonl`。它是发布清单、计数与「模型生成」来源的事实源，评论引用没有可靠的 `source`，所以不能只靠评论推导；若未来发布清单能完全由其他事实推导，可回退删除该文件。
- `sourcePath` attach 不去重：同一文件重复 attach 会产生多行、多计数，直到 200 上限；调用方应对同一批产物只 attach 一次。
- 孤儿 upload 的 200 条存储封顶在上传路由、`saveUpload` 写锁外检查：极端并发下同一工作项的上传可同时通过检查，短暂超出上限最多 N 条（N 为同时通过检查的请求数），后续上传或重试即按新计数恢复拒绝；已发布附件计数仍由锁内发布事务精确封顶。见 [attachment-pipeline.md](../../../../docs/design/work-item/attachment-pipeline.md) §7。
- 类型白名单仍是图片四类与文本六类；SVG/HTML/PDF/DOCX、任意二进制与拒绝名单路径都被挡下。项目内相对图片仍不能预览（KI-64），模型必须 attach 后改用 `cowork-attachment://`。附件没有删除/重命名（KI-55），发布行只追加。
- `cowork_artifact_attach` 是可选工具：模型可以不调用而只用 reply 引用已有附件，生成即展示是增强路径而非强制。keyless E2E 用脚本模型固定调用它来证明工具与路由链路；真实模型采用率只在观测性的 live lane（需要 `DEEPSEEK_API_KEY`，不产出发布证据）里可见，不在本决策证据内。
- 浏览器 lane 的「模型生成」附件行来自 fixture 写入的发布清单，不是模型调用；脚本 provider 只回文本。因此模型生成 → 登记 → 展示的每一段都有证据，但整链由两段拼成：keyless E2E 证明工具与发布，浏览器 lane 证明展示与预览。
- 预览弹层在 390px 的「指针打开」未验证：浏览器 lane 为绕过宿主窄屏壳层，先在 1440 打开再缩到 390 测公式、遮挡与页脚位置；弹层层级在运行宿主 `viewArea` 内验证过遮罩覆盖与背景滚动锁，其他宿主的 composer sibling 层级未核对。
- 回滚：删掉 `cowork_artifact_attach` 工具与浏览器 attach 路由，附件页数据源退回评论引用即可恢复旧展示；`attachments.jsonl` 行留在磁盘上不参与读取，不做迁移删除。
- 重估条件：需要附件删除/重命名/版本化，或范围扩到 PDF/DOCX 与任意工作区文件时，另开工作流；模型采用率长期为零时，重评提示词与工具位置。

## Testing

- [A1] `cowork_artifact_attach` 声明 `artifactId`/`sourcePath`/`name` 三参数，成功返回 `AttachmentRefV1` + `source:'model'` + `published:true` — `source`
- [A2] `sourcePath` 的 `..`/绝对路径/反斜杠/凭据名、symlink 指向仓库外、非法目标、SVG/HTML/PDF/DOCX、扩展名与字节不符、空文件、超 5 MiB、超 200 附件都被拒绝且给出稳定错误码 — `tests`
- [A3] 浏览器 attach 发布已存 upload（`source:'user'`），同一 `attachmentId` 重入幂等不重复计数；同一 `sourcePath` 重复 attach 得到新 id — `tests`
- [A4] 孤儿 upload 不计数不展示也读不到；发布即计数，`detail.publishedAttachments` 与计数一致且刷新后仍在；`handleAttachment` 发布清单优先、旧记录回退评论引用 — `tests`
- [A5] `cowork_artifact_reply` 仍要求 in-flight batch（无批次时报 `artifact/dispatch-not-found`）；`cowork_artifact_attach` 不需要批次也不关闭批次 — `tests`
- [A6] 附件读取复用现有 attachment route，`nosniff` + `sandbox` CSP + 从字节推导类型与 disposition — `tests`
- [A7] 附件页/thread 展示「模型生成」badge；预览弹层填满视口、宽图贴边、长图默认适合宽度并纵向滚动、适应切换不重新取图、缩放与 Esc/遮罩关闭及焦点返回正常；1280/1024/768/390 无横向滚动 — `browser`
- [A8] 设计文档、决策记录与 demo HTML/截图互链且可解码，`npm run check` 通过 — `plan-docs`
- [A9] 脚本模型端到端：模型产出 PNG → `cowork_artifact_attach` → detail 列出模型来源附件 → 评论引用同一 ref 仍只计一次 → 附件路由可读字节；浏览器 lane 另证 fixture 文档的 `cowork-attachment://` 渲染与失败占位 — `e2e` + `browser` + `tests`
