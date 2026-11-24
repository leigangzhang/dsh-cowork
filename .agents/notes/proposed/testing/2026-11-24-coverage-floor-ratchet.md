# Proposal: 为 browser coverage floor 下调建立证据与例外门禁

Status: proposed
Date: 2026-11-24
Class: testing

## Problem

[browser coverage floors 决策](../../implemented/testing/2026-11-15-browser-coverage-floors.md) 已规定 floor “只向上 ratchet”：下调必须说明原因并经 reviewer 同意。但最近 10 个 PR（#77–#86）表明这条规则没有被执行成可审计的事实：

- PR #81 把 `src/client/work-item/panel.tsx` 从 `L98.59/F93.69` 下调到 `L95.16/F91.06`；同一 PR 内新增的 `thread-card.tsx` 从 `L100/F88.89` 调到 `L91.75/F80`，`viewer-header.tsx` 从 `L96.55/F90.91` 调到 `L95.33/F90.91`，`thread-list.tsx` 的 function floor 从 `F93.33` 调到 `F92.31`。
- PR #86 把 `src/client/index.tsx` 的 function floor 从 `F75` 调到 `F73.68`。当前实测为 14/19 个函数；行覆盖仍是 100%。
- #81 的未覆盖行包含可测试的用户动作（在应用中打开、导出、复制路径、带会话标题的面包屑）和一个已承认不可达的 `ThreadCard` 紧凑分支。#86 的 function 下调来自 KI-40：当前宿主不提供 `ctx.sessionNotices`，对应回调不可达。
- [coverage-gaps.mjs](../../../../tools/coverage-gaps.mjs) 当前把 unit 和 browser 两份记录的未覆盖行取并集，并列出变更文件的所有未覆盖行，而不是 owner lane 与新增行的交集。PR #86 的评论因此列出 197 行：127 行是变更文件里的存量未覆盖行，70 行在新增行上，但真正属于 owner lane 的新增缺口只有 40 行。

结果是同一类“无覆盖”无法区分四种事实：测试遗漏、不可达代码、当前 lane 不可执行的宿主边界、测量噪声。floor 调低后只留下一个百分比，reviewer 看不到它接受的是什么；下一个 agent 也无法判断应该补测试、删代码，还是等待宿主能力。

## Proposal

### 1. 把 floor 变化分成四类

- **新增 floor**：源文件首次进入 browser owner map。feature PR 可以同时新增。
- **上调 floor**：只允许在连续绿运行后上调；不改变例外集合。
- **下调 floor**：只允许用于 `host-boundary` 或 `measurement-noise`。可测试的分支必须先补测试；不可达代码必须先删除；不得把 `test-debt` 或 `dead-code` 固化成 floor。
- **删除 floor**：只允许源文件已删除或变为 blocked surface。文件还在且仍由 browser lane 计数时，删除 floor 直接失败。

“host-boundary” 指当前 DSH 宿主或 browser lane 无法提供的执行条件，必须有 KI、宿主能力名和退出条件；“measurement-noise” 只用于同一 clean head 连续运行数值不稳定，必须附至少三次运行的 min/max。其余原因一律不接受。

### 2. 新增 floor debt 清单

新增 `tools/coverage-browser-floor-debt.json`，记录每个**新增的低于 100 的 floor** 和每个**下调的既有 floor**：

```json
{
  "formatVersion": 1,
  "entries": [
    {
      "file": "src/client/index.tsx",
      "key": "functionCoverage",
      "floor": 73.68,
      "kind": "host-boundary",
      "scope": "sessionNotices 注册回调",
      "reason": "DSH 0.2.1-rc.2 不提供 ctx.sessionNotices（KI-40），当前 lane 不可达",
      "exitWhen": "宿主提供 ctx.sessionNotices 后补 browser 场景并删除本条目"
    }
  ]
}
```

规则：

