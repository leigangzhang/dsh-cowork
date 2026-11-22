# 工作项代码健康度回归修复交接

- 日期：2026-11-21
- 状态：P0/P1 已由 PR #78 完成；P2/P3 已由 [结果记录](WORK_ITEM_HEALTH_RESULT.md) 交付
- 分支：`agent/work-item-health-followup`
- 基线：`main` `178f216`（PR #74 合并后）
- 隔离工作区：`/tmp/dsh-work-item-health`
- 工具版本：`fallow 3.43.0`
- 相关规则：[AGENTS.md](../../AGENTS.md)、[testing.md](../testing.md)、[code-review](../../.agents/skills/code-review/SKILL.md)

本文件是执行交接，记录已冻结的判断、P0–P3 的实施顺序、验收命令和停点。当前行为以源码、[tools/workflow.json](../../tools/workflow.json) 和测试为准。

## 问题快照

PR #74 合并后的体检出现两个信号：

1. `fallow health --baseline tools/fallow-health-baseline.json` exit 1。
2. `fallow audit --base 6413911` 报告 4 条 `attribution: "worsened"` 的既有函数。

根因不是一个：

- health 基线在 `d9d2f7e` 后没有再维护。该点 `fallow health --baseline` 为 0 剩余；之后到 `178f216` 有 28 个 first-parent merge。PR base `6413911` 已是 84 条剩余，PR head 是 83 条，因此 health 红不是 #74 引入的。
- 当前基线是 `157` 个 file/category 计数条目，按文件和类别匹配，不按全局总数匹配。`remaining_findings` 非零就失败，不能把“当前总数少于基线总数”理解为通过。
- PR #74 的真实回归是 4 条 worsened：`WorkItemViewer`、`handleEdit`、`refreshFromServer`、`panel.tsx` 的 presence effect 回调。`introduced=false` 只表示函数在 base 已存在，不表示没有变差。
- `fallow audit` 默认 `worsened=warn`，所以 PR 里的 audit 仍以 exit 0 结束；CI 也没有执行 fallow。

## 本次执行状态

- P0 已完成：presence/refresh 纯 helper 与单测落在 [viewers/document.ts](../../src/client/work-item/viewers/document.ts)、[viewers/viewer-refresh.ts](../../src/client/work-item/viewers/viewer-refresh.ts)；document/chrome 展示分支拆到 [viewers/viewer-document.tsx](../../src/client/work-item/viewers/viewer-document.tsx)；edit 写路径拆到 [artifact-edit.ts](../../src/panel/artifact-edit.ts)。
- 执行中发现并修复了一个 composer 竞态：SSE 先让线程出现时，首个提交的响应会清空用户刚输入的第二条草稿。提交现在只在状态仍等于提交时快照时清空。
- `WorkItemViewer` 为 `CC 65 / cognitive 128 / 967` 行；`handleEdit` 为 `CC 13 / 63` 行；`refreshFromServer` 为 `CC 6 / 33` 行。
- `fallow audit --base 6413911`（配置 `worsened=error`）为 exit 0，`introduced=0`、`worsened=0`。
- health 仍为红：`83` 条 remaining、`12` 条 stale。P2 仍未执行，这是已知且有意保留的下一步。
- P1 已完成：`.fallowrc.jsonc` 启用 `audit.worsened=error`；AGENTS、testing 与 code-review skill 已改为同时检查 introduced 和 worsened。
- P3 的执行必须解析 `--format json` 的 `attribution.complexity_introduced` 与 `complexity_worsened`，不能只看 exit code；warn 级 finding 的 line-count 增长可能仍让命令 exit 0。

## 冻结决定

- 不在这个功能修复 PR 刷新 health 基线。P0 先修 #74 的 4 条回归；P2 再开独立 maintenance PR 接受存量 finding。
- P1 把 `audit.worsened` 改为 `error`。`introduced=0` 不再是充分证据，必须同时看 `complexity_worsened=0`。
- P0 的硬指标是不高于 PR base 的函数指标；结构目标是把 `WorkItemViewer` 继续拆小，而不是只把数字调回 67。
- P3 是否把 fallow 加入 CI 需要重新评估历史决策。此前以“约 43 MB 平台二进制、当时没有 lockfile”为由保持本地 CLI；现在 lockfile 已存在，且基线已经漂移，条件发生了变化。
- 任何 fallow 对比都固定 CLI 版本和 HEAD。升级 fallow 后重新生成基线，不能静默替换。

## P0：修复 #74 的 4 条回归

### P0.1 presence 与 canvas reset 纯函数

在 [viewers/document.ts](../../src/client/work-item/viewers/document.ts) 增加可单测的纯 helper：

