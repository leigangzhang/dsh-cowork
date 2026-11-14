# 工具 → 领域模块：Stage 0 前置核查与去向登记

- 状态：**Stage 0 完成（2026-11-14）**。本文件是 [TOOL_DOMAIN_MODULES_HANDOFF.md](TOOL_DOMAIN_MODULES_HANDOFF.md) 要求的执行前置：登记 `src`/`tests`/`scripts` 每个文件的去向，并记录可复核的门禁基线。执行事实以本文件与各 Stage 的 commit/证据为准。
- 提案：[2026-11-13-tool-domain-modules.md](../../.agents/notes/proposed/architecture/2026-11-13-tool-domain-modules.md)。
- 基线：`origin/main` `9231d565ed9ce13df7c75187178696ec0726aafa`（PR #33、#34、#35 均已合并）；工作分支 `agent/tool-domain-modules`；工作树干净（`git status --porcelain` 0 行）。
- 基线空 diff：`git diff --binary origin/main..HEAD | shasum -a 256` = `e3b0c442…b855`（空输入哈希）。

## 前置条件核查

| 条件 | 证据 | 结果 |
|---|---|---|
| 递归测试发现（`npm test`） | 临时把 `tests/_stage0_probe/nested.test.mjs` 放进子目录，`node --test "tests/**/*.test.mjs"` 输出 `ok 1 - nested discovery probe`；运行 987 条（基线 986 + 探针 1）；删除后残留 0 | 通过 |
| 递归测试发现（coverage） | `scripts/test-coverage.mjs` 的 `testFilesIn('tests')` 返回该嵌套探针；`tests/coverage-policy.test.mjs` 已含 `nested/deeper` 负例 | 通过 |
| 干净 worktree check | `npm run check:clean` → `PASS check:clean: 304 files from the worktree without .dsh-cowork/ or lib/`，exit 0 | 通过 |
| 架构测试 | `node --test tests/architecture.test.mjs` → 6 pass：import 解析、无环、entry sink、client 边界、contract 边界、工具归属；每条都带合成反例 | 通过 |
| 公共面快照 | `node --test tests/public-surface.test.mjs` → 22 工具 / 10 路由 / 3 preset / 3 exports，2 pass | 通过 |
| 基线测试 | `npm test` → 986 tests, 986 pass, 0 fail，exit 0 | 通过 |
| 基线门禁 | `npm run check` → exit 0；`npm run typecheck` → exit 0 | 通过 |

前置条件全部成立；`#33`、`#35` 已合并，迁移基线就是当前 `origin/main`。

## 目标树与文件去向

### `src/`（60 个现有文件 → 目标位置）

| 层 | 现有文件 | 去向 |
|---|---|---|
| entry | `index.ts` | `index.ts` 只保留 re-export；装配体移到 `app/apply.ts` |
| app | `config.ts`、`tools.ts`、`dev-surfaces.ts` | `app/config.ts`、`app/tools.ts`、`app/dev-surfaces.ts` |
| platform | `tool-runtime.ts`、`tool-model.ts`、`session-slice.ts`、`session-visibility.ts`、`llm-port.ts`、`topic-events.ts`、`memory-prompt.ts`、`workspace-repair.ts`、`presets.ts`、`preset-visibility.ts` | `platform/` 同名 |
| store | `store.ts`、`store-schema.ts`、`store-migration.ts`、`atomic-json.ts`、`activity.ts`、`inbox.ts`、`notice-store.ts`、`request-store.ts` | `store/project-store.ts`、`store/schema.ts`、`store/migration.ts`、`store/atomic-json.ts`、`store/activity.ts`、`store/inbox.ts`、`store/notice-store.ts`、`store/request-store.ts` |
| domains/topic | `topic.ts`、`handoff.ts` | `domains/topic/topic.ts`、`domains/topic/handoff.ts` |
| domains/routing | `routing.ts`、`router-model.ts` | `domains/routing/routing.ts`、`domains/routing/router-model.ts` |
| domains/requests | `request-schema.ts`、`request-lifecycle.ts`、`request-service.ts`、`authorization-decision.ts`、`request-support.ts`、`request-open.ts` | `domains/requests/` 同名 |
| domains/review | `review-request.ts` | `domains/review/review-request.ts` |
| domains/isolation | `work-item.ts`、`checkout.ts`、`checkout-teardown.ts` | `domains/isolation/` 同名 |
| domains/memory | `memory.ts` | `domains/memory/memory.ts` |
| domains/notices | `notices.ts`、`delivery.ts` | `domains/notices/notices.ts`、`domains/notices/delivery.ts` |
| tools | `project-tools.ts`、`topic-tools.ts`、`route-tools.ts`、`request-tools.ts`、`memory-tools.ts`、`checkout-tools.ts`、`review-tools.ts` | `tools/project.ts`、`tools/topic.ts`、`tools/route.ts`、`tools/request.ts`、`tools/memory.ts`、`tools/isolation.ts`、`tools/review.ts` |
| panel | `api.ts`、`api-types.ts`、`api-contract.ts`、`inbox-contract.ts`、`notice-contract.ts`、`inbox-api.ts`、`probe-model.ts` | `panel/` 同名 |
| dev | `m12-e2e.ts`、`m12-e2e-contract.ts`、`m12-e2e-driver.ts`、`m12-e2e-evidence.ts`、`m12-e2e-prompts.ts`、`m12-e2e-support.ts`、`panel-probe.ts` | `dev/` 同名 |
| client | `client/**` 12 个文件 | 原地不动 |

