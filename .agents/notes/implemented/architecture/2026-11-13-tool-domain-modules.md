# Decision: 按工具 → 领域模块重组 src、tests、scripts

Status: implemented
Date: 2026-11-13
Class: architecture

## Problem

`src/` 原先按文件名平铺，把公共工具定义、领域规则、宿主适配和持久化混在同一层；22 个工具散在 7 个 `*-tools.ts` 里，其中 `topic-tools.ts` 同时注册 topic、handoff、decision、authorization、notices 五类工具，`checkout-tools.ts` 同时拥有 work-item 与 merge。领域规则没有目录边界，`domains` 不依赖宿主的约束只能靠 review 记忆；测试按实现文件命名，repo 级守卫与单元/契约测试混在 `tests/` 顶层；`scripts/` 平铺，新增 gate 只能继续往同一层堆。

结果是一个工具的完整路径要在 3–5 个平铺文件之间跳转，新增工具无法从路径判断归属，50 KiB 拆分只能按字节而不是按职责进行。

## Decision

`src/` 固定为以下层次，`tests/` 镜像同一分层，`scripts/` 按证据面分组：

```text
src/index.ts                 # 包入口：只 re-export app/ 与 config 公开面
src/app/                     # 组装根：apply、config、tools 装配、dev 面
src/platform/                # 宿主适配：tool-runtime、tool-model、session-*、
                             # llm-port、topic-events、memory-prompt、presets、
                             # preset-visibility、workspace-repair
src/store/                   # 持久化与文件层：project-store、schema、migration、
                             # atomic-json、activity、inbox、notice-store、request-store
src/domains/                 # 纯规则：topic、routing、requests、review、isolation、
                             # memory、notices（delivery 同域）
src/tools/                   # 每个工具族一个模块：project、topic、route、request、
                             # memory、isolation、review
src/panel/                   # wire 契约与 HTTP 面：api、api-types、inbox-api、
                             # api-contract、inbox-contract、notice-contract、probe-model
src/dev/                     # M12 E2E、panel probe
src/client/                  # 浏览器半边不变
```

`tests/` 按被测层镜像：`tools/`、`domains/<domain>/`、`store/`、`platform/`、`panel/`、`client/`、`dev/`、`app/`、`guards/`，`support/` 原样保留。`scripts/` 分为 `build/`（build.sh、build-client.mjs）、`evidence/`（test-coverage、host-smoke、clean-check）、`review/`（change-scope、gate-artifact）。

Import 方向由 [tests/architecture.test.mjs](../../../../tests/guards/architecture.test.mjs) 执行：entry 只 re-export app；tools/panel/dev 不得 import app 或 entry；platform 不得 import tools/panel/dev；store 不得 import platform 及以上层；domains 只依赖 domains 与纯叶（store/schema、platform/tool-model、三个 wire contract），并单独列出两条请求/活动读模型例外；只有 `domains/isolation/checkout.ts` 与 `domains/requests/request-open.ts` 可碰 `node:fs`/`node:child_process`。每条规则都带合成反例。

四项与最初目标树的差异，按实际依赖登记：

- `presets.ts` 与 `preset-visibility.ts` 放 `platform/`：`tool-runtime` 与 M12 driver 消费 preset id/rows，放 `app/` 会让 platform 反向依赖 app。
- `delivery.ts` 放 `domains/notices/`：通知与收件箱共享的重试原语，无宿主依赖。
- `request-open.ts` 放 `domains/requests/`：它只做请求卡到仓库文件的路径解析与打开端口调用，放 `platform/` 会制造 domain → platform 的 re-export 边。
- handoff 记录类型从 `store/project-store.ts` 移到 `store/schema.ts`：domain 只引用纯 schema，不再引用项目 store。

## Alternatives considered

**保留平铺，只用 `prefix-` 命名（`tool-*.ts` / `domain-*.ts`）。** 否决：不增加目录边界，import 方向仍无法由测试约束，`domains` 无宿主依赖只能靠 review 记忆。

**按 feature 目录（`src/<feature>/` 内同时放 tool、domain、store、panel）。** 否决：会把宿主 I/O 与纯规则重新混在一起，无法实现“domains 不 import 宿主”；跨 feature 共享的 notices、requests、store 会产生环；50 KiB 拆分也会被迫按 feature 而非职责。

**只搬 tests 与 scripts，src 保持平铺。** 否决：工具 → 领域的映射仍不可见，测试目录只能镜像错误的边界。

**一次性大迁移。** 否决：80+ 文件路径变化、历史文档链接、测试发现、构建路径会混在一个 diff 里，review 无法证明“只有路径变化”；实际拆成 Stage 0–5 六个独立可回滚的 commit。

**每个目录加 `index.ts` barrel。** 否决：barrel 会把 50 KiB 上限藏起来并制造环；公共入口只保留 `src/index.ts`，`source-budget` 测试禁止嵌套 `index.ts`。

**把 scripts 也按工具/领域命名。** 否决：脚本没有工具调用语义；按证据面分组才与 [tools/workflow.json](../../../../tools/workflow.json) 的 surface 对齐。

## Consequences

- 新增模块先按层次定目录，review 可以从路径判断改动落在哪一层；import 方向、无环、工具归属不再依赖记忆。
- 迁移只改路径与 import，不改工具名/顺序、面板路由、preset、包入口或存储格式；22 工具/10 路由/3 preset/3 exports 保持不变。
- 两个持久化/读模型例外仍是 domain → store 的边：`store/request-store.ts`（请求卡文件）与 `store/activity.ts`（纯事件构建器）。拆成注入端口会改公开调用签名，超出机械迁移范围；出现第三个调用方或改这些函数签名时重评。
- `domains/isolation/checkout.ts` 仍拥有 git clone/merge 与目录守卫，`domains/requests/request-open.ts` 仍做文件打开路径校验；其余 domain 已禁止 `node:fs`/`node:child_process`。
- `domains/project/` 没有独立纯规则模块：`cowork_project_*` 读模型留在 `tools/project.ts`，等出现第二个调用方再拆。
- 历史 handoff/notes 只更新链接目标，未改结论；当前文档、README 与 skills 的源路径已同步到新位置。

## Testing

- [A1] 每个 `src`/`tests`/`scripts` 文件都有目标位置，无未分类文件 — `source`
- [A2] `tests/architecture.test.mjs` 断言 import 方向、domains 纯叶、无环，并对每条规则提供反例 — `tests`
- [A3] 22 工具名与注册顺序、10 条路由、3 个 preset、3 个 exports 迁移前后一致 — `tests`
- [A4] 测试发现递归，子目录测试被 `npm test` 与 coverage 命中；顶层 glob 遗漏即红 — `tests`
- [A5] `scripts/` 按证据面分组，`package.json`、`tools/workflow.json`、`docs/testing.md` 指向新路径 — `workflow`
- [A6] `npm run build` 仍产出 `lib/index.js` 与 `lib/client.js`；`npm run test:host-smoke` 通过 — `packaging`
- [A7] `src/**/*.ts` 仍 <50 KiB，48 KiB 目标与大文件拆分未被 barrel 绕过 — `source`
- [A8] 当前文档源路径更新；历史记录只改链接目标；`npm run check` 的 markdown-links 通过 — `workflow`
- [A9] 迁移分 Stage 0–5 六个可独立回滚的 commit；每阶段结束 `npm test`/`typecheck`/`check` 通过，最终阶段跑 coverage/build/host-smoke — `workflow`
- [A10] 本记录在阶段 0 之后从 `proposed/` 移入 `implemented/` 并改写为 Decision/Consequences/Testing — `decisions`
