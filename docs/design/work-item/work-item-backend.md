# Cowork 工作项后端：调研、架构与实现设计

Status: draft（backend design，2026-11-10；仅设计，未实现）

本方案把[工作项前端设计与开发方案](work-item-frontend.md)和[工作项查看器设计](work-item-artifact-viewer.md)落成后端实现设计。范围是 artifacts 记录、文件、批注、版本、保存冲突、模型投递、SSE 和工具；不含前端代码、编辑器依赖和旧 `workItems` 改造。决策和备选见[后端提案](../../../.agents/notes/proposed/feature/2026-11-10-work-item-page-backend.md)。

## 目标

- 右栏列表和主区域查看器需要的记录、文件、评论、版本、状态都有稳定接口。
- 用户编辑和模型编辑共用同一套版本校验；重叠才锁，不重叠自动合并。
- 用户批注能可靠投递到主题会话，模型回复带线程和附件回到同一工作项。
- SSE 推进投递和文件状态，断线可续；宿主重启后不重复投递、不丢记录。
- 路径、上传、HTML/SVG 和 prompt 内容都在信任边界校验。
- 按前端五阶段顺序落地，阶段 1 先只读闭环，阶段 2 再加编辑和投递。

## 不做

- 旧代码隔离 `workItems` 的字段、状态、branch/commit/merge 语义；不复用、不合并。
- 评审、CI、多人权限、跨项目工作项。
- PDF 正文编辑、复杂 Word/Excel 版式保真。
- Artifact 工作室、活动记录页、项目记忆页。
- 用户上传新建工作项：首版只由主题会话的 `cowork_artifact_create` 登记项目内已有文件；上传只服务已有工作项的评论/回复附件。空态“上传文件”入口后置到阶段 5。
- 新增 DSH 宿主包或修改宿主源码。

## 前端能力矩阵

| 前端能力 | 后端模块 | 首版时间 |
|---|---|---|
| 右栏工作项列表、分组、计数 | artifact store + list route | 阶段 1 |
| 主区域详情、文件内容、版本/附件标签 | detail/file routes | 阶段 1 |
| 逐行/范围批注、评论线程、解决 | comments + anchors | 阶段 1 |
| 模型投递状态、SSE 刷新 | dispatcher + event route | 阶段 2 |
| 文本编辑、自动保存、冲突合并 | fs version + revisions + merge | 阶段 2 |
| 编辑范围上报、同行锁 | presence + tools.guard | 阶段 2 |
| 图片/文件上传、模型回复附件 | upload + attachment refs | 阶段 2 |
| 图表/表格/Doc 查看与编辑 | 复用文本保存和文件路由 | 阶段 3–4 |
| 画布编辑、整文件锁 | canvas presence + text JSON save | 阶段 4 |
| PDF/图片字节、在应用中打开 | file route + open route | 阶段 4 |
| 文件缺失/重新绑定 | reconcile + rebind | 阶段 5 |

## 宿主调研

