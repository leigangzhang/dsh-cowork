# M6 宿主探针结果：七项能力与主题会话可见性

- **结论摘要**：七项探针都在真实宿主上跑通并留下可复跑证据。1–3 结论明确：最低推理档是 `off`，等价于关闭推理；生产插件能稳定收到 `session/event`；`archiveSession` 后会话**不能**继续对话（prompt 被接受，但 turn 以 `blocked` 结束、无 assistant 文本），unarchive 后恢复，且宿主没有 archive 之外的会话过滤接口。4–6 有明确结论：reviewer 必须 verdict 后回收；master preset 去掉 fs/bash 仍能工作，per-agent `restrict` 只能掩蔽继承来的工具；真实 Chrome 同源 JSON POST 可用且检查不误伤。7 记录：reviewer 能读隔离 clone；worktree 不作为 v1 提供方。
- **环境**：DSH Desktop **2.0.18**（`/Applications/DSH Desktop 2.app`），运行时 0.2.1-rc.2，web profile `http://127.0.0.1:3080`，macOS，Chrome 156.0.8078.80。`docs/PLAN-V0.2.md:6` 与 `docs/PLAN.md:5` 写的 2.0.13 是历史漂移；计划属禁改范围，漂移只记录在本节。
- **执行方式**：临时工具带 `<repo>/.dsh-cowork/m6-probe/toolbelt`（整目录被 `.gitignore` 忽略）经 `dev_inject_plugin` 注入。探针模块在 `lib/probes/*.js`，由 `GET /dsh-cowork/m6/health` 热发现，`POST /dsh-cowork/m6/run` 执行，证据写 `runs/<probeId>-<runId>.json`，`runs/index.json` 指向每个探针最新一次成功 run。工具带与证据都不进版本库；`.dsh-cowork` 下不建 `.md`（`check-invariants` 会扫描该目录）。
- **取舍**：本文只引用 `runs/index.json` 指向的 `ok=true` run。历史失败 run 保留、不作结论依据：`m6-2-events-1794110128103-9c960621.json`（首轮断言假设错误）、`m6-6-panel-1794110554231-b68e8a3f.json`（探针代码 bug）。

## 0. 结论总表

| # | 探针 | 结论 | 证据文件（`runs/` 下） |
|---|---|---|---|
| 1 | `m6-1-llm` | 最低档 `off` 等价关闭推理；极小 stream 正常 | `m6-1-llm-1794110116589-f2cf5197.json` |
| 2 | `m6-2-events` | 两轮事件齐全、seq 单调 | `m6-2-events-1794110213372-d40648ea.json` |
| 3 | `m6-3-archive` | archive 后 turn `blocked`、消息不落盘；unarchive 恢复；无替代过滤接口 | `m6-3-archive-1794110796986-e0bc33c8.json` |
| 4 | `m6-4-reviewer` | 立即归档 `blocked`；verdict 后归档正常 | `m6-4-reviewer-1794110919917-9713c1d1.json` |
| 5 | `m6-5-preset` | 去 fs/bash 可工作；工具面=preset 行+宿主全局；`restrict` 边界明确 | `m6-5-preset-1794111061785-c4b7b234.json` |
| 6 | `m6-6-panel` | 真实 Chrome 同源 POST 可用；围栏拒绝错误来源 | `m6-6-panel-1794110689570-65c4703a.json` |
| 7 | `m6-7-clone` | reviewer 可读 clone；worktree 需单独探针 | `m6-7-clone-1794111139096-3c72ed0c.json` |

## 1. LLM prepareCall 与关闭推理（结论明确）

