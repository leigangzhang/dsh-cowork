# 工具 → 领域模块迁移结果

- 状态：**已迁移**（2026-11-14）。执行依据是 [TOOL_DOMAIN_MODULES_HANDOFF.md](TOOL_DOMAIN_MODULES_HANDOFF.md)，Stage 0 映射与前置证据见 [TOOL_DOMAIN_MODULES_RECON.md](TOOL_DOMAIN_MODULES_RECON.md)，决策记录见 [tool-domain-modules](../../.agents/notes/implemented/architecture/2026-11-13-tool-domain-modules.md)。
- 基线：`origin/main` `9231d565ed9ce13df7c75187178696ec072a6afa`（PR #33/#34/#35 已合并）；工作分支 `agent/tool-domain-modules`。
- 结构：`src/` 61 个 host 模块 + 12 个 client 模块；`tests/` 68 个测试 + 4 个 support；`scripts/` 7 个入口。最大源文件 `src/store/project-store.ts` 49,266 B，低于 50 KiB 硬线。

## 阶段与 identity

| Stage | commit | 内容 | 与上一 Stage 的 diff sha |
|---|---|---|---|
| 0 | `60a1a5a` | 前置核查 + 全量去向登记，不移动代码 | （基于 `9231d56`，diff 为空） |
| 1 | `914de69` | store 与 platform 迁移 | `d466d5832102c6546be0144f9cd86e502cb10eb2dd4bde07e09070eac72aaa2d` |
| 2 | `30340cc` | domains 迁移 + 方向断言 | `bec6d2765bb89f6458309805a8e2ee81abd10c362dde883f442a88902f826b86` |
| 3 | `0b8aced` | tools/panel/dev/app、index 拆分、测试镜像 | `c729949a98314343f3b9ab160d8cbb277ca74bd0a254df5c293e451d4ca3d2d4` |
| 4 | `c0b7f2e` | scripts 分组与命令同步 | `79296ad0a170c2dbe78c59d859ff7468939027a2230ead6ef1356029b1600784` |
| 5 | 本文件所在 commit | 清理、文档、提案转 implemented | 最终 HEAD/diff sha 记录在 PR 描述 |

每个 Stage 只做路径与 import 机械更新（Stage 2 另含 handoff 类型移入纯 schema、request-open 归入 requests 域），没有改工具名/注册顺序、面板路由、preset、包入口或存储格式。

## 门禁结果

最终 HEAD 上依次执行，全部 exit 0：

| 命令 | 结果 |
|---|---|
| `npm test` | 989 tests / 989 pass / 0 fail |
| `npm run test:coverage` | 989 pass；重复运行观测 lines 68.2–70.9%、branches 83.50–83.52%、functions 84.27%（floor 65/82/80） |
| `npm run typecheck` | exit 0（host + client 两个 tsconfig） |
| `npm run build` | exit 0，产出 `lib/index.js` 与 `lib/client.js` |
| `npm run test:host-smoke` | `PASS host-smoke: 5/5 checks, plugin @dsh-external/dsh-cowork@0.2.0` |
| `npm run check` | `check-invariants: ok` |
| `npm run check:self-test` | `PASS project-rules: 17 negative controls` 等全部负例 |
| `npm run check:clean` | `PASS check:clean: 306 files ... without .dsh-cowork/ or lib/` |

公共面在迁移前后一致：22 个工具名与注册顺序、10 条面板路由、3 个 preset、3 个 `package.json` exports（[public-surface 快照](../../tests/support/public-surface.mjs)、[source-budget 预算](../../tests/guards/source-budget.test.mjs)）。

## 与目标树的偏差与保留例外

1. `presets`/`preset-visibility` 在 `platform/`；`delivery` 在 `domains/notices/`；`request-open` 在 `domains/requests/`。
2. handoff 记录类型移入 `store/schema.ts`，domain 不再引用 project store。
3. domain 仍允许两个 store 叶子：`store/request-store.ts`（请求卡持久化）与 `store/activity.ts`（纯事件构建器）；拆注入端口会改公开签名，超出机械迁移范围。
4. 只有 `domains/isolation/checkout.ts` 与 `domains/requests/request-open.ts` 可碰 `node:fs`/`node:child_process`；其余 domain 由架构测试禁止。
5. `domains/project/` 未拆：`cowork_project_*` 读模型仍在 `tools/project.ts`，等第二个调用方出现再拆。

上述例外在 [tests/architecture.test.mjs](../../tests/guards/architecture.test.mjs) 中逐条列出并带反例，不得无登记增长。

## 遗留风险

- 浏览器/面板 E2E 没有执行：本仓库没有可执行的浏览器 lane，`test:host-smoke` 只证明打包产物能启动并响应健康检查与未认证 401/403。
- coverage 的 line 百分比在重复运行间有约 2.7 个百分点的波动（Node 按测试文件分进程合并 coverage 的顺序差异），branch/function 稳定；四个 floor 仍有 3+ 个百分点余量，不阻塞门禁。
- 历史记录（`docs/handoff/`、`.agents/notes/`）只更新了链接目标，正文中的旧路径引用作为执行历史保留；当前文档、README 与 skills 已同步新路径。
- 两个 domain → store 叶子例外仍是未来重构点；出现第三个调用方或改相关签名时应重新评估。
- 本结果不自动合并，分支 push 后按 `pr-description` 提交 PR。

## 回滚

按 Stage 逆序 `git revert` 单个 commit，或关闭/删除 `agent/tool-domain-modules` 分支。迁移只改路径与 import，回滚不涉及数据迁移；Stage 4 同时回滚 `package.json` 与 [tools/workflow.json](../../tools/workflow.json) 的命令入口。