- `presenceRangesFor(type, saved, draft)`：canvas 返回整文件范围，其他类型返回 `changedLineRanges`。
- canvas 重建判定：仅在“正在编辑 canvas 且刷新后的文件内容与旧内容不同”时返回 true。
- 保持 `canvasPresenceRanges` 的现有契约不变。

在 [tests/client/work-item-viewers.test.mjs](../../tests/client/work-item-viewers.test.mjs) 覆盖 canvas/文本和重建/不重建分支。

目标：`panel.tsx:488` 回调回到 `CC≤6`、`cognitive≤3`、行数 `≤16`。

### P0.2 拆 `WorkItemViewer`

当前 [panel.tsx](../../src/client/work-item/panel.tsx) 的 `WorkItemViewer` 有 `CC 84`、`cognitive 165`、`1013` 行、73 个 hooks。PR #74 把 canvas 状态、presence 分支和四套 viewer 渲染继续留在容器内。

按职责抽展示组件，状态仍由容器持有，先不改变加载、保存、SSE 和评论行为：

- document surface：编辑态、diagram/html/canvas 只读态、SourceLines、selection bar。
- viewer chrome：header、toolbar、tabs。
- 若前两项后仍高于 base，再抽 thread rail/composer。

要求：

- 保留所有现有 `data-testid` 和 DOM 结构，避免浏览器场景无意义改写。
- 新 TSX 文件同步登记 [tools/coverage-map.json](../../tools/coverage-map.json)、[scripts/evidence/client-coverage.mjs](../../scripts/evidence/client-coverage.mjs)、[tools/coverage-browser-floors.json](../../tools/coverage-browser-floors.json)。
- 新组件优先由现有 browser 场景覆盖；只补真实未覆盖分支，不为重复断言加场景。

硬目标：

- `WorkItemViewer` 不高于 base：`CC≤67`、`cognitive≤131`、行数 `≤987`。
- 结构目标：主函数低于 200 行；[panel.tsx](../../src/client/work-item/panel.tsx) 回到 50 KB 以下。
- 若一次 PR 无法完成结构目标，至少恢复 base parity，并把剩余拆分写入后续 burn-down 项。

### P0.3 拆 `refreshFromServer`

当前 [panel.tsx](../../src/client/work-item/panel.tsx) 的 `refreshFromServer` 为 `CC 15`、`cognitive 15`、`40` 行；base 是 `12/12/36`。

把“替换 file、保留 dirty draft、决定是否重建 canvas、设置 save phase”的整段转换移到模块级 helper 或 hook。SSE 行为不变：

- 自己的保存回放不得重建 Excalidraw。
- 真正的外部文件替换才递增 scene key。
- dirty draft 继续保留旧 base，只显示 receipt。

目标：回到 `CC≤12`、`cognitive≤12`、行数 `≤36`。

### P0.4 拆 `handleEdit`

当前 [artifact-api.ts](../../src/panel/artifact-api.ts) 的 `handleEdit` 为 `135` 行；base 是 `126` 行。CC 已从 26 降到 24，但 fallow 仍按行数增长标记 worsened。

把 merge/write/commit 路径拆成小函数，保持错误码、响应体、快照和事件顺序不变：

- stale 输入构造与 `resolveStaleBase` 调用。
- stale 首写与版本冲突重试循环。
- store 锁内 mutate、revision、事件和 anchor relocation。
- 响应构造。

每个新 helper 必须低于 fallow 的 60 行、CC 20、cognitive 15、CRAP 30 阈值，避免把一个大函数改名成另一个 finding。

目标：`handleEdit` 行数 `≤126`，且 audit 不再报告 worsened。

现有回归由 [tests/panel/artifact-api.test.mjs](../../tests/panel/artifact-api.test.mjs) 和 [tests/panel/artifact-canvas-edit.test.mjs](../../tests/panel/artifact-canvas-edit.test.mjs) 覆盖；不得改弱 stale merge、409 或 current-base 直写断言。

## P1：修正 audit gate 语义

在 [.fallowrc.jsonc](../../.fallowrc.jsonc) 增加：

```jsonc
"audit": {
  "worsened": "error"
}
```

同步 [AGENTS.md](../../AGENTS.md)、[testing.md](../testing.md) 和 [code-review skill](../../.agents/skills/code-review/SKILL.md)：

- feature PR 必须检查 `complexity_worsened=0`；
- `introduced=0` 不是通过条件；
- 标准命令是 `fallow audit --base <verified-base> --worsened error`；
- health 基线刷新仍只在独立 maintenance PR 中进行。

验收：修复前当前 audit 因 4 条 worsened 变成 `verdict: fail`；修复后 exit 0。

## P2：独立 health 基线维护

前置：P0 已合并且 P1 已启用。