**结论。** 最低 `reasoningEffort` 是 `off`；它等价于关闭推理：适配器把 `off` 映射为 `thinking.type="disabled"`，且不再发送 `output_config`（`@deepseek-ai/dsh-llm-deepseek/lib/index.js:1720-1721`；枚举 `:320`，`thinking=disabled` 时只允许 `off` 的校验 `:402`，`OFF_ONLY_REASONING_EFFORTS` `:487,527`）。`prepareCall({maxTokens:32})` + `configure` 取最低档后，resolve 出的配置是 `maxTokens:32, reasoningEffort:"off"`；模型广告 `efforts=[off,low,high,max]`、`defaultEffort=high`。用 `maxTokens:16`、`reasoningEffort:"off"` 真跑一次极小 stream：文本 `M6_LLM_OK`、`finish=stop`、1199 ms、outputTokens=6、reasoningChars=0。

**证据命令。** `curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/run -H 'content-type: application/json' -d '{"probeId":"m6-1-llm"}'`

**原始输出摘录。**

```text
route: deepseek-official/deepseek-flash (currentSelection.reasoningEffort="max")
resolvedConfig: {"maxTokens":32,"reasoningEffort":"off","provider":"deepseek-official","model":"deepseek-flash"}
modelInfo.reasoning: efforts=[off,low,high,max] defaultEffort=high
stream: text="M6_LLM_OK" finish={"kind":"stop"} durationMs=1199 reasoningChars=0 outputTokens=6
static: thinking: { type: effort === "off" ? "disabled" : "enabled" }   (dsh-llm-deepseek/lib/index.js:1720)
static: ...effort === "off" ? {} : { output_config: { effort } }        (同上 :1721)
```

**证据文件。** `.dsh-cowork/m6-probe/runs/m6-1-llm-1794110116589-f2cf5197.json`

**限制。** `ctx.get("llm")===undefined` 的回退分支未在运行时触发（`evidence.fallback.runtimeVerified=false`，仅静态设计）；适配器没有独立的 `thinking=false` 布尔开关，等价性由源码与零 reasoning 输出共同支持，未验证其它 provider；单模型、单次采样，5s prepare / 30s stream 是观测建议而非宿主强制。

## 2. session/event 的稳定性（结论明确）

**结论。** 生产插件在 `apply` 期注册的 `ctx.on('session/event')`，对 standard preset 会话的连续两轮 prompt 都收到了 `user/message`、`turn/start`、`turn/end`（reason `completed`）与 `assistant/message`；两轮文本分别是 `M6_EVENTS_OK_1/2`，耗时 2077/2293 ms。会话级事件 `seq` 从 0 到 32，`seq>0` 的 32 条单调递增、无重复 `type+seq`。

**证据命令。** `curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/run -H 'content-type: application/json' -d '{"probeId":"m6-2-events","timeoutMs":180000}'`

**原始输出摘录。**

```text
session: session-23969293-00be-4ffc-bd05-52012506e60c (preset standard)
round1 types: agent/inbox/spliced→turn/start→step/start→system/message→user/message×5→request/header→request/context→assistant/message→step/end→turn/end
round2 types: agent/inbox/spliced→turn/start→step/start→user/message→assistant/message→step/end→turn/end
assistant: "M6_EVENTS_OK_1" / "M6_EVENTS_OK_2"   turn/end reason: completed
sequence: durableEventCount=32 seqMonotonic=true duplicateTypeSeqPairs=[]
```

**证据文件。** `.dsh-cowork/m6-probe/runs/m6-2-events-1794110213372-d40648ea.json`

**限制。** 只在宿主进程内、只经 `apply` 注册的监听器观察，客户端收包与跨进程未验证；每会话缓冲上限 500 条，超限丢事件的行为未验证；`user/message` 的字段在顶层（`{content,id,role,source}`），`assistant/message` 嵌在 `message` 下，helper 的 `userMessageSeen` 因此不可靠、以事件类型为准。

## 3. archive 后打开与继续对话（结论明确，推翻计划直觉）