| 能力 | 依据 | 结论 / 限制 |
|---|---|---|
| exact fetch 路由 | `src/panel/api.ts:935-1004`：`connection.fetch.register`；`serve()` 先做 `assertSameOrigin` | 新路由沿用同样注册、错误 envelope 和 Host/Origin 校验 |
| SSE | DSH `packages/client/connection/src/http-bridge.ts:103` 逐块写 `Response.body`；`browser-auth.ts:120-123` 是 HttpOnly/SameSite=Strict cookie | 可走 `connection.fetch`；EventSource 同源带 cookie。真实宿主认证/心跳/续传仍待 E2E（V10） |
| prompt 队列 | `packages/api/session-controller/src/commands.ts:364-366`：`queue` → `followup`；inbox 持久化（`packages/core/agent/src/types.ts:42-65`） | 同一主题会话天然串行；投递用 `mode:'queue'`，不打断当前回合 |
| 会话事件 | DSH `packages/core/session/src/types.ts:281-361`：`turn/start`、`turn/end`、`tool/call`、`tool/result`、`assistant/message` | 投递状态机监听 `session/event`，不轮询 |
| 文件版本 | `packages/fs/fs/src/types.ts:123-154`：`replaceIfVersion`、`expected.version`；`resolve/readText/writeText` | 文本保存可做乐观并发；写失败返回 stale version |
| 工具守卫 | DSH `packages/core/tools/src/app/apply.ts:731,1136`；`src/platform/tool-model.ts:117-134` 的 `readCaller` 从 `exec.agent.session.header.cwd` 取 cwd | 同行锁可同步解析相对路径；`write/edit/str_replace_editor` 可拦，bash 不可拦 |
| 图片/附件 | `packages/attachment/attachment/src/app/apply.ts:98`；prompt content 支持 `image`/`file`（`session-controller/src/types.ts:89-97`） | 用户图片可持久化；模型回复附件需工具参数校验 |
| 在应用中打开 | `session-controller/src/app/apply.ts:319-382`：`canOpenWorkspacePath`/`openWorkspacePath`/`workspacePathApplications` | 宿主校验路径；浏览器不传任意路径 |
| 存储写模式 | `src/store/project-store.ts:1-12`：`withFileLock` + `writeFileAtomic`，读无锁 | artifacts 用独立目录和独立锁，避免改 index v2 |
| 旧 workItems | `src/domains/isolation/work-item.ts`、`src/store/schema.ts:118-152`：clone + 评审状态 | 新 artifacts 完全独立 |

**未核实（实现期 E2E 门禁）：**

- 真实 GUI 的 SSE 认证、心跳、`Last-Event-ID` 续传。
- 插件侧 `sessionController.prompt` 带图片/文件的真实行为。
- `tools.guard` 在真实工具调用中的参数、cwd、拒绝后模型重试。
- 宿主重启后 dispatch 与 session inbox 的对账。
- `ctx.fs.watch` 的跨平台行为。

## 架构

```text
浏览器
├─ 右栏 WorkItemList ──GET list/detail/files/comments──┐
├─ 主区域 WorkItemPanel ──POST comment/edit/presence──┤
└─ EventSource ──GET artifact.events (SSE)────────────┤
                                                       ▼
src/artifact-api.ts（exact fetch、Host/Origin、错误 envelope）
   ├─ src/artifact-store.ts（记录/评论/修订/事件日志）
   ├─ src/artifact-files.ts（路径守卫、读取/Range、上传、保存）
   ├─ src/artifact-presence.ts（编辑范围、TTL、守卫判定）
   ├─ src/artifact-events.ts（事件 hub、SSE 回放）
   └─ src/artifact-dispatch.ts（队列、合并、prompt、重试、恢复）
          ├─ sessionController.prompt / session/event
          └─ src/artifact-tools.ts（create/comments/reply）
```

### 模块与文件

拟新增（实现期）：

| 文件 | 职责 |
|---|---|
| `src/artifact-contract.ts` | 路由常量、wire 类型、错误码、上限 |
| `src/artifact-schema.ts` | 记录/评论/锚点/投递/事件校验与归一化 |
| `src/artifact-store.ts` | `.dsh-cowork/artifacts/` 布局、锁、原子写、列表/详情/评论/修订 |
| `src/artifact-files.ts` | 路径守卫、文本读取/Range、保存合并、上传落盘、类型检查 |
| `src/artifact-events.ts` | 项目事件 hub，SSE 格式化、seq 回放、裁剪 |
| `src/artifact-presence.ts` | 内存编辑范围、TTL、`tools.guard` 纯判定 |
| `src/artifact-dispatch.ts` | 队列/合并/状态机/prompt/重试/重启恢复 |
| `src/artifact-api.ts` | exact fetch handler 和端口 |
| `src/artifact-tools.ts` | `cowork_artifact_create`、`cowork_artifact_comments`、`cowork_artifact_reply` |

