# Cowork 工作项附件双向管线设计

Status: proposed（2026-11-23；决策记录见 [2026-11-23-artifact-attachment-pipeline](../../../.agents/notes/proposed/feature/2026-11-23-artifact-attachment-pipeline.md)）

本文是工作项「附件双向管线」的详细设计：模型如何生成/登记附件、用户如何上传附件、两者如何在 thread 与附件页展示、以及预览弹层与安全边界。它建立在三份已有设计之上，只写本页增量，不复制大段：

- 后端路由、存储与投递：[work-item-backend.md](work-item-backend.md)
- 前端模块、数据契约与多模态：[work-item-frontend.md](work-item-frontend.md)
- 查看器页面结构与附件交互：[work-item-artifact-viewer.md](work-item-artifact-viewer.md)
- 共享视觉与像素验收基线：[visual-acceptance.md](visual-acceptance.md)

## 1. 现状

- 附件字节唯一写入口是浏览器 `POST /api/cowork.artifact.upload`（[artifact-api.ts](../../../src/panel/artifact-api.ts) `handleUpload`）：流式 body 落盘到 `<repo>/.dsh-cowork/artifacts/<id>/uploads/<attachmentId>`，校验后返回 `AttachmentRefV1`，并立即 `attachmentCount + 1`。
- `cowork_artifact_reply` 只接受已存 ref（[artifact.ts](../../../src/tools/artifact.ts)）：模型只能引用已上传的 `attachmentId`，不能登记项目内新文件为附件。
- 类型白名单由 [attachments.ts](../../../src/domains/artifact/attachments.ts) 的 `attachmentMediaType` 固定：图片 `png/jpeg/webp/gif`（魔数校验，SVG 故意不在内）+ 文本 `txt/md/markdown/csv/tsv/json`（UTF-8 校验）；SVG/HTML 被拒绝。
- 附件 serving 由 `GET /api/cowork.artifact.attachment`（`handleAttachment`）提供：从字节推导 `content-type`、`sandbox` CSP、`nosniff`，文本/未知类型走 `attachment` disposition。
- 现状缺口：`attachmentCount` 在**上传时**计数，而附件页/线程只展示**被评论引用**的附件。两者口径不一致——上传后未提交评论的孤儿 upload 会被计数但不展示。

## 2. 目标

- 新增 `cowork_artifact_attach` 工具：模型可引用已有 `attachmentId`，或登记项目内 `sourcePath` 为附件。
- 用户上传与模型生成两条路径最终都落到同一 `uploads/` 字节库与同一附件列表。
- 生成后自动展示，带「模型生成」标识；不要求二次确认。
- 附件展示、预览弹层、失败/空态对齐共享视觉基线。

## 3. 非目标

- 不新增读取路由：附件读取继续用 `GET /api/cowork.artifact.attachment`，但其查找从「评论引用」扩展为「发布清单 + 旧评论回退」。新增一个浏览器写路由 `POST /api/cowork.artifact.attach`，只负责把已上传字节发布为附件（图片粘贴/独立附件用），不读取字节。
- v1 不支持 PDF/DOCX/任意工作区文件：类型白名单沿用现状。
- 不做附件删除、重命名、跨工作项移动、版本化。
- 不改旧 `workItems`、不改 index v2、不改 SSE 事件类型集合。
- 不做 content-addressed 去重（见 §6）。

## 4. 工具契约 `cowork_artifact_attach`

```ts
cowork_artifact_attach {
  artifactId: string   // required
  sourcePath: string   // 项目相对 POSIX；模型生成的图表/文件路径
  name?: string        // 可选展示名；缺省取 sourcePath basename
}
```

- 只接受模型生成/登记的项目内文件；模型引用用户已上传附件继续走 `cowork_artifact_reply.attachments`，不在本工具里重复一套 attachmentId 路径，避免把用户 upload 误标成 `source:'model'`。
- 角色：`master-or-thread`，与 `cowork_artifact_create/comments/reply` 一致；校验 `artifact.ownerSessionId` 或 master。

### 4.1 返回

```ts
// 成功
{ ok: true, attachment: AttachmentRefV1, source: 'model', published: true,
  record: ArtifactSummaryV1 }
```

- `attachment` 的 `mediaType/size/sha256` 一律从**存储字节**重推导（`attachmentMediaType` + `sha256HexBytes`），不信任工具参数。
- `source` 恒为 `'model'`：该工具只能由模型调用，用户无法伪造。
- `published` 首次发布为 `true`；同一 sourcePath 再次 attach 会 mint 新 id，也返回 `published:true`。浏览器 `attachmentId` 重入才走幂等分支（§4.4）。