无未分类文件。`domains/project/` 目前没有独立的纯规则模块：`cowork_project_*` 的读模型留在 `tools/project.ts`，等出现第二个调用方再拆，不凭空新建空目录。

### 与提案目标树的偏差（有意、可复核）

1. `presets.ts` / `preset-visibility.ts` 放 `platform/` 而不是 `app/`。`platform/tool-runtime.ts` 与 `dev/m12-e2e-*` 都消费 preset id/rows；放 `app/` 会让 `platform` 反向依赖 `app`。preset 是宿主 `agentPresets` 注册数据，属于平台适配。
2. `delivery.ts` 放 `domains/notices/`。它是通知与收件箱共享的重试原语，没有宿主依赖；`store/inbox.ts` 从 store 引用纯领域原语，`notices` 与本模块同域。
3. `request-open.ts` 从提案的 `platform/` 移到 `domains/requests/`。它只做请求卡到仓库内文件的路径解析与打开端口调用，`request-service.ts` 的薄 re-export 因此不再产生 domain → platform 反向依赖。
4. 三个 handoff 记录类型（`HandoffRecord`/`HandoffStatus`/`HandoffVerification`）从 `store/project-store.ts` 移到 `store/schema.ts`；`domains/topic/handoff.ts` 只依赖纯 schema，不再引用 project store。

### `tests/` 镜像（68 个测试 + 4 个 support）

| 目标目录 | 测试 |
|---|---|
| `tests/tools/` | `project`、`project-init`、`topic`、`route`、`request`、`review-verdict` |
| `tests/domains/topic/` | `topic`、`handoff` |
| `tests/domains/routing/` | `routing`、`router-model` |
| `tests/domains/requests/` | `request-schema`、`request-service`、`authorization-transaction` |
| `tests/domains/review/` | `review-request-gate`、`review-request-model` |
| `tests/domains/isolation/` | `checkout`、`work-item-create`、`work-item-merge`、`work-item-model`、`teardown`（原 `tools.test`） |
| `tests/domains/memory/` | `memory` |
| `tests/domains/notices/` | `notices`、`delivery` |
| `tests/store/` | `store`、`store-v2`、`store-migration`、`store-schema`、`atomic-json`、`request-store`、`activity`、`inbox` |
| `tests/platform/` | `tool-model`、`session-slice`、`session-visibility`、`llm-port`、`memory-prompt`、`topic-events`、`workspace-repair`、`presets`、`preset-visibility` |
| `tests/panel/` | `api-auth`、`api-contract`、`api-read`、`api-types`、`api-write`、`inbox-api`、`inbox-contract`、`probe-model` |
| `tests/client/` | `inbox-model`、`notice-model`、`panel-model` |
| `tests/dev/` | `m12-e2e` |
| `tests/app/` | `open-port`（`index` 公开出口） |
| `tests/guards/` | `architecture`、`source-budget`、`coverage-policy`、`packaging`、`workflow`、`dev-gate`、`public-surface`、`tool-schema-budget`、`change-scope`、`clean-check`、`gate-artifact`、`host-smoke`、`marker-check`、`m12-migration-drill`、`typecheck-policy` |
| `tests/support/` | `ts-hook.mjs`、`fixtures`、`inbox-fixtures.mjs`、`public-surface.mjs` 原地保留 |