接线：`src/app/apply.ts` 构造 store/hub/dispatcher、注册路由和工具、订阅 `session/event`、注册 `tools.guard`；`src/app/tools.ts` 只增加 artifact 工具注册；不修改 `src/panel/api.ts`、`src/panel/api-contract.ts` 和 `src/store/project-store.ts` 的现有行为。

## 存储

```text
<repo>/.dsh-cowork/artifacts/
├─ .write.lock
├─ events.jsonl
└─ <artifactId>/
   ├─ artifact.json
   ├─ comments.jsonl
   ├─ dispatch.jsonl
   ├─ revisions/<revision>-<sha>.<ext>
   └─ uploads/<attachmentId>.<ext>
```

- artifacts 不写入 `ProjectIndexV2`：不改 index 版本、不迁移、不与旧 `workItems` 共用锁。
- artifacts 独立 `.write.lock`；记录/日志在锁内写，记录用 `writeFileAtomic`，读方无锁。
- 列表扫描 `artifacts/*/artifact.json`，最多 500 条，按 `updatedAt` 降序；内存缓存用目录 mtime 和写事件失效。
- `artifact.json` 是摘要事实源；评论/投递/事件日志用于明细和恢复。
- 保留上限：500 artifacts/项目、5000 评论/artifact、20 修订/文件、2000 事件行；超过评论上限拒绝新增，不删除已写评论。
- 崩溃恢复：启动扫描记录；保存后对账文件 sha/version，发现记录滞后只标记 `needs-reconcile`，不静默覆盖；事件日志最后一条 seq 用于续传。

## 数据模型（v1）

```ts
interface ArtifactRecordV1 {
  version: 1
  artifactId: string            // artifact-[uuid]
  projectId: string
  ownerSessionId: string        // 创建它的主题会话
  title: string
  type: 'text' | 'doc' | 'table' | 'diagram' | 'canvas' | 'pdf' | 'image' | 'html' | 'other'
  status: 'pending-view' | 'pending-confirm' | 'needs-feedback' | 'in-progress' | 'confirmed'
  files: ArtifactFileV1[]
  primaryPath: string
  revision: number              // 每次保存递增
  commentCount: number
  attachmentCount: number
  activeDispatch: { dispatchId: string; state: DispatchState; updatedAt: string } | null
  createdAt: string
  updatedAt: string
}

interface ArtifactFileV1 {
  path: string                  // 项目相对 POSIX
  mediaType: string
  editable: boolean
  size: number
  sha256: string
  revision: number
  fsVersion: string | null      // ctx.fs 的不透明版本；缺失时 null
  missing: boolean
}
```

```ts
type CommentEventV1 =
  | { version: 1; eventId: string; artifactId: string; commentId: string; threadId: string;
      type: 'create'; author: 'user' | 'model'; sessionId?: string; body: string;
      anchor?: Anchor; quote?: string; fileRevision?: number;
      attachments?: AttachmentRefV1[]; createdAt: string }
  | { version: 1; eventId: string; artifactId: string; commentId: string; threadId: string;
      type: 'reply'; author: 'user' | 'model'; sessionId?: string; body: string;
      attachments?: AttachmentRefV1[]; createdAt: string }
  | { version: 1; eventId: string; artifactId: string; commentId: string; threadId: string;
      type: 'resolve' | 'reopen'; author: 'user' | 'model'; createdAt: string }
  | { version: 1; eventId: string; artifactId: string; commentId: string; threadId: string;
      type: 'anchor-moved'; anchor: Anchor; anchorStatus: 'moved' | 'stale'; createdAt: string }
```