### 4.2 错误码

复用 [artifact-contract.ts](../../../src/panel/artifact-contract.ts) 的 `ARTIFACT_ERROR_CODES` 与 `ARTIFACT_ERROR_STATUS`，不新增码：

| 场景 | 错误码 | HTTP |
|---|---|---|
| artifact 不存在 / 非本项目 | `artifact/not-found` | 404 |
| 角色不符 | `role/forbidden` | 403 |
| sourcePath 词法越界 / 凭据 / 非 POSIX | `artifact/path-not-allowed` | 400 |
| sourcePath 不存在 | `artifact/file-missing` | 404 |
| sourcePath 非 regular file / 符号链接逃逸 | `artifact/path-not-allowed` | 400 |
| 超过 5 MB | `artifact/file-too-large` | 413 |
| 类型不在白名单（含 SVG/HTML/PDF/DOCX） | `artifact/upload-invalid` | 400 |
| 附件数达上限 | `artifact/limit-reached` | 409 |
| 浏览器 attach 的 attachmentId 不存在于本工作项 | `artifact/upload-invalid` | 400 |
| 无 artifact runtime | `artifact/fs-unavailable` | 501 |

### 4.3 上限与幂等

- 单附件 ≤ `MAX_ARTIFACT_ATTACHMENT_BYTES`（5 MB）；每工作项 ≤ `MAX_ARTIFACT_ATTACHMENTS`（200）；单评论/回复引用 ≤ `MAX_ARTIFACT_ATTACHMENTS_PER_COMMENT`（5）。
- `sourcePath` 每次 mint 新 `attachment-<uuid>`，不做内容去重（见 §6）；同路径内容可变，按 sha 去重会让「改了文件再 attach」静默返回旧附件。
- 浏览器 `POST /api/cowork.artifact.attach` 以 `attachmentId` 发布：同一 id 重入返回已有 ref，`published:false`，不重复计数。

### 4.4 浏览器发布路由

`POST /api/cowork.artifact.attach`（JSON body：`sessionId`、`artifactId`、`attachmentId`）：

1. `openRecord` 证明工作项属于该 session 的项目；`hasUpload` 证明字节已存。
2. 若 `attachments.jsonl` 已有该 id：幂等返回已有 ref，`published:false`。
3. 否则从字节重推导 `mediaType/size/sha256`，在 artifact 锁内写 `attachments.jsonl`（`source:'user'`）、`attachmentCount +1`、追加 `artifact.updated`。
4. 返回 `{ ok:true, attachment, source:'user', published:true }`。

该路由只发布字节，不接受 `sourcePath` 或原始 bytes；项目文件的浏览器登记不开放，避免浏览器越过路径守卫。

## 5. 三条发布路径：模型 sourcePath、浏览器 attachmentId、评论引用

**sourcePath（模型生成）**：模型先用 `write`/编辑工具产出文件，再调用 `cowork_artifact_attach({ sourcePath })` 登记。

