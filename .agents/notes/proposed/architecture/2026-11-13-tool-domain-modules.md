# Proposal: 按工具 → 领域模块重组 src、tests、scripts

Status: proposed
Date: 2026-11-13
Class: architecture

## Problem

当前 `src/` 按文件名平铺混合了四类职责：公共工具定义、领域规则、宿主适配、持久化。工具模块与领域模块没有目录边界，测试与脚本也按实现文件而不是工具/领域命名。具体成本：

- [tools.ts](../../../../src/app/tools.ts) 只做装配，但 22 个工具分散在 7 个 `*-tools.ts` 中，其中 `topic-tools.ts` 同时注册 topic、handoff、decision、authorization、notices 五类工具；`checkout-tools.ts` 同时拥有 work-item 与 merge。看一个工具的完整路径要在 3–5 个平铺文件之间跳转。
- 领域规则没有独立目录：`topic.ts`、`routing.ts`、`review-request.ts`、`work-item.ts`、`checkout.ts`、`notices.ts`、`memory.ts` 与工具文件和宿主适配同层；`domains` 没有可执行的 import 方向约束。
- 测试按实现文件命名（`topic-tools.test.mjs`、`project-tools.test.mjs`、`request-service.test.mjs`），无法从目录看出“哪个工具、哪个领域”；repo 级守卫（`dev-gate`、`source-budget`、`coverage-policy`、`packaging`、`workflow`）与单元/契约测试混在 `tests/` 顶层。
- `scripts/` 平铺 5 个文件，名字按产物而非证据面（`build.sh`、`test-coverage.mjs`、`host-smoke.mjs`、`change-scope.mjs`），新增一个 gate 只能继续往同一层堆。
- 50 KiB 读上限已经迫使 `notice-store`、`request-store`、`inbox-api`、`review-tools`、`memory-tools`、`tool-runtime`、`checkout-teardown` 等模块按字节拆分，而不是按领域拆分；新的贡献者没有规则判断“这个文件应该放哪里”。
- 待合并的 PR #33 又新增了 `config`、`dev-surfaces`、`delivery`、`api-types`、m12 拆分模块；如果先不定义结构，它们会沿用平铺命名。

结果是：新增一个工具需要先找同类工具文件、再找领域文件、再找 store 与测试；review 无法从路径判断改动落在哪一层；`domains` 无宿主依赖这条约束只能靠记忆，不能由测试证明。

## Proposal

把 `src/` 固定为明确的目录层次，并让 `tests/` 镜像同样的层；`scripts/` 按证据面分组（脚本不是工具，不强行造 domain）。本提案只定义目标结构与迁移规则，**不执行任何目录移动**。

### 目标树

```text
src/
  index.ts                 # 包入口：只 re-export apply 与公共入口
  app/                     # 组装根：config、apply、tools 装配、presets、dev 面
  platform/                # 宿主适配：tool-runtime、tool-model、session-slice、
                           # llm-port、topic-events、memory-prompt、request-open
  store/                   # 持久化与文件层：project-store、schema、migration、
                           # atomic-json、activity、inbox、notice-store、request-store
  domains/                 # 纯规则：不 import 宿主、store、tools、panel
    project/
    routing/
    topic/
    requests/
    review/
    isolation/             # work-item + checkout + teardown
    memory/
    notices/
  tools/                   # 每个工具族一个模块：schema + 角色门 + 结果映射
  panel/                   # wire 契约与 HTTP 面：api、contracts、types、inbox-api
  dev/                     # M12 E2E 与探针驱动
  client/                  # 浏览器半边保持不变
```

`src/index.ts` 保留在根，`package.json` 的 `main`/`exports` 与 `lib/index.js` 不变；`app/apply.ts` 只做依赖装配，`app/config.ts` 只有 Config 类型族与默认值。

### 工具 → 领域映射

| 公共工具族 | `tools/` 模块 | 领域 | 说明 |
|---|---|---|---|
| `project_init` / `project_status` | `tools/project.ts` | `domains/project/` | status 的 bounded 读取留在领域读模型 |
| `route` | `tools/route.ts` | `domains/routing/` | 模型兜底端口由 `platform/llm-port` 注入 |
| `topic_create` / `topic_list` / `topic_resolve` / `topic_report` / `handoff` / `decision_propose` | `tools/topic.ts` | `domains/topic/` | `thread_*` 别名与 topic 工具同模块 |
| `authorization_request` / 四类 request 工具 | `tools/request.ts` | `domains/requests/` | authorization 决策核心在 requests 域，不拆回 topic |
| `work_item_create` / `checkout_merge` | `tools/isolation.ts` | `domains/isolation/` | git clone/merge 是领域端口，宿主 runner 在 platform |
| `review_request` / `review_verdict` | `tools/review.ts` | `domains/review/` | reviewer 会话生命周期留在 platform/session 面 |
| `memory_write` / `memory_search` | `tools/memory.ts` | `domains/memory/` | prompt 注入适配在 platform |
| `notices` | `tools/notices.ts` | `domains/notices/` | 通知账本/投递在 notices 域 |