```ts
type Anchor =
  | { kind: 'line-range'; path: string; startLine: number; endLine: number;
      quote: string; contextBefore?: string; contextAfter?: string }
  | { kind: 'block'; path: string; blockId?: string; quote: string }
  | { kind: 'diagram-node'; path: string; nodeId?: string; line?: number }
  | { kind: 'table-cell'; path: string; row: number; column: number }
  | { kind: 'canvas-element'; path: string; elementId?: string;
      region?: { x: number; y: number; width: number; height: number } }
  | { kind: 'page'; path: string; page: number }
  | { kind: 'region'; path: string; page?: number;
      region: { x: number; y: number; width: number; height: number } }
  | { kind: 'whole'; path: string }

interface DispatchRecordV1 {
  version: 1
  dispatchId: string
  artifactId: string
  sessionId: string
  commentIds: string[]
  state: DispatchState
  attempts: number
  promptRequestId: string
  errorCode: string | null
  createdAt: string
  updatedAt: string
}

type DispatchState = 'queued' | 'sent' | 'thinking' | 'working' | 'replied' | 'failed' | 'blocked' | 'stale'

interface ArtifactEventV1 {
  version: 1
  seq: number
  eventId: string
  type: 'artifact.updated' | 'file.changed' | 'comment.created' | 'comment.updated'
      | 'reply.created' | 'dispatch.updated' | 'reset'
  artifactId: string
  time: string
  data: Record<string, unknown>   // bounded；不放完整文件内容/评论正文快照
}
```

- 路径、标题、正文、引用、附件名、事件 data 都有长度上限；未知字段忽略，缺字段读时补默认。
- `status` 是协作状态；评论投递状态是 `DispatchState`，两者不混用。
- 附件引用 `{attachmentId, name, mediaType, size, sha256}` 存在 artifact 目录；评论/回复只存引用。

## 状态规则

| 现在 | 事件 | 之后 |
|---|---|---|
| pending-view | 查看器首次打开（`status view`） | pending-confirm |
| pending-view / pending-confirm / needs-feedback / confirmed | 用户新增评论 | needs-feedback |
| needs-feedback | dispatch 被 prompt 接受 | in-progress |
| in-progress | 模型回复成功，或 dispatch failed/超时 | needs-feedback |
| pending-view / pending-confirm / needs-feedback | 用户确认 | confirmed |
| confirmed | 用户新增评论 | needs-feedback |

`status` 只表示协作状态；dispatch 的 `queued/sent/...` 是另一条状态轴，不写进 artifact 状态。确认后再评论会重新打开协作，但不改历史确认记录。

## API

所有路由经 `connection.fetch.register` 的 exact route，沿用 Host/Origin 和浏览器认证；`sessionId` 用来解析项目，文件路径必须是 artifact 记录内的相对路径。

| 路由 | 方法 | 输入 | 输出 / 规则 |
|---|---|---|---|
| `/api/cowork.artifact.list` | GET | `sessionId?status?topicId?` | `{items,counts}`；项目范围；最多 200；按 updatedAt 降序 |
| `/api/cowork.artifact.detail` | GET | `sessionId,artifactId` | 记录、文件、评论摘要、修订元数据、activeDispatch |
| `/api/cowork.artifact.file` | GET | `sessionId,artifactId,path,version?` | 文本/二进制；支持 `Range`、`ETag`；`download=1` 时带 Content-Disposition |
| `/api/cowork.artifact.comments` | GET | `sessionId,artifactId,after?,limit?` | 线程分页；默认 50，最多 200 |
| `/api/cowork.artifact.comment` | POST | `sessionId,artifactId,body,anchor?,attachments?,dispatch?` | 创建评论/回复；校验锚点；默认自动投递；返回评论 + dispatchId |
| `/api/cowork.artifact.comment.resolve` | POST | `sessionId,artifactId,commentId,resolved` | 解决/重开线程；幂等 |
| `/api/cowork.artifact.edit` | POST | `sessionId,artifactId,path,baseVersion,content` | 200 返回合并后内容/版本；409 返回 `conflictRanges`/当前版本 |
| `/api/cowork.artifact.presence` | POST | `sessionId,artifactId,path,ranges` | 300ms 节流、5s TTL；返回 `{ok,ttlMs}` |
| `/api/cowork.artifact.status` | POST | `sessionId,artifactId,action:'view'\|'confirm'` | `view`：pending-view→pending-confirm；`confirm`：→confirmed；幂等 |
| `/api/cowork.artifact.upload` | POST | 流式 body + `sessionId,artifactId,name` | 魔数/大小/数量校验；返回附件引用 |
| `/api/cowork.artifact.events` | GET | `sessionId,artifactId?` | SSE；`Last-Event-ID` 回放；15s 心跳 |
| `/api/cowork.artifact.open` | POST | `sessionId,artifactId,path,action?,application?` | 校验项目内登记路径后调 `openWorkspacePath` |
| `/api/cowork.artifact.rebind` | POST | `sessionId,artifactId,oldPath,newPath` | 文件缺失后重新绑定（阶段 5） |