`tests/client/` 与 `tests/app/` 是提案清单未列出的镜像目录：前者对应不动的 `src/client/`，后者对应装配根；没有把它们的测试塞进 `guards/` 或 `platform/`。

### `scripts/` 按证据面（7 个文件）

| 目标目录 | 脚本 |
|---|---|
| `scripts/build/` | `build.sh`、`build-client.mjs` |
| `scripts/evidence/` | `test-coverage.mjs`、`host-smoke.mjs`、`clean-check.mjs` |
| `scripts/review/` | `change-scope.mjs`、`gate-artifact.mjs` |

`package.json` 与 [tools/workflow.json](../../tools/workflow.json) 的命令在 Stage 4 同步；脚本内的 `ROOT` 相对路径同时从 `..` 改成 `../..`。

## 公共面与门禁基线

- 22 个工具按注册顺序固定；10 条面板路由；3 个 preset（`cowork-master`/`cowork-topic`/`cowork-reviewer`）；3 个 `package.json` exports（`.`、`./client`、`./package.json`）。
- `src/index.ts` 是唯一 host entry（≤30 KiB，无嵌套 `index.ts` barrel）；每个 `src/**/*.ts(x)` <50 KiB。
- 基线 `npm test` 986 条；Stage 1–5 每阶段结束重跑 `npm test`、`npm run check`、`npm run typecheck`，Stage 3 加 coverage，Stage 4 加 build + host-smoke，Stage 5 全量。

## Import 方向契约（Stage 2 起的可执行断言）

```text
index.ts          → app
app/**            → tools / panel / dev / platform / domains / store
tools|panel|dev/**→ platform / domains / store / 纯契约叶
platform/**       → domains / store / 纯契约叶
store/**          → domains / 纯契约叶
domains/**        → domains / 纯契约叶
client/**         → client / 纯契约叶
```

纯契约叶（不 import 宿主、I/O，只互相引用）：`store/schema.ts`、`panel/api-contract.ts`、`panel/inbox-contract.ts`、`panel/notice-contract.ts`、`platform/tool-model.ts`。

三条有意登记的例外，由架构测试逐条列出、不得增长：

1. `domains/requests/{request-lifecycle,authorization-decision,request-open}.ts` 直接构造 `store/request-store.ts`。请求卡文件是请求域自己的持久化端口；把它拆成注入端口会改公开调用签名，超出“路径 + import 机械迁移”的范围。
2. `domains/{isolation/work-item,requests/authorization-decision,requests/request-lifecycle}.ts` 引用纯事件构建器 `store/activity.ts`。该模块不读文件、不读时钟，是 schema + notice 描述符的纯函数。
3. `domains/isolation/checkout.ts` 与 `domains/requests/request-open.ts` 直接使用 `node:fs`/`node:child_process`：前者拥有 clone/merge 的 git 与目录守卫，后者做打开文件的路径/符号链接校验；其余 domain 禁止 `node:fs`/`node:child_process`。

`DOMAINS` 的硬禁止：`@deepseek-ai/*`、`app`、`tools`、`dev`、`index`、`panel` 运行时模块、`platform`（除 `tool-model.ts`）、`store/project-store.ts` 及其余 store 运行时模块。项目索引 store 不得被任何 domain 直接引用。

## 阶段停止条件

每个 Stage 单独 commit；结束条件全部满足才进入下一阶段：

1. `npm test` 通过，测试数与公共面快照不变（Stage 3 只允许测试路径变化）。
2. `npm run check` 通过（clean 副本在 Stage 4/5 复跑）。
3. `npm run typecheck` 通过；涉及 `src/` 的阶段加 `npm run build`。
4. 记录 HEAD、`git diff --binary <stage-base>..HEAD | shasum -a 256`、`git status --porcelain` 到 commit 正文或结果记录。

出现红色阶段时停止，不带红色进入下一阶段；回滚按 Stage 逆序 `git revert`。