1. `normalizeArtifactPath` 词法校验（拒绝绝对路径、`..`、`\`、控制字符、`.git`/`.dsh-cowork`、凭据 basename）。
2. `resolveInsideRepo`：`realpath` + `stat` 证明是仓库内 regular file（符号链接逃逸拒绝）。
3. 读字节，`attachmentMediaType(name, bytes)` 白名单 + 魔数/UTF-8 校验。
4. `saveUpload` 落盘到 `uploads/<attachmentId>`（`wx` 不覆盖，随机 id）。
5. 发布：首次 `attachments.jsonl` 记一行 `source:'model'`，`attachmentCount + 1`，发 `artifact.updated {attachmentId}`。

**attachmentId（浏览器发布）**：用户上传后（或 Markdown 粘贴图片）调用 `POST /api/cowork.artifact.attach`，只接受已存 upload，写 `source:'user'`；见 §4.4。

**评论引用（用户回复）**：用户创建评论/回复时携带已上传 ref；`commentAttachments` 校验字节后，在写评论的同一事务内发布为 `source:'user'`，保证附件页计数与 thread 引用同时生效。若同一 id 已发布，不重复计数。

## 6. attach 随时，reply 仅 batch 内

- **`cowork_artifact_attach` 可随时调用**：不要求存在 in-flight dispatch。它只做「登记 + 发布」，不关闭任何批注批次。模型可以在 thinking/working 阶段先产出图表 PNG 并 attach，再在回复里引用；也可以在后续回合追加附件。
- **`cowork_artifact_reply` 仍要求 in-flight batch**：现状 [artifact.ts](../../../src/tools/artifact.ts) 的 `inFlightFor` 校验保持不变。reply 的职责是「关闭一次投递」，必须与某个 `sent/thinking/working` 批次绑定，否则会误关已 settle 的批次或复活历史批次。

理由：attach 是存储副作用、与投递状态机无耦合；把它绑到 batch 会阻止合法的多回合附件工作流，并让存储与投递互相纠缠。reply 是投递状态机的终点，耦合必须保留。

## 7. 数据与存储

复用 [artifact-store.ts](../../../src/store/artifact-store.ts) 的 `saveUpload`、`attachmentCount` 字段与 `artifact.updated` 事件，新增一个追加式日志 `attachments.jsonl` 作为**已发布附件清单 + 来源**的持久事实源（复用 `appendLine`/`readJsonLines` 通用助手，无新锁、无 index 变更）。

```text
<repo>/.dsh-cowork/artifacts/<artifactId>/
├─ artifact.json        # attachmentCount = 已发布附件数（口径改为发布时计数）
├─ comments.jsonl
├─ dispatch.jsonl
├─ uploads/<attachmentId>          # 字节库，saveUpload 写入，无扩展名
└─ attachments.jsonl               # 追加：每个已发布附件一行，distinct attachmentId
```

```ts
interface AttachmentPublishV1 {
  version: 1
  attachmentId: string
  name: string
  mediaType: string
  size: number
  sha256: string
  source: 'user' | 'model'   // 唯一来源信号，决定「模型生成」badge
  publishedAt: string
}
```

- **发布即计数**：`attachmentCount` 改为「`attachments.jsonl` 的去重行数」，在首次发布时 +1：浏览器 attach、评论/回复引用、`cowork_artifact_attach` 三条路径都调用同一发布函数；重复引用同一 id 不再 +1。
- **孤儿 upload 不计数不展示**：`saveUpload` 只落字节，不写 `attachments.jsonl`、不加计数；只有发布动作才让它进入列表。用户上传后未发布 → 该 upload 保持孤儿，附件页与计数都不显示它。Markdown 粘贴图片必须在 upload 后立即调用浏览器 attach，因此不会成为孤儿。
- **content-addressed 幂等（否决）**：每次 `sourcePath` attach 都 mint 新 id；同 sourcePath 再次 attach 得到新 id。理由：同一路径内容会变，按 sha 去重会让「改了文件再 attach」静默返回旧附件，产生内容歧义。浏览器 `attachmentId` 重入才是幂等边界。
- **`artifact.updated`**：发布时发 `{ attachmentId }`，前端据此刷新附件页与计数；不新增事件类型。
- 读取：`detail` 响应新增 `publishedAttachments: AttachmentPublishV1[]`（由 store 读 `attachments.jsonl` 派生，bounded ≤ 200）。前端附件页、计数、badge 均以此为准；thread 内缩略图继续从评论 `attachments` 数组取（`attachmentRowsOf`），二者用同一 `attachmentId` 对齐。

## 8. 安全边界

- **项目内**：`normalizeArtifactPath`（词法）+ `resolveInsideRepo`（`realpath` + regular file）双重校验，符号链接指向仓库外或 `.git`/`.dsh-cowork` 内部即拒绝。
- **非凭据**：沿用 `FORBIDDEN_BASENAMES`（`.env`、`.netrc`、`.npmrc`、`.git-credentials`、`credentials`、`id_rsa`、`id_ed25519`、`id_ecdsa` 及 `.env.*`）。
- **regular file**：`resolveInsideRepo` 的 `stat` 只放行 `isFile()`。
- **魔数与白名单**：图片按魔数（SVG 不在 sniff 列表），文本按 UTF-8；`.svg`/`.html`/`.htm`/`.pdf`/`.docx` 扩展名不在白名单 → `artifact/upload-invalid`。扩展名与字节不符也拒绝（`.png` 实为 HTML → sniff 失败）。
- **大小/数量**：5 MB / 200 / 每条 5。
- **serving**：`handleAttachment` 的查找从「评论引用」改为「`attachments.jsonl` 发布清单优先；旧记录无该文件时回退扫描 comments 的 attachments」；仍然从字节推导 `content-type` + `sandbox` + `nosniff`；文本/未知类型 `attachment` disposition，图片 `inline`。未发布的孤儿 upload 不可通过该路由读取。
- **模型生成标记不可伪造**：`source:'model'` 只由 `cowork_artifact_attach` 工具路径写入；浏览器 attach、评论/回复引用都写 `source:'user'`。评论 `author` 与附件 `source` 都经 schema 校验，用户请求无法把 `author` 写成 `model`，也不能在浏览器 attach 里指定 `source`。

## 9. 页面结构与交互

结构沿用 [work-item-artifact-viewer.md](work-item-artifact-viewer.md) 与 [visual-acceptance.md](visual-acceptance.md) 第 4 节；本节只写附件增量。

- **thread 内缩略图**：模型回复里 `image/*` 附件渲染 `cwi-attachment-thumb`（复用 [thread-card.tsx](../../../src/client/work-item/thread-card.tsx) 的 `Attachments`），文本附件渲染下载链接；「模型生成」badge 显示在缩略图/链接旁，来源于该评论 `author === 'model'`，不改变 chip 尺寸。
- **附件页**：工具条「附件」tab 渲染 [viewer-side-tabs.tsx](../../../src/client/work-item/viewer-side-tabs.tsx) 的 `AttachmentsPanel`，数据源从「评论引用」扩展为 `detail.publishedAttachments`；每行缩略图/文件色块 + 名称 + 类型·大小 + 下载，模型生成行加 badge。
- **点击最前层预览弹层**：点击缩略图或 chip 打开 `role="dialog"` `aria-modal="true"` 预览：
  - 图片：缩放（+/-/复位/拖拽平移），`alt` 为附件名；关闭后焦点返回触发元素。
  - 文本（txt/md/markdown/csv/tsv/json）：只读 `<pre>` 预览，显示前 N KB 并注明截断；「下载」按钮取全量。
  - 未知类型（理论上被白名单排除）：下载，不预览。
- **失败/空/加载**：
  - 附件页空：`还没有附件。在批注或回复里添加图片或文本文件。`
  - 上传失败：`cwi-receipt` 显示 `附件上传失败：<code> · <message>`，重试入口。
  - 模型 attach 失败：工具返回稳定错误码，回复里不出现假缩略图；不静默降级。
  - 附件字节缺失：行显示「附件已缺失」，下载返回 `artifact/not-found`。
- **用户上传与模型生成视觉区分**：模型生成行/缩略图带「模型生成」badge（`--cwi-model` 色），用户上传无 badge；badge 是唯一来源标识，颜色不是唯一手段（有文字）。

## 10. 可访问性

- 图片缩略图 `alt=附件名`；预览弹层 `role=dialog` + `aria-modal=true`，打开后焦点入弹层，Esc 关闭并把焦点还给触发 chip；背景交互锁定。
- 附件 chip/缩略图可 Tab 聚焦，Enter/Space 打开预览，`focus-visible` 2px accent outline。
- 文本预览提供键盘滚动；「下载」与「关闭」是真实按钮、有可读 label。
- 键盘上传：`<input type=file>` 可聚焦触发（[comment-composer.tsx](../../../src/client/work-item/comment-composer.tsx) 已有 label 包裹）；拖拽/粘贴到 composer 为增强路径，不作为唯一路径。
- 对比度：`--cwi-model`（#6941c6）文字在 `--cwi-model-soft`（#f4f3ff）上 ≥ 4.5:1；状态色遵守 [visual-acceptance.md](visual-acceptance.md) §2。

## 11. 视觉保真与像素验收

引用 [visual-acceptance.md](visual-acceptance.md) 的 §1（画板、±2px）、§2（颜色）、§5.4（附件 chip）与 §9（截图清单）。本页增量：

- 附件 chip：高 18px、padding 1px 6px、圆角 5px、字号 9.5px、边框 1px（沿用 §5.4）；「模型生成」badge 字号 8.5px、`--cwi-model` 底 `--cwi-model-soft`，置于 chip 右侧，不改变 chip 尺寸。
- 附件页行高：图片缩略图 32×32 圆角 6px；行 padding 8px 10px、行距 6px；名称 12px、meta 9.5px `--cwi-soft`；下载按钮高 26px。
- 预览弹层：居中，最大宽 `min(860px, 92vw)`，最大高 `min(640px, 86vh)`；遮罩 `rgba(16,24,40,.45)`；图片缩放控件 26px 圆角 7px；标题栏 40px、底边 1px `--cwi-border-soft`。
- 四档 1280/1024/768/390 与 ±2px 容差；预览弹层与附件页在 768/390 下不产生横向滚动、不遮挡 composer。
- 复杂场景必须有 HTML demo 与实际截图（§12）。

## 12. Demo

- 交互稿：[attachment-pipeline-demo.html](assets/attachment-pipeline-demo.html)（`?view=main|empty`）
- 截图：[attachment-pipeline-demo.png](assets/attachment-pipeline-demo.png)（1280×900 亮色，headless Chrome `deviceScaleFactor=2`；队长已用 read_image 目检缩略图并通过）

主视图覆盖：用户上传 PNG（附件页 + thread）、模型生成 PNG（badge + thread 缩略图 + 预览弹层）、文本附件、附件页行、预览弹层、上传失败态——7 个元素，超过「至少 4 个」要求；`?view=empty` 单独覆盖空态。

## 13. 测试与验收

每条都写明会让哪个检查变红。

**单元（`node --test`，镜像 [artifact-api.test.mjs] 层）**

- `sourcePath` 逃逸（`../`、绝对路径、symlink 指向仓库外）→ `artifact/path-not-allowed`；`resolveInsideRepo` 拒绝 — `npm test` 红。
- 凭据 basename（`.env`、`id_rsa`）→ 拒绝 — `npm test` 红。
- SVG/HTML/PDF/DOCX 与「扩展名与字节不符」→ `artifact/upload-invalid` — `npm test` 红。
- 超 5 MB → `artifact/file-too-large`；超 200 附件 → `artifact/limit-reached` — `npm test` 红。
- 浏览器 attach：同一 `attachmentId` 重入（`published:false`、计数不增）；未存 upload → `artifact/upload-invalid` — `npm test` 红。
- `sourcePath` 重复 attach 得新 id（不去重） — `npm test` 红。
- 孤儿 upload：`saveUpload` 后不发布 → 计数不变、`publishedAttachments` 不含它；`handleAttachment` 拒绝未发布 id — `npm test` 红。
- `handleAttachment` 从 `attachments.jsonl` 找到已发布附件；旧记录无该文件时回退 comments 引用；`nosniff` + `sandbox` + 从字节推导类型 — `npm test` 红。

**工具（`tests/tools/artifact.test.mjs`）**

- `cowork_artifact_attach` 缺 `sourcePath` → 失败；role 不符 → `role/forbidden`；成功返回 `source:'model'` + `published:true` — `npm test` 红。
- `cowork_artifact_reply` 在无 in-flight batch 时仍 `artifact/dispatch-not-found`（attach 不改变这条） — `npm test` 红。

**路由（`tests/panel/artifact-api.test.mjs`）**

- `POST /api/cowork.artifact.attach` 发布已存 upload、返回 `source:'user'`；同一 id 重入幂等；未存 id → `artifact/upload-invalid` — `npm test` 红。
- `detail` 返回 `publishedAttachments`；计数与列表一致 — `npm test` 红。
- 刷新后（重新 `detail`）已发布附件仍在（持久化到 `attachments.jsonl`） — `npm test` 红。

**浏览器（`npm run test:browser` / layered）**

- 附件页展示用户/模型两类行与 badge；预览弹层打开/缩放/Esc 关闭/焦点返回；失败/空态文案不被截断 — `npm run test:browser` 红。
- 1280/1024/768/390 无横向滚动 — 浏览器 lane 红。

**文档（docs-only）**

- 设计文档与决策记录互相链接、demo 截图存在且可解码 — `npm run check` 红。

## 14. 风险、未核实项、回滚/降级

- **行为变更**：新记录 `attachmentCount` 是「已发布附件数」；上传/粘贴后必须发布（浏览器 attach 或评论引用）才计入。旧记录没有 `attachments.jsonl` 时，附件页/读取回退到 comments 引用，不写盘、不做破坏性迁移；旧孤儿字节保持不可见。
- **新增 `attachments.jsonl`**：追加式、无迁移；旧工作项无该文件时按 comments 引用派生列表。若后续需要统一旧计数，另开一次显式对账迁移，不在读取路径静默改写。
- **模型工具采用率**：`cowork_artifact_attach` 是可选工具，模型可能仍只用 reply 引用；不强迫 attach，生成即展示是增强路径。需真实模型 E2E 调整提示词。
- **未核实**：`callerOf` 在真实工具调用中的 author 判定；`sourcePath` 读字节的 `ctx.fs` 与 `resolveInsideRepo` 在真实宿主的符号链接行为；预览弹层在宿主 `viewArea` 内的 z-index 是否盖住 composer（composer 是 sibling，需在宿主验证）。
- **回滚**：不引入新的附件读取路由；浏览器 attach 路由与 `cowork_artifact_attach` 工具可分别下线，附件页回退到「评论引用」数据源即恢复现状展示。