- 错误沿用 `PanelErrorBody`/`PanelApiError` 风格；新增 `artifact/not-found`、`artifact/session-mismatch`、`artifact/path-not-allowed`、`artifact/file-missing`、`artifact/file-too-large`、`artifact/version-conflict`、`artifact/not-editable`、`artifact/anchor-invalid`、`artifact/upload-invalid`、`artifact/dispatch-*`。
- 列表/详情/文件是项目读权限：任何能解析到该项目的会话都可读；写操作校验 artifact 属于该项目、路径已登记；模型工具再校验 owner/role。
- 文件路由设 `X-Content-Type-Options: nosniff`、`Cache-Control: no-store`；HTML/SVG/PDF 不作为可执行 inline 文档直接打开，前端取文本/字节后在沙箱或查看器处理。
- 查看器首次打开时调用 `status view`（待查看→待确认）；`confirm` 只由用户动作触发。模型回复走 `cowork_artifact_reply`，不生成新的 dispatch。
- 首版创建路径只有 `cowork_artifact_create`：把项目内已有文件登记为工作项。上传路由只返回附件引用，不创建 artifact；用户上传新建工作项需要先定义 artifact-local 文件路径语义，放到阶段 5。

## 保存、版本与合并

1. 校验 artifact、路径在 `files[]` 中、`editable`、文本 ≤5 MB 或 20k 行。
2. `ctx.fs.resolve` + `readText` 当前文件，和记录中的 `fsVersion` 对账；记录滞后先更新。
3. 客户端带 `baseVersion`；一致时 `writeText(..., { kind: 'replaceIfVersion', version })`。
4. 不一致：从 `revisions/<base>` 取 base 文本，用 base/current/mine 做**后端行级三方合并**：
   - 不重叠：写入合并结果，返回新文本/版本；再写修订快照、更新记录、发 `file.changed`。
   - 重叠或没有 base 快照：返回 409 `{ currentVersion, revision, conflictRanges }`，不写文件；前端加载最新后选择。
5. 合并后重试写入遇到新 stale：最多重试 2 次，仍冲突返回 409，不做无限循环。
6. 非文本/画布：画布 `.excalidraw` 是文本 JSON，但整文件锁，不做行合并；版本不一致直接 409。PDF/图片不可编辑，走只读路由。

- 修订快照只保留最近 20 个/文件；快照缺失时不允许自动合并，避免猜测 base。
- 外部/模型写入：`ctx.fs.watch` 监听已打开 artifact 的文件，变化后对账 sha/version，更新记录、发 `file.changed`、重定位锚点；没有 watch 时在 detail/file 请求时对账。
- 模型通过 `write`/`edit` 直接改文件，不经过保存路由；artifact store 靠 watch/tool-result 观察，不能阻止写；同行锁在工具守卫层。

## 编辑范围与工具守卫