1. 从新 main 建独立 maintenance 分支。
2. 固定 `fallow 3.43.0` 和新 HEAD。
3. 运行 `fallow health --save-baseline tools/fallow-health-baseline.json`。
4. 逐条审阅约 83 条剩余 finding 和 12 条 stale 条目；确认是存量债务后才接受。
5. 记录 CLI 版本、HEAD、审阅范围和每类接受理由。
6. 验证 `fallow health --baseline tools/fallow-health-baseline.json` exit 0。

可选：评估 `--baseline-mode identity` 是否比默认的 file/category count 更适合当前仓库。该变更需要重新保存基线，必须与功能改动分开。

## P3：CI 强制

前置：P1 配置已落地，P2 基线已绿。

建议增加独立 fallow job：

```sh
npx fallow audit --base "$BASE_SHA" --worsened error --format json > "$RUNNER_TEMP/fallow-audit.json"
node -e 'const j=require(process.argv[1]); if (j.attribution.complexity_introduced !== 0 || j.attribution.complexity_worsened !== 0) process.exit(1)' "$RUNNER_TEMP/fallow-audit.json"
npx fallow health --baseline tools/fallow-health-baseline.json
```

`audit` 的 exit code 不能单独作为通过条件：当前 fallow 3.43.0 会把部分 warn 级 finding 的 line-count 增长仍算作 exit 0，但 JSON 的 `complexity_worsened` 会记录它。CI 必须解析并断言两个计数都为 0。

执行方式二选一：

- 推荐：把 `fallow@3.43.0` 固定加入 [package.json](../../package.json) devDependencies，随 `npm ci` 安装。
- 备选：在 heavy lane 的隔离目录安装固定版本，不改项目依赖；可复现性弱于锁文件。

接入前检查官方 npm 包、平台 optional dependency、Node `>=22` 与许可证。若改变此前“fallow 只做本地信号”的决策，新增 decision record，不修改已落地的历史记录。

## 验收命令

P0/P1：

```sh
fallow audit --base 6413911 --worsened error --format json
fallow health --baseline tools/fallow-health-baseline.json --format json
npm run check
npm test
npm run test:coverage
npm run test:browser
npm run test:coverage:layered -- --base 6413911
npm run typecheck
npm run build
npm run test:host-smoke
```

P2 完成后追加：

```sh
fallow health --baseline tools/fallow-health-baseline.json
```

注意：P0/P1 阶段 health baseline 仍可能为红，因为它记录的是尚未维护的全仓存量；这一阶段用 `fallow audit --base 6413911 --worsened error` 判断回归是否修好。P2 完成后 health 才能作为 blocking gate。

## 停点与风险

- 若拆 `WorkItemViewer` 后 browser 覆盖率 floor 下降，先补真实 UI 分支或调整新组件 floor；不得降低 `panel.tsx` 已评审 floor 来换绿。
- 若 `handleEdit` 提取 helper 改变冲突响应或事件顺序，立即停止，以现有 409/merge 测试为准修实现，不改断言。
- 新 TSX 文件如果无法由现有场景达到合理覆盖，先评估是否应合并到已有 viewer 文件，而不是引入低覆盖 owner。
- 本工作区是隔离 worktree；主工作区 `agent/heavy-comment-pr-discovery` 的未提交改动不属于本任务，不得带入本分支。
- P2 的 83 条存量 finding 未逐条审阅，数量可能随 P0 拆分变化；以 P2 时的 HEAD 重新计数。
- P3 会增加 CI 安装体积和时长；若决定不接入，必须明确接受“仍靠人工评审”的漂移风险。

## 新会话启动清单

- [ ] `git -C /tmp/dsh-work-item-health status --short --branch`，确认在 `agent/work-item-health-followup`。
- [ ] 读本文件、[testing.md](../testing.md) 和 [code-review skill](../../.agents/skills/code-review/SKILL.md)。
- [ ] 跑 `fallow audit --base 6413911 --worsened error`，确认起点是 4 条 worsened。
- [ ] 按 P0.1 → P0.2 → P0.3 → P0.4 执行，每完成一个可测切片就提交。
- [ ] P1 单独提交，包含配置和文档。
- [ ] 全量受影响检查通过后再推送；PR 合并保持人工步骤。

## 不要做

- 不要在 P0 刷新 `tools/fallow-health-baseline.json`。
- 不要用 `fallow-ignore`、提高阈值或放宽类型来消除 finding。
- 不要只把 `WorkItemViewer` 改回 67 的形态就宣称结构已修好。
- 不要把新组件直接登记成低覆盖 owner 来绕过 browser floor。
- 不要把主工作区的未提交改动、构建产物或本地 evidence 带进本分支。