- `kind` 只允许 `host-boundary` 或 `measurement-noise`。
- `floor` 必须与当前 [coverage-browser-floors.json](../../../../tools/coverage-browser-floors.json) 的值一致；floor 上调或文件变为 100 后条目必须删除，否则是 stale debt。
- `scope` 必须点名具体的函数、行范围或文件能力，不能只写“新交互”或“宿主限制”。
- 每个条目必须有非空 `reason` 与 `exitWhen`。没有退出条件的例外一律失败。
- 既有低于 100 的 floor 不追溯补债；它们在下一次修改该文件 floor 时进入新规则。这样首轮不会为了补历史而伪造原因。

### 3. 先分类未覆盖行，再改 floor

任何 floor 变化 PR 必须附 `npm run coverage:gaps -- --base <verified-base>` 的输出，并对新增未覆盖行逐项分类：

1. **可测试**：补 browser/unit 测试，不降 floor。导出用 Playwright download 事件，复制路径用剪贴板权限，宿主打开用注入的 opener stub，面包屑标题用带 `sessionTitle` 的 detail fixture。
2. **不可达**：删除代码或移除不可达分支，不降 floor。`ThreadCard` 的 resolved 紧凑分支是此类。
3. **宿主边界**：写入 floor debt，保留最小下调范围，并给出 DSH 能力名、KI 和退出条件。
4. **测量噪声**：先修测量，再按三次 clean 运行的最低值设 floor；不得把不稳定的高值当作覆盖改善。

### 4. 修正 coverage gap 报告口径

[coverage-gaps.mjs](../../../../tools/coverage-gaps.mjs) 的 `changedFileGaps` 改为按 owner map 只取该文件的 owner lane；同时输出两组事实：

- `new uncovered lines`：变更文件的新增/修改行中未覆盖的行；
- `file residual uncovered lines`：该文件所有未覆盖行，供了解存量，不计入本次缺口。

跨 lane 的记录保留为诊断信息，不再混入主缺口列表。`tools/coverage-gaps.mjs` 的注释标题同步改为准确名称。`tests/guards/coverage-gaps.test.mjs` 增加两个 fixture：unit owner 100% 而 browser 记录为 0 时不得报缺口；存量未覆盖行不得出现在 `new` 列表。

### 5. 机械门禁

新增两个命令，共用 `tools/coverage-browser-floor-debt.json`：

- `npm run coverage:floors:check`：静态检查 debt 条目与 floor 文件同步、字段完整、没有 stale 条目；加入 `npm run check`。
- `npm run coverage:floors:diff -- --base <verified-base>`：比较 base 与 head 的 floor 文件，输出 added/raised/lowered/removed；以下情况 exit 1：
  - 下调既有 floor 但没有匹配 debt；
  - 新增低于 100 的 floor 但没有匹配 debt；
  - 删除仍存在的源文件的 floor；
  - debt 条目与当前 floor 不一致或已 stale。

该 diff 检查加到 heavy lane 的 blocking 命令集，并在 [tools/workflow.json](../../../../tools/workflow.json) 的 `coverage-policy` surface 中登记。`coverage:gaps` 仍是 observational 报告，不承担 floor 门禁。

### 6. PR 证据格式

floor 变化的 PR 描述必须包含一张表：

| 文件 | key | base → head | 最终实测 | 分类 | 测试或债务 |
|---|---|---|---|---|---|---|
| `src/client/...` | `lineCoverage` | `98.59 → 95.16` | `95.16` | testable | 新增 browser 场景 |

分类为 `host-boundary` 或 `measurement-noise` 时，表内还必须链接 debt 条目和退出条件。reviewer 检查 floor 变化、`coverage:gaps` 输出、debt 条目和测试增量四者是否一致；只看到百分比变化不得通过。

## Alternatives considered

**继续沿用“下调必须单独 PR”的规则。** 否决：#81 和 #86 已证明它没有被执行；当 feature 代码本身导致覆盖率下降时，单独的 floor PR 也无法在 feature 合并前取得最终实测值，规则不可操作。