- 浏览器每 300ms `POST presence`，带 `path`、`ranges`（起止行）、`mode:'editing'`；5s 过期；服务端内存 registry，不持久化。
- `ctx.tools.guard` 只对 artifact 路径生效：
  - 用 `readCaller(exec)` 的 cwd 把 `write` 的 `file_path`、`edit`/`str_replace_editor` 的 `path` 解析成绝对路径，匹配活跃 artifact 文件。
  - `write`：任何活跃范围 → 拒绝，原因包含用户行范围。
  - `edit`/`str_replace`：用内存文本缓存找 `old_string` 行范围，和活跃范围相交 → 拒绝；`insert` 按插入行判断。
  - 画布：任何活跃编辑 → 整文件拒绝。
  - 缓存缺失/文本过大/路径无法解析：有活跃范围时保守拒绝，提示“先读取文件/稍后重试”；没有活跃范围直接放行。
- `bash` 可绕过守卫，是已确认缺口；只能提示词要求模型用编辑工具，并在保存/文件变化后做版本与路径核对，不宣称阻止。
- 拒绝后模型看到 `Error: ...`，可下一轮重试；第一版不做排队等待。

## 批注、锚点与重定位

- 文本：`line-range` + 引用原文 + 前后一行 + `fileRevision`；保存/文件变化后先在 ±20 行找原文，再全文唯一匹配；失败标 `anchorStatus:'stale'`，保留内容和回复。
- Doc：块指纹/引用文本；表格：cell/row/column；图表：节点或行；画布：element id 或归一化区域；PDF/图片：page/region/pin；整体：whole。
- 评论只追加；解决/重开也追加事件；线程折叠由前端计算。评论/回复不物理删除。
- `commentCount` 统计全部评论事件；列表展示评论数；详情加载线程。
- 模型回复写入同线程；回复正文/附件走同一校验；模型回复不自动解决线程。

## 投递

### 队列与合并

- 评论创建默认生成 dispatch；1.5s 合并窗口、最多 10 条/批；同一主题会话串行；跨主题并行默认 4（1–8）。
- 每会话队列上限 50，项目 200；超出返回 `artifact/dispatch-queue-full`。
- `dispatch.jsonl` 每次状态变化追加快照；启动读最后状态恢复。
- 重启时：`queued` 可重新入队；`sent/thinking/working` 标 `stale`，不自动重发（避免重复回合）；`replied/failed/blocked` 终态保留。

### 状态机

```text
queued ──prompt accepted──▶ sent ──turn/start──▶ thinking
  │                              │                  │
  │                              │                  ├─ tool/call ──▶ working
  │                              │                  └─ turn/end 无 reply ──▶ failed
  │                              ├─ session 不可用 ──▶ blocked
  │                              └─ timeout ──▶ failed
  └─ 队列满/校验失败 ──▶ failed
working ──cowork_artifact_reply 成功──▶ replied
```

- `sent`：`sessionController.prompt({requestId:dispatchId, mode:'queue', content})` 接受。
- `thinking`：目标会话 `turn/start`。
- `working`：`tool/call` 或文件变化。
- `replied`：`cowork_artifact_reply` 成功写入评论。
- `turn/end` 前未调用回复工具 → `failed`，错误码 `artifact/reply-missing`；会话不存在/归档 → `blocked`；超时（默认 10 分钟）→ `failed`。
- 只在 prompt 被接受前重试（1s/4s/15s，最多 3 次）；接受后不重试。
- 状态变化写 dispatch 日志、更新 artifact `activeDispatch`、发 `dispatch.updated` 事件；成功后 artifact 状态回到 `needs-feedback`。

### Prompt

- 内容 bounded：artifactId、primaryPath、文件 revision、批注编号/行号/引用原文、最多 10 条批注、总字符上限。
- 明确要求：先读当前文件；只改登记文件；用 `write`/`edit`，不要用 bash；完成后必须调用 `cowork_artifact_reply`，传 artifactId、commentIds、回复正文、可选附件路径。
- 用户批注按数据块分隔，不当作指令；去掉控制字符，不拼接未转义 HTML。
- 图片评论作为 prompt 的 `image` content part；单次最多 4 张/总大小上限；模型不支持图片时降级为文字说明，不静默丢弃。

