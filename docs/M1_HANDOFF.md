# M1 交接文档

- 适用：在全新会话/上下文中独立实现 M1 的 agent 或人。
- 状态：M0 已完成并验证；S0 已完成（结论见 [M1 S0 结果](M1_S0_RESULT.md)）；M1 的 S1–S6 待实现。
- 事实源：[PLAN](../docs/PLAN.md) 拥有范围与里程碑；[M0 结果](../docs/M0_PROBE_RESULT.md) 拥有五项 API 证据；[M1 提案](../.agents/notes/proposed/feature/2026-11-05-m1-master-thread-loop.md) 拥有 M1 契约；本文件只拥有“怎么开始、先验证什么、怎样算完成”。

## 先读什么

1. [AGENTS.md](../AGENTS.md) 的 M0/M1 纪律、命令、no-multi-orchestrator。
2. [docs/PLAN.md](../docs/PLAN.md) 的 §2.2 流程、§4.3 数据模型、§5.1–5.9、§6 M1 验收。
3. [docs/M0_PROBE_RESULT.md](../docs/M0_PROBE_RESULT.md) 的五项风险结论与限制。
4. [M1 提案](../.agents/notes/proposed/feature/2026-11-05-m1-master-thread-loop.md)：模块、数据模型、路由、handoff、preset 策略、验收标准。
5. [.agents/notes/README.md](../.agents/notes/README.md)：决策记录的骨架与迁移规则（模板已对齐 kit）。

## 现在的事实

- 仓库：`/Users/ray/Workspace/dsh-cowork`，`main` 已推送；M0 的实现是 host-only 探针插件，不是产品。
- M0 已证明：`prompt` 唤醒 idle（两轮 `turn/end`）、`create` 的侧栏可见性、运行时 preset 注册/选择、两个会话读同一原子 store、worktree 会话可读可写。
- M0 纠正：`sessionController.create` 必须传 `workspaceId` 才挂 workspace；DSH 0.2.13+ 没有全局 `allowedRoots`（可写根=会话 cwd + `/tmp` + tmpdir）；`patchReload` 是死配置，真实热重载开关是 `dsh-hmr`。
- 宿主：DSH Desktop **2.0.18** / 核心 **0.2.1-rc.2**；web profile 运行在 `http://127.0.0.1:3080`；`DSH_HOME=/Users/ray/.dsh`；仓库 workspaceId 实测 `70ec5443-a9e2-4368-9cce-ae06d9babb9e`。
- 构建：`npm run build` 从 DSH 源码 checkout（`/Users/ray/Workspace/deepseek-harness`）取类型、从已安装 app 取运行时链接；不需要调用者设置 `DSH_CHECKOUT`。
- 检查：`npm run check` / `npm test` / `npm run typecheck` / `npm run build` / `npm run check:self-test` 全绿（M0 收口时 13 tests、8 个自测负控）。
- 探针当前处于注入状态（`dev_injected_list` 可见）；`cowork_probe` 工具与 `/dsh-cowork/probe/{health,run,status}` 路由仍在。重启宿主后若消失，按下面的命令重新注入。

## M1 目标与非目标

**目标**：按提案落地 M1 §6 闭环——`cowork_project_init` 建索引并登记 master；master 调 `cowork_route` 命中或新建 thread；thread 调 `cowork_handoff` 让 master 收到结构化消息；两个 preset 可用；纯模块有单测；真实 DSH E2E。完成定义与验收编号见提案的 `## Acceptance criteria`。

**非目标**：项目记忆、worktree、独立 review、客户端面板、desktop profile、bundle 持久化、模型辅助路由、定时任务；不引入 AgentTeams 或其他协作运行时。

## 环境与命令

```sh
cd /Users/ray/Workspace/dsh-cowork
npm run check              # 约定/文档/note 门禁
npm test                   # 契约与纯模块单测
npm run typecheck          # 类型检查（内部复用 build --no-emit）
npm run build              # host 构建；会触发 dev 注入的自动重载
npm run check:self-test    # 证明守卫能变红

# 重新注入探针（若宿主重启后不在）
dev_inject_plugin /Users/ray/Workspace/dsh-cowork
curl -sS http://127.0.0.1:3080/dsh-cowork/probe/health
# 卸载（确认不再需要探针证据时）
dev_uninject_plugin dsh-cowork
```

本部署的工具挂在 preset 的 `plugins` 列表里（`/Applications/DSH Desktop 2.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`）；读这一份清单再决定 `cowork-master`/`cowork-thread` 的组合。不要手改 `/Users/ray/.dsh/profiles/web/package.json` 或 `cordis.patch.yml`。

## 第一步：S0 探针（已完成）

结论见 [M1 S0 结果](M1_S0_RESULT.md)：空 `plugins` preset 能跑一轮但只有全局工具；`standard` 的结构化 `plugins` 不可得，只有 YAML 文本；`exec.agent` 在 standard 与空 preset 下都可用。下面的原始步骤保留为复跑说明。

M1 的最大未知是 preset 组合；不要跳过它直接写 `cowork-thread`。