**结论。** `workspaceRegistry.archiveSession(id)`（默认）与 `archiveSession(id,{stopActivity:true})` 都成功；归档后 prompt 返回 `accepted:true`，但事件只有 `turn/start → turn/end(reason="blocked")`，没有 `user/message`、没有 assistant 文本、没有 RPC 错误——**两种模式都不能继续对话**。`unarchiveSession(id)` 后 prompt 恢复 `completed` 并返回正确 token。归档后 `sessionController.list` 仍含该行（`dsh-api-session-controller/lib/index.js:3061` 只按 remoteAccess 过滤），`inspect` 仍可用（24 条事件）。归档期间的 prompt 被静默丢弃：`inbox.claim` 在 `agent/pre-step` gate 之前取走消息（`dsh-agent-loop/lib/index.js:906→909→922→961`），gate 拒绝后消息不落盘、解档也不补发。宿主没有 archive 之外的会话过滤/隐藏接口（5 个宿主包文件扫描 + `hideSession` 类候选 0 命中；`dsh-client-ui-sidebar` 无会话过滤）。`openSession` 本身不检查 archive（`dsh-client-ui-workspace/lib/client.js:1470`），但 `clearArchivedCurrent`（`:1640`，由列表 reconcile 在 `:1578` 调用）会在下一次列表更新时清掉归档的 main 选择——真实 UI 点击未验证（M11）。

**证据命令。** `curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/run -H 'content-type: application/json' -d '{"probeId":"m6-3-archive","timeoutMs":300000}'`

**原始输出摘录。**

```text
default: archive ok; after prompt accepted=true reason=blocked assistantText="" timeout=false error=null
stopActivity: archive ok; after prompt accepted=true reason=blocked assistantText="" timeout=false error=null
both: listHasRow=true inspectOk=true; unarchive prompt reason=completed tokenSeen=true
archived turn: userMessageEvent=false → unarchived turn: userMessageEvent=true
static: archiveSession activity gate dsh-workspace/lib/index.js:531-533; gate mount dsh-api-session-controller/lib/index.js:2516
static: openSession(target) client.js:1470; clearArchivedCurrent() :1640 (reconcile :1578)
```

**证据文件。** `.dsh-cowork/m6-probe/runs/m6-3-archive-1794110796986-e0bc33c8.json`

**限制。** 所有 prompt 在宿主进程内，事件来自工具带监听器；`openSession` 的真实点击、面包屑与左侧栏隐藏效果未验证（M11）；归档期间消息是否落盘只看事件与 `inbox.claim` 源码，未直接读取会话日志文件；只测了两个变体。

## 4. reviewer 创建后立即归档（结论明确）

**结论。** 用本工具带注册 reviewer 类 preset（persona + agent-instructions + tool-bash + tool-fs-search，无 `tool-fs`），create 后立即 `archiveSession(id,{stopActivity:true})`，prompt 仍是 `accepted:true` 但 turn 以 `blocked` 结束、没有 `M6_REVIEWER_OK`、无错误码——reviewer 无法产出 verdict。不归档的对照正常 `completed` 并返回 token。verdict 后归档的变体：首轮 `completed`，归档后下一轮 `blocked`。故 `reviewer.reclaim` 默认必须写 **after-verdict**，不能写 immediate。工具面实测 bash/glob/grep 有、read/write/edit 无（54 个可见工具中含约 50 个宿主全局工具，见探针 5）。

**证据命令。** `curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/run -H 'content-type: application/json' -d '{"probeId":"m6-4-reviewer","timeoutMs":300000}'`

**原始输出摘录。**

```text
immediate: archive ok → prompt accepted=true reason=blocked tokenSeen=false error=null
control:   prompt reason=completed tokenSeen=true
afterVerdict: first reason=completed tokenSeen=true → archive ok → second reason=blocked
toolSurface: bash=true glob=true grep=true read=false write=false edit=false (count=54)
```

**证据文件。** `.dsh-cowork/m6-probe/runs/m6-4-reviewer-1794110919917-9713c1d1.json`

**限制。** 用固定文本 prompt 代替真实 `cowork_review_verdict`，verdict 工具本体未验证（M9）；preset id 是探针专用；客户端 UI 未验证；54 个工具中含宿主全局工具，硬隔离结论在探针 5。

## 5. master preset 工具面与 per-agent 策略（有结论）