### 工具

| 工具 | 角色 | 作用 |
|---|---|---|
| `cowork_artifact_create` | topic/master | 把项目内已有文件登记为工作项；校验路径/类型/标题；触发 `artifact.updated` |
| `cowork_artifact_comments` | topic/master | 读取工作项和未解决批注，供模型补上下文 |
| `cowork_artifact_reply` | artifact owner 或 master | 写模型回复和附件；校验 commentIds/路径；把 dispatch 置 `replied` |

- 工具参数不含绝对路径、任意 shell 或模型选择的宿主命令。
- 工具结果返回 bounded id/状态/错误，不返回整篇文件。
- `cowork_artifact_create` 不复制文件；artifact 只是登记，编辑仍改原文件。

## SSE

- `events.jsonl` 项目级，seq 持久化；事件 hub 只广播 live；SSE 连接发 `hello`，按 `Last-Event-ID` 回放，之后进入 live；15s 心跳。
- 事件超过 2000 行/4 MB 裁剪；请求 id 早于保留窗口时发 `reset`，客户端重拉详情。
- 响应头：`text/event-stream`、`cache-control: no-store`、`x-accel-buffering: no`；慢消费者按背压等待，断开取消订阅。
- 文件外部变化通过 `ctx.fs.watch`（已打开 artifact）监听；30s 无订阅停止；变化对账后发 `file.changed`。

## 安全

- 路径：项目根 + 记录内路径；拒绝绝对路径、`..`、符号链接逃逸、`.git`、`.dsh-cowork` 内部和常见凭据文件；写入/打开前 realpath 校验。
- 上传：图片按魔数（png/jpeg/webp/gif），文本/Markdown 按 UTF-8；单文件/数量/总大小上限；随机文件名；不覆盖已有文件。
- HTML/SVG：后端只返回字节/文本并加 `nosniff`；不作为可执行 inline 文档；前端沙箱/净化。
- 认证/CSRF：沿用 connection 的 Host/Origin 和浏览器 cookie；POST 只接受白名单 content-type；请求体大小上限。
- Prompt 注入：评论/引用是数据，不是指令；bounded、分隔、去控制字符；不把密钥/环境变量拼入 prompt。
- 日志：记录 artifactId/dispatchId/状态/错误码/耗时；不记评论正文、密钥或敏感绝对路径。

## 配置与观测

`Config.artifacts`（拟）：

- `maxArtifactsPerProject` 500
- `maxTextFileBytes` 5 MB、`maxTextFileLines` 20000
- `maxCommentChars` 4000、`maxAttachmentsPerComment` 5、`maxAttachmentBytes` 5 MB
- `presenceTtlMs` 5000
- `dispatchWindowMs` 1500、`maxCommentsPerDispatch` 10、`dispatchConcurrency` 4（1–8）
- `dispatchTimeoutMs` 600000、`dispatchMaxRetries` 3
- `eventLogMaxLines` 2000

日志点：artifact 创建、评论/投递状态、守卫拒绝、保存冲突、文件对账失败、SSE 连接/断开；结构化、带 id，不带正文。

## 失败与恢复

| 场景 | 行为 |
|---|---|
| artifact.json 损坏 | 该 artifact 在列表中标记 `error`，其他 artifact 不受影响；日志报 `artifact/corrupt` |
| 保存中途崩溃 | 文件可能新、记录旧；启动/读取对账 sha/version，更新记录并标 `needs-reconcile`，不覆盖文件 |
| 评论写入成功、事件失败 | 评论仍在；重连时 detail 重拉；事件可补偿 |
| 事件日志裁剪后旧客户端重连 | 发 `reset`，客户端重拉详情；不假装续传 |
| 投递 prompt 接受后宿主崩溃 | 重启标 `stale`，不自动重发；用户可重试 |
| 会话归档/不存在 | dispatch `blocked`，评论保留；不自动重试 |
| 文件缺失 | detail 标 `missing`；评论保留；阶段 5 提供 rebind |
| 模型未调用回复工具 | `turn/end` 后 `failed`，错误码 `artifact/reply-missing`；不伪造回复 |
| bash 绕过同行锁 | 保存/文件变化对账时发现版本变化，标记冲突；无法事前阻止 |