规则：一个 `tools/` 模块可以组合多个领域（例如 topic 工具会调用 notices），但**不得**自己持有状态机、文件 I/O 或持久化格式；领域模块之间通过纯类型/纯函数协作，跨域副作用由 `platform` 的端口适配。

### tests 镜像

```text
tests/
  tools/<family>.test.mjs
  domains/<domain>/*.test.mjs
  platform/*.test.mjs
  store/*.test.mjs
  panel/*.test.mjs
  dev/*.test.mjs
  guards/                  # dev-gate、source-budget、coverage-policy、packaging、workflow、change-scope、host-smoke
  support/                 # ts-hook、fixtures、public-surface
```

- 测试文件只按被测层命名；跨层契约测试放 `tests/platform` 或 `tests/guards`，不塞进 `tools/`。
- 当前 flat 文件名迁移到对应目录；公共面清单继续只由 [tests/support/public-surface.mjs](../../../../tests/support/public-surface.mjs) 定义。

### scripts 按证据面分组

```text
scripts/
  build/     build.sh, build-client.mjs
  evidence/  test-coverage.mjs, host-smoke.mjs
  review/    change-scope.mjs
```

脚本没有工具/领域语义，不以 `tools/`/`domains/` 命名；按 `build`、`evidence`、`review` 三个证据面分组，`package.json` 与 [tools/workflow.json](../../../../tools/workflow.json) 的命令同步。

### import 方向

```text
index → app → tools / panel / dev → platform / domains / store
domains → 纯类型与纯函数（不 import @deepseek-ai/*、node:fs、store、platform、tools、panel）
platform → domains / store
store → schema / atomic-json
```

- 禁止用 `index.ts`  barrel 把目录再导出；公共入口只有 `src/index.ts`，其余用直接路径。
- 新增 `tests/architecture.test.mjs`：扫描 `src/**/*.ts` 的 import，证明方向规则、无环、domains 无宿主依赖；并断言 `tests/support/public-surface.mjs` 的工具/路由/预设清单在移动前后不变。

### 迁移阶段（未执行）

0. **冻结映射**：把当前每个 `src/`、`tests/`、`scripts/` 文件登记到目标位置；先改测试发现为递归（`node --test` 与 [scripts/test-coverage.mjs](../../../../scripts/test-coverage.mjs) 的 `testFilesIn` 当前只读顶层），再移动任何测试。
1. **移动 store 与 platform**：路径 + import 机械更新，行为不变；跑 `npm test` 与 `npm run check`。
2. **移动 domains**：纯规则先落目录；新增 import 方向测试；跑领域测试。
3. **移动 tools 与 tests**：工具装配、测试镜像、`tools.ts` 更新；公共面测试证明 22 工具/10 路由/3 preset 不变。
4. **移动 scripts 与命令**：`package.json`、workflow、docs 命令同步；`test:coverage`/`test:host-smoke` 在新路径可用。
5. **清理旧路径与文档**：删除空目录；更新当前文档的源路径；历史 handoff/notes 里的链接只改目标路径，不改结论。

每一阶段单独可交付、可回滚；不把 4 个阶段压成一个 80 文件 diff。

### 与 PR #33 的关系

PR #33 的 `config.ts`、`dev-surfaces.ts`、`delivery.ts`、`api-types.ts`、`m12-e2e-*` 按本结构分别落 `app/`、`platform/`/`domains/`、`panel/`、`dev/`。如果 #33 先合并，迁移阶段直接按目标树搬；如果本提案先批准，#33 合并时按目标路径解决冲突，不把新文件放回平铺根。

## Alternatives considered

**保留平铺，只用 `prefix-` 命名（`tool-*.ts` / `domain-*.ts`）。** 否决：不增加目录边界，import 方向仍无法由测试约束；`domains` 无宿主依赖只能靠 review 记忆；测试与脚本仍按实现文件命名。

**按 feature 目录（`src/<feature>/` 内同时放 tool、domain、store、panel）。** 否决：会把宿主 I/O 与纯规则重新混在一起，无法实现“domains 不 import 宿主”；跨 feature 共享（notices、requests、store）会产生环；现有 50 KiB 拆分也会被迫按 feature 而非职责。

**只搬 tests 与 scripts，src 保持平铺。** 否决：工具 → 领域的映射仍不可见，测试目录只能镜像错误的边界；这是最少的改动，但不解决问题。