**结论。** master 类 preset（persona、agent-instructions、time-context、tool-ask-user、tool-todo，无 fs/fs-search/bash/jobs/present）建会话后 turn=1 `completed`、回答 `M6_MASTER_OK`——去掉 fs/bash 仍能工作。工具面：`agent.ctx.tools.schemas(agent)` 是 53 个 = 51 个宿主全局 + `ask_user_question` + `todo_write`（正是 preset 行）；standard preset 对照 82 个。陷阱：`agent.ctx.tools.schemas()` 不传 scope 只回全局视图 51 个，看不到 preset 行。per-agent `restrict` 实测：deny 宿主全局 `dev_plugin_status` 成功、schemas 移除、`tools/change` 触发、disposer 恢复；deny preset 继承名 `todo_write` 同样成功；deny agent 自身注册名与未知名抛 `unknown global tool`；`restrict({})` 报 no-op；从插件自身 ctx 调用报 `requires a scoped context (agent.ctx)`。结论：preset 行决定本层注册什么，`restrict({deny})` 再掩宿主全局与 preset 继承名，二者叠加；边界是不能掩 agent 自身注册的工具（`packages/core/tools/src/index.ts:1097-1118,1197-1210`；视图 `:1178`、`schemas` `:1260`；scope 链 `packages/core/scope/src/store.ts:192`；`agent.ctx` `packages/core/agent-loop/src/agent.ts:105`）。

**证据命令。** `curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/run -H 'content-type: application/json' -d '{"probeId":"m6-5-preset","timeoutMs":240000}'`

**原始输出摘录。**

```text
master preset: session session-0a0c6c12… turn=1 reason=completed text="M6_MASTER_OK"
toolSurface: global=51; masterScoped=53 (masterOnly=[ask_user_question,todo_write]); standard=82
restrict: deny dev_plugin_status ok removed; deny todo_write ok removed; changeFired=true
restrict own name → "tools.restrict() names unknown global tool ..."; restrict({}) → no-op
unscoped ctx → "tools.restrict() requires a scoped context (agent.ctx)"
```

**证据文件。** `.dsh-cowork/m6-probe/runs/m6-5-preset-1794111061785-c4b7b234.json`

**限制。** `allow` 白名单与跨 agent 隔离未单独验证；探针 preset 是 master 形态而不是最终 `cowork-master`；51/53/82 是本次运行环境的计数，换 profile 会变；`restrict` 只按名掩蔽，不构成沙箱。

## 6. 面板同源 POST 与真实 Chrome（有结论）

**结论。** 面板写路由的检查不误伤、也能拒绝错误来源：同源 JSON POST 200 且回显 body；`Origin: http://evil.example` 403；缺 content-type 415；`Host: evil.example` 403；跨 authority（Host `localhost:3080`）403；body 超 8 KiB 413；无 Origin 200（curl 对照）。真实 Chrome 156.0.8078.80（headless）从 `http://127.0.0.1:3080` 打开页面，同源 POST 200 且 `bodyEcho.runId` 匹配；`fetch http://localhost:3080/...` 在浏览器侧被拦（`Failed to fetch`），同情形服务端 curl 403。`connection.fetch.register(POST /api/cowork.m6-probe.echo)` 成功（第二次运行报已注册，按幂等处理）；无 cookie 的 POST 401。认证后的 /api POST 未验证。

**证据命令。** `curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/run -H 'content-type: application/json' -d '{"probeId":"m6-6-panel"}'`

**原始输出摘录。**

```text
curl: same-origin 200 | evil-origin 403 origin-mismatch | missing-content-type 415
      evil-host 403 host-not-loopback | no-origin 200 | cross-authority 403 | body-too-large 413
chrome: Chrome/156.0.8078.80 location.origin=http://127.0.0.1:3080 sameOriginPost=200 echoOk=true
chrome: crossAuthority browserBlocked=true error="Failed to fetch"
api: connection.fetch.register ok (already registered on rerun); unauthenticated POST → 401
```

**证据文件。** `.dsh-cowork/m6-probe/runs/m6-6-panel-1794110689570-65c4703a.json`