## 测试计划

- 单测：schema/上限、路径守卫、锚点重定位、三方合并、presence 范围、守卫判定、dispatch 状态机/合并/重试、事件 seq/裁剪。
- 路由测试：沿用 `tests/api.test.mjs` 的临时仓库和私有 connection probe；覆盖认证、项目解析、列表/详情/文件/Range、评论、保存 409、上传、错误码。
- 守护测试：`tools.guard` 对 write/edit/str_replace_editor 的允许/拒绝/未知 cwd/缓存缺失。
- 投递测试：fake session port 推进 sent/thinking/working/replied/failed；重启恢复；队列满/超时/重试。
- 真实宿主 E2E：SSE 认证/心跳/Last-Event-ID、真实工具守卫、图片 prompt、双主题并行、重启 stale。
- 拟新增：`tests/artifact-schema.test.mjs`、`artifact-store.test.mjs`、`artifact-api.test.mjs`、`artifact-presence.test.mjs`、`artifact-dispatch.test.mjs`、`artifact-tools.test.mjs`。
- 验收命令：`npm run check`、`npm run typecheck`、`npm run build`、`npm test`；真机 E2E 单独记录。

## 分阶段实现

1. **阶段 1：只读闭环。** 记录/存储、列表/详情/文件路由、评论/锚点/线程、SSE 基础、`cowork_artifact_create`；fixture + 路由测试。对应前端阶段 1。
2. **阶段 2：编辑与投递。** 修订/保存/三方合并、presence、工具守卫、dispatch/重试/恢复、`cowork_artifact_reply`、上传/多模态；真实宿主 E2E。对应前端阶段 2。
3. **阶段 3：图表/表格。** 复用文本保存和文件路由；图片/SVG 上传/导出；无新的核心存储。对应前端阶段 3。
4. **阶段 4：Doc/PDF/画布。** 字节/Range、在应用中打开、画布整文件锁、docx/xlsx 原件/下载；对应前端阶段 4。
5. **阶段 5：收口。** 事件裁剪、重启恢复、rebind、性能缓存、路径/上传安全、完整 E2E。对应前端阶段 5。

## 风险与未核实

- **SSE/投递未真机验证。** 设计以 V10/V11 和源码为基础；阶段 2 第一件事是跑真实宿主。
- **工具守卫只覆盖结构化写工具。** bash 绕过是确定缺口；只能提示词 + 保存后核对。
- **列表扫描 500 条** 在本地磁盘可接受；实测超预算再加 artifacts 自身摘要索引（仍不改 project index）。
- **事件日志增长**：裁剪 + reset；不删除评论/回复。
- **单宿主/单用户假设**：不做多人权限；同一项目会话共享读权限。
- **模型回复采用率**：未调用回复工具会 failed；需真实模型 E2E 调整提示词/工具。
- **`ctx.fs` 服务缺失**：artifact 文件路由/保存返回明确 `artifact/fs-unavailable`，插件仍加载。
- **未核实**：真实 GUI SSE、插件 prompt 图片、工具守卫真实参数、重启对账、fs.watch 跨平台。

## 相关文档

- [工作项前端设计与开发方案](work-item-frontend.md)
- [工作项多模态交付物查看器设计](work-item-artifact-viewer.md)
- [V1–V16 核实报告](work-item-artifact-verification.md)
- [后端提案](../../../.agents/notes/proposed/feature/2026-11-10-work-item-page-backend.md)