**一次性大迁移。** 否决：80+ 文件路径变化、历史文档链接、测试发现、构建路径会混在一个 diff 里；review 无法证明“只有路径变化”。必须按 import 方向分阶段。

**每个目录加 `index.ts` barrel。** 否决：barrel 会把 50 KiB 上限藏起来并制造环；公共入口只保留 `src/index.ts`。

**把 scripts 也按工具/领域命名。** 否决：脚本没有工具调用语义；按证据面（build/evidence/review）分组才与 [tools/workflow.json](../../../../tools/workflow.json) 的 surface 对齐。

## Acceptance criteria

- [A1] 目标树、工具 → 领域映射和当前每个文件的去向已登记；没有“未分类”文件 — `source`：[tools.ts](../../../../src/app/tools.ts)、`decisions`
- [A2] 新增 import 方向测试：`tools → domains/platform`、`domains` 不依赖宿主/store/tools/panel、`platform → domains/store`、无环 — `tests`：[tests/support/public-surface.mjs](../../../../tests/support/public-surface.mjs)
- [A3] 22 个工具名与注册顺序、10 条面板路由、3 个 preset、3 个 `exports` 键在移动前后完全一致 — `tests`、`packaging`：[package.json](../../../../package.json)
- [A4] 测试发现改为递归后，`npm test` 与 `npm run test:coverage` 仍覆盖全部测试；顶层 glob 遗漏一条测试即失败 — `tests`：[scripts/test-coverage.mjs](../../../../scripts/test-coverage.mjs)
- [A5] `scripts/` 按 build/evidence/review 分组，`package.json`、`tools/workflow.json` 与 [docs/testing.md](../../../../docs/testing.md) 的命令指向新路径 — `workflow`
- [A6] `npm run build` 仍产出 `lib/index.js` 与 `lib/client.js`；`npm run test:host-smoke` 仍能安装 tarball 并启动 — `packaging`
- [A7] 所有 `src/**/*.ts` 仍 <50 KiB；`source-budget` 的 48 KiB 目标不被 barrel 绕过 — `source`
- [A8] 当前文档中的源路径更新；历史记录只改链接目标，`npm run check` 的 markdown-links 通过 — `workflow`
- [A9] 迁移分 6 个可独立回滚的阶段（Stage 0–5）；每阶段结束 `npm test`/`typecheck`/`check` 通过，最终阶段跑 coverage/build/host-smoke — `tests`
- [A10] 本提案在阶段 0 完成后才移到 `implemented/`；未执行前保持 `proposed` — `decisions`

## Risks

- **测试发现静默漏跑**：`package.json` 的 `test` 当前是 `node --test tests/*.mjs`，[scripts/test-coverage.mjs](../../../../scripts/test-coverage.mjs) 的 `testFilesIn` 只读顶层；移动测试前必须先改递归发现，并用一条“故意放子目录”的负例证明会跑到。
- **50 KiB 不是目录能解决的**：移动不改变字节；禁止用 `index.ts` barrel 掩盖体积，现有 48/50 KiB 拆分保持。
- **历史文档链接**：大量 handoff/note 链接指向 `src/`、`tests/`、`scripts/` 旧路径；只改链接目标、不改结论；当前文档与历史记录分开处理，`npm run check` 必须绿。
- **PR #33 的合并顺序**：本提案与 #33 都改路径；先合 #33 再迁移，或在迁移分支上吸收 #33 的新文件；不要在 #33 未合时把新文件放回平铺根。
- **公共面漂移**：工具名/顺序、路由、preset、包入口都是发布契约；迁移阶段必须用 public-surface 测试与 packaging 测试锁住。
- **import 环**：`domains` 与 `platform` 的端口类型若互相 import 会成环；共享类型放 `domains/<x>/contract` 或 `panel`，由方向测试兜底。
- **成本**：这是一次 80+ 文件的机械迁移，重复 review 成本高；因此分阶段、每阶段单独合并，不追求一次到位。

## Delivery stages

1. **Stage 0 — 映射与测试发现**：登记去向，递归测试发现 + 负例；不动源码目录。
2. **Stage 1 — store/platform**：移动持久化与宿主适配，import 机械更新；`npm test` + `npm run check`。
3. **Stage 2 — domains**：纯规则落目录，新增 import 方向测试；领域测试。
4. **Stage 3 — tools 与 tests**：工具族模块、测试镜像、公共面锁定；`npm test` + coverage。
5. **Stage 4 — scripts 与命令**：build/evidence/review 分组，package/workflow/docs 同步；build + host-smoke。
6. **Stage 5 — 清理与文档**：删旧路径、更新当前文档链接、历史记录只改链接目标；`npm run check` + 全量证据。