**限制。** 认证后的 `/api` POST 未验证：launch token / browser cookie 属凭据，不读取、不绕过；M11 的验收方式是在真实已认证面板上下文 POST 该路由断言 200+bodyEcho，或以宿主 browserPeer 在进程内调用注册 handler 做契约测试。结论只代表本机 Chrome 156 + 无扩展配置；headless 与真实窗口的差异未验证。

## 7. clone 对 reviewer 可读与 worktree 适配器（有记录）

**结论。** `git clone --no-hardlinks` + 分支 `cowork/m6-probe-<id>` + marker 本地 commit（8 个 git 步骤全 exit 0，未 push）；`.git` 在 clone 内、`--show-toplevel` 等于 clone 路径。会话 A（cwd=clone，standard）用 bash `cat marker.txt` 回到 marker；会话 B（cwd=repo，reviewer 类 preset 仅 bash/glob/grep，无 read/write/edit，54 工具）用 bash `cat <clone>/marker.txt` 回到同一 marker。主仓 `git status` 前后为空。探针跑完删除自己创建的 clone（`cloneCleanupSucceeded=true`，只删本次 `.dsh-cowork/workitems/m6-probe-*`）：`check-invariants` 会扫 `.dsh-cowork`，clone 里的 `.md` 会让 `npm run check` 变红；需要复现时按证据里的 head/marker 重建。与产品差异：产品用 `git clone --local`（`src/checkout.ts:312`），探针用 `--no-hardlinks` 证明内容独立可读。worktree 不能直接作 v1 提供方：宿主 `worktrees` 服务只有 `create(agent,{name?,from?})`，无 merge/list/remove（`@deepseek-ai/dsh-experimental-worktree/lib/index.js:184,194,206,236`）；`dsh-plugin-worktrees@0.1.2` 是给 agent 的工具面 + opportunistic `worktreesEngine`（`lib/engine-face.js:6,320`；repo 准入 `lib/repo-gate.js:105-117`；merge 串行 `lib/merge-queue.js:200-203`）。

**证据命令。** `curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/run -H 'content-type: application/json' -d '{"probeId":"m6-7-clone","timeoutMs":300000}'`

**原始输出摘录。**

```text
git: status-before "" | clone --no-hardlinks exit 0 | checkout -b exit 0 | add/commit exit 0
clone: branch cowork/m6-probe-1794111139096-8c05cb8a marker M6_CLONE_f9c20764937d
session A (cwd=clone, standard): bash cat marker.txt → M6_CLONE_f9c20764937d
session B (cwd=repo, reviewer): bash cat <clone>/marker.txt → M6_CLONE_f9c20764937d
main worktree git status after: "" ; cloneCleanupSucceeded=true
```

**证据文件。** `.dsh-cowork/m6-probe/runs/m6-7-clone-1794111139096-3c72ed0c.json`

**限制。** worktree 适配器只有静态源码证据、无运行时证据；reviewer 在 clone 内的写入/提交未验证（M2 证 worktree 侧 git 写 EPERM）；clone 已删除，复现需按 `evidence.clone` 的 commit/marker 重建；`--no-hardlinks` 与产品 `--local` 的差异只影响对象共享，不影响 `.git` 位置。

## 8. 既有证据（M0–M4）

- M0：`ctx.on('session/event')` 收到两轮 `turn/start`/`turn/end` 与 assistant 文本，`sessionController.create/prompt/list` 可用（`docs/archived/M0_PROBE_RESULT.md:12,19-24`）。
- M2：per-thread clone 可写、可提交，`archiveSession` 可成功归档，worktree 内 git 写在 workspace-write 下 EPERM（`docs/archived/M2_PROBE_RESULT.md:101-130,144,187`）。
- M3：reviewer 会话由 `session-create` 创建、preset 挂载、实际调用 `cowork_review_verdict`，cleanup 记录 3 个 reviewer session（`docs/archived/M3_PROBE_RESULT.md:12,15`）。
- 本次没有重复验证 reviewer 在 clone 内写入；clone 的 `.git` 位置与 M2 记录一致。