**禁止一切下调，所有文件必须 100%。** 否决：当前宿主确有不可执行的边界（KI-40），而 JSX 的弹层、下载和宿主打开动作需要专门测试夹具；一刀切会迫使团队写伪测试或加入更多 ignore。

**只保留 reviewer 人工判断。** 否决：这次分析中 review 已经 pass 了 `thread-card` 的 91.75/80 和 `panel` 的 95.16/91.06；没有结构化分类和退出条件，下一个 reviewer 只能重复接受现状。

**给每个分支加 coverage ignore 注释。** 否决：ignore 分散在源码里，无法集中审计退出条件，也容易从“当前 lane 不可达”滑向“懒得测”。

**只修 coverage-gaps 报告，不改 floor 规则。** 否决：报告变准确只能让缺口更可见，不能阻止下一次把可测试分支写进更低的 floor。

**让 coverage-gaps 变成 blocking 门禁。** 否决：它列出的是审计信号，包含存量行和跨 lane 数据；把噪音做成硬失败会迫使团队花时间清历史，而不是阻止新的 floor 松动。门禁应针对 floor 变化本身。

## Acceptance criteria

- [A1] 下调既有 floor 且没有匹配 debt 时，`npm run coverage:floors:diff -- --base <fixture-base>` 非零退出，并点名文件、key、base/head 值 — `coverage-policy`
- [A2] 新增低于 100 的 floor、stale debt、缺失 `reason`/`exitWhen`、非法 `kind` 均使 `npm run coverage:floors:check` 非零退出；合法 host-boundary 条目通过 — `coverage-policy`
- [A3] `coverage:gaps` 的 fixture 证明 unit owner 100% 时 browser 的 0 记录不再出现在 owner gap 列表，存量未覆盖行不进入 `new uncovered lines` — `browser`
- [A4] `coverage:gaps` 的 PR 评论标题、`docs/testing.md` 的口径说明和 `tools/workflow.json` 的 `coverage-policy` 证据引用一致 — `workflow`
- [A5] 任一 floor 变化 PR 都附 `npm run test:coverage:layered -- --base <verified-base>`、`npm run coverage:gaps -- --base <verified-base>` 和 `npm run coverage:floors:diff -- --base <verified-base>` 的实际输出；缺一项 review 不得通过 — `browser`

## Risks

- debt 文件可能变成新的豁免垃圾桶。约束是只允许 `host-boundary`/`measurement-noise`，并要求 `scope`、KI/宿主能力和 `exitWhen`；reviewer 仍需拒绝“其他项目也这样”的理由。
- 既有低于 100 的 floor 不追溯补债，短期仍看不到历史原因；第一次修改这些文件时必须重新分类，避免一次性补造历史。
- measurement-noise 可能被滥用。要求同一 clean head 至少三次运行并记录 min/max，且先排除 reload、导航或 fixture 导致的测量丢失。
- 机械门禁只能检查结构，不能判断一个分支是否真的不可达；不可达性仍需代码阅读和测试负例。
- 新增 heavy 命令会增加一次 floor 文件比较，但只读两个 JSON，成本远低于 coverage lane；若重跑频率过高，应缓存同一 base/head 的结果而不是降级为 observational。

## Delivery stages

1. **修正报告口径。** 改 `coverage-gaps.mjs` 的 owner-lane 与新行输出，补两个 fixture；确认 PR #86 的 197 行报告会缩成 owner-lane 视角。
2. **落地 floor debt 与静态检查。** 新增 debt 文件、`coverage:floors:check` 和 `coverage:floors:diff`，补“下调无债、stale 债、合法 host-boundary”三类 fixture。
3. **接入门禁与文档。** 把静态检查接入 `npm run check`，把 diff 检查接入 heavy blocking 命令集，更新 `docs/testing.md`、`tools/workflow.json` 和 PR 证据模板；下一笔 floor 变化开始适用新规则。