1. **空 `plugins` preset 能否跑一轮**：在 `src/probe-engine.ts` 增加一个阶段：`create({agentPreset:'cowork-probe'})` 后 prompt 一句“只回复 `COWORK_PROBE_PRESET_OK`，并说明你能看到哪些工具”，等 `turn/end` 且 reason 为 `completed`；记录 assistant 文本与它实际调到的工具。把结论拆成两问：(a) 能否完成一轮；(b) 实际能看到哪些工具。能跑一轮但没有 bash/fs 等 preset-scoped 工具，空 preset 仍不可用于 thread。
2. **能否克隆 standard**：在探针里输出 `ctx.get('agentPresets').resolve('standard')` 的可枚举结构（尤其是 `plugins` 是否为数组、是否含 `!!js` 表达式）以及 `list()` 中每个 preset 的形状。若可拿到 `plugins`，`cowork-master`/`cowork-thread` 用克隆 + persona 覆盖；若拿不到，退回 bundle patch 声明完整 preset 行，并记录代价。
3. **调用者身份**：注册一个临时工具，返回 `exec.agent?.id`、`exec.agent?.session?.header?.cwd`、`Object.keys(exec)`，从 master 与 thread 各调一次。M1 的项目发现与角色校验依赖这个结果；拿不到就 fail closed，不猜项目。

S0 的结论写进提案（若与假设冲突，更新提案；提案尚未落地，允许改）和 M0/M1 证据文档；把探针代码的临时改动放在独立提交或 worktree，别混进 store/router/handoff 的实现。

## 实施顺序

按提案的 Delivery stages 执行；每阶段独立提交并可回退：

1. **S1 store**：`src/store.ts` + 单测（原子写、锁、损坏 JSON、重放标记）。
2. **S2 session-slice**：`src/session-slice.ts`；workspace 解析与 create/prompt/rename/list。
3. **S3 router**：`src/router.ts` + 单测（token 化、阈值、候选排序、排除 done/archived）。
4. **S4 handoff**：`src/handoff.ts` + 单测（必填、投递、失败保留、重放）。
5. **S5 tools + presets**：`src/tools.ts`、`src/presets.ts`、`src/index.ts` 装配；六个工具在真实宿主跑通提案的 A1–A4、A8。
6. **S6 文档与证据**：M1 结果、限制、未验证项写 docs；`docs/publish.json` 分类；检查全绿。

**并行写建议**：S1/S3/S4 的模块天然不相交，可以用 `worktree_create` 分给不同成员并行写，合并由队长独占；S2 依赖 S0，S5 依赖 S1/S2/S3/S4。每个实现任务写清 inScope（显式路径）、verify（本层检查）、acceptance；实现者不得自审，验证与审查分给不同人。

## 陷阱（M0 实测，按需回看 M0 note）

- `create({cwd})` 不挂 workspace；要 `workspaceId`。`workspaceRegistry.resolveByPath` 取 id；没有 workspace 时由 init 创建。
- 运行时 `agentPresets.register` 重启即消失；M1 用它做注入态 E2E，持久化留 M4。
- 没有 `allowedRoots`；不要按 PLAN 旧描述设计路径白名单。
- `patchReload` 不存在；`dev_inject_plugin` 即时生效，正式安装后需重启。
- `npm run build` 会触发自动重载并清空进程内 run 状态；磁盘 `last-run.json`/`runs/<runId>.json` 仍在。
- 探针创建的会话与 `.dsh-cowork/` 数据是证据；不要删除。`.dsh-cowork/` 已 gitignore。
- 文档新增/改名必须在 `docs/publish.json` 分类；note 模板已对齐 kit，标题/头部/章节/criterion id 都有门禁。
- 工具执行面拿不到 `exec.agent` 时不要猜测“当前项目”；返回明确错误。
- `sessionController.prompt` 的 `accepted:true` 只代表入队，E2E 必须等 `turn/end`。

## 验证与证据

- 每个阶段：`npm run check` + `npm test`；source 变更加 `npm run typecheck` + `npm run build`。
- M1 E2E：真实宿主上跑提案 A1–A4；证据含 sessionId、turn/end seq、`workspace.sessionIds`、handoff 文件路径、master 收到的消息文本。跨会话断言不得用同进程 mock。
- 文档：M1 的结果与限制写入 `docs/`；新增文件在 `docs/publish.json` 分类；M1 提案按 note 规则迁移到 `implemented/`（同一交付内改写为现在时）。
- 审查：实现者 ≠ 验证者 ≠ 最终审查者；审查者读源码与原始证据，不只看自述。

## 未决问题（实现前先确认）

1. S0 的 preset 组合结论：空 preset 是否可用、能否克隆 standard。
2. master 是否需要硬性写工具限制；若 preset scope 内能 `ctx.tools.restrict`，加；否则文档写明“prompt 级”。
3. 仓库没有 workspace 时，init 是否创建 workspace（本机已有 `70ec5443-…`，但新机器/新仓库会缺）。
4. route 的默认阈值 4 与“比第二名高 ≥1”是否需要按真实样本调整。
5. handoff 投递失败的重放上限与退避（M1 可以先只做“status 时重试一次”）。
6. M1 是否保留 M0 的探针路由/工具；建议保留到 M1 E2E 结束，再在同一交付里移除或改名，避免与正式 API 冲突。
7. 探针会话（30+）是否归档；删除会话不可逆，先不删。

## 完成定义

- 提案 A1–A8 全部有真实证据；PLAN §6 的五条 E2E 全过。
- `npm run check` / `test` / `typecheck` / `build` / `check:self-test` 全绿。
- M1 结果与限制写入 docs；提案迁移到 `implemented/` 并保持 current。
- 不进入 M2；不引入第三方协作运行时；不修改 `docs/PLAN.md`。

## 清理与回滚

- 代码回退：按提交 revert；M0 的探针在 M1 替换前可保留。
- 运行时：`dev_uninject_plugin dsh-cowork` 移除注入；`.dsh-cowork/` 是项目数据，除非确认不要，不要删。
- 会话：探针会话保留作证据；归档用 `sessionController.archiveSession`，不要直接删除。