## 9. 对 M7–M12 的影响

- **M11 必须改计划假设（探针 3）。** `docs/PLAN-V0.2.md:143`（§2.4）与 `:380`（§5.9）要求「主题会话隐藏」同时「`openSession` 必须可用」。探针 3 证明两者不能按原假设同时成立：archive 后 prompt 被 `blocked`、消息不落盘；unarchive 后恢复；无替代过滤接口。两个候选，留给 M11 与用户决定：
  - **(a)** 打开前 `unarchiveSession`、离开后重新 `archiveSession`；打开期间主题会出现在左侧栏。真实 UI 点击与 `clearArchivedCurrent`（`dsh-client-ui-workspace/lib/client.js:1640`，reconcile 调用点 `:1578`）仍待 M11 实测。
  - **(b)** 采用 §8 的降级：主题会话保留在左侧栏，只把 reviewer 隐藏；CoWork 仍是主题列表与打开入口。
- **决定（2026-11-07）**：用户采用 (b)。实现与计划表述以 [会话可见性降级决策](../.agents/notes/implemented/feature/2026-11-07-topic-visibility-fallback.md) 为准；PLAN-V0.2 已按 (b) 修正。
- **M10（探针 4）。** `reviewer.reclaim` 默认必须是 **after-verdict**：创建后立即归档（`stopActivity:true`）的 reviewer turn 以 `blocked` 结束、无 verdict；先跑完 verdict 再归档正常。另：`archiveSession` 默认参数要求会话不活跃，回收须用 `stopActivity:true`（`dsh-workspace/lib/index.js:531-533`）。
- **M9（探针 1/5）。** 路由第三层用 `reasoningEffort="off"`、`maxTokens` 16–256、2s 超时，失败回退结构化候选/新建。工具面分两层：preset 行决定该 agent 注册什么；`agent.ctx.tools.restrict({deny})` 掩宿主全局与 preset 继承名，不能掩 agent 自身注册的工具；per-agent 视图必须 `schemas(agent)`。
- **M8（探针 2）。** `session/event` 的 `turn/end` 可用于更新 `lastActiveAt`；限制是仅宿主进程内、500 条缓冲未验证。
- **M11（探针 6）。** 面板写路由沿用 loopback + Origin/Host + JSON content-type + body 上限；真实 Chrome 已验证；`connection.fetch.register` 的 /api 通道可用、未认证 401；认证后 POST 未验证（launch token 属凭据），验收方式见 §6。
- **M10/M12（探针 7）。** reviewer 可读 clone；v1 继续 clone，worktree 需单独探针；M12 E2E 覆盖「创建 reviewer → verdict → 归档」与「(a)/(b) 选定的可见性路径」。

## 10. 复跑方法

```sh
# 0) 工具带已注入时先看探针列表；未注入由队长 dev_inject_plugin 注入（成员不重载）
curl -sS http://127.0.0.1:3080/dsh-cowork/m6/health
# 1) 逐个跑（timeoutMs 可选；P5/P7 建议 240000/300000）
for id in m6-1-llm m6-2-events m6-3-archive m6-4-reviewer m6-5-preset m6-6-panel m6-7-clone; do
  curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/run -H 'content-type: application/json' -d "{\"probeId\":\"$id\"}"
done
# 2) 读证据（runId 省略时取 index 最新）
curl -sS 'http://127.0.0.1:3080/dsh-cowork/m6/evidence?probeId=m6-3-archive'
# 3) 收尾（队长执行）：归档探针会话 → 卸载工具带
curl -sS -X POST http://127.0.0.1:3080/dsh-cowork/m6/cleanup
```

复跑会新建探针会话；P6 第二次运行会报 `/api` 路由已注册（按已注册处理，结果仍绿）。P7 每次创建并删除自己的 clone，不在仓库留下 `.md`。探针 5/7 的 preset id 每 run 唯一，重跑不会撞名。
