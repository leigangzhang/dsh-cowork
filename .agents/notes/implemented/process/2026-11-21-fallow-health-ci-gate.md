# Decision: 把 fallow 健康门禁接入 CI，并刷新评审基线

Status: implemented
Date: 2026-11-21
Class: process

## Problem

[fallow 决策](2026-11-14-fallow-code-health.md) 与 [基线刷新](2026-11-15-fallow-health-baseline-refresh.md) 把 fallow 定为「受审的本地信号」，理由之一是 CI 强制不是需求：平台二进制约 43 MB，且当时仓库没有 lockfile。条件已经变了：

- 基线在 `d9d2f7e` 之后经历 30 个 first-parent merge 没有再维护。PR #74 合并后的 main（`c9f7e84`）上 `fallow health --baseline` 已有 83 条剩余 finding 和 12 条 stale 条目，命令 exit 1。健康信号在本地长期是红的，new-only 判定名存实亡。
- PR #74 的四条真实回归（`WorkItemViewer`、`handleEdit`、`refreshFromServer`、panel presence 回调）只有人工跑 audit 才被发现。PR #78 把 `audit.worsened` 改为 `error`，但 CI 不跑 fallow，这个语义修正没有执行者。
- 2026-11-14 拒绝 devDependency 的前提已不成立：lockfile 已随 V0.2 工作流进入仓库；fallow 3.43.0 是 MIT、`engines.node >= 22`，平台二进制通过 optional dependency 分发；`.node-version` 是 22.22.1。

## Decision

- `tools/fallow-health-baseline.json` 由 fallow 3.43.0 在 main `c9f7e84` 上重新生成。旧基线覆盖 184 条超阈值 finding 中的 101 条；83 条未覆盖的 finding 全部在 PR #74 的 base `6413911` 上已存在，没有一条由 #74/#78 引入。逐条审阅的分类接受理由、12 条 stale 条目的处理与基线计数变化见 [结果记录](../../../../docs/handoff/WORK_ITEM_HEALTH_RESULT.md)。没有改阈值、源码行为或 `.fallowrc.jsonc` 的 ignore。
- `package.json` 精确固定 `devDependencies.fallow = 3.43.0`；lockfile 只新增 fallow、`detect-libc` 与 8 个平台 optional dependency，共 154 行，全部从 `https://registry.npmjs.org/` 解析。新增 `fallow:health` 与 `fallow:audit` 脚本，本地和 CI 跑同一命令。
- `.github/workflows/ci.yml` 新增独立 `code-health` job，只在非 docs-only 的 PR 上运行：`npm ci` → 用 merge-base 解析 PR 的 base sha → `npm run --silent fallow:audit -- --base <sha> --format json` → `scripts/ci/fallow-gate.mjs` 断言 JSON 计数 → `npm run fallow:health`。`pr-gate` 把 `code-health` 列为必需 lane，并像 `unit` 一样拒绝 docs-only 变更里意外运行的 lane。
- CI 不把 audit 的退出码当作唯一证据：`scripts/ci/fallow-gate.mjs` 直接断言 `complexity_introduced` 与 `complexity_worsened` 都为 0，并把报告绑定到 base、head（接受 fallow 输出的短 SHA 前缀）和固定 CLI 版本；退出码是汇总结果，无法证明报告对应的比较点、检出和 CLI 版本。
- 本次不启用 `--fail-on-baseline-growth`：它要求 head 的基线键在 base 上已存在，而这次维护 PR 的任务恰好是新增键，启用会让迁移本身失败。迁移落地后可以在后续 PR 中评估。

## Alternatives considered

**继续只做本地信号，不接 CI。** 否决：main 已经漂移 83 条，本地门禁红着也没有人执行；PR #74 的四条回归完全靠人工发现。再靠评审自律没有证据链。

**在 heavy lane 里跑，而不是 hosted CI。** 否决：heavy lane 需要自托管 runner 与 DSH 检出，只在同仓 `agent/*` PR 的 CI 之后触发；fallow 是纯静态分析，hosted runner 足够，而且能覆盖所有 PR。

**用 `npx fallow@3.43.0` 临时下载，不加 devDependency/lockfile。** 否决：可复现性弱于锁文件，每次 CI 都要重新下载约 43 MB；固定 devDependency 让版本、integrity 和平台包都由 lockfile 保证。

**改用 `--baseline-mode identity`（按函数身份匹配）。** 否决：更严格，但本仓库持续拆分和重命名函数（PR #78 刚做过），每次重命名都要求在功能 PR 或维护 PR 刷新基线，与「基线只在维护 PR 刷新」的规则冲突。`count` 模式下「同文件同类别的新热点被旧计数掩盖」的缺口由变更级的 `fallow audit` introduced/worsened 承担。

**在同一个 PR 里修复 184 条存量 finding。** 否决：范围过大，行为变更与基线冻结互相污染证据。P2 的职责是审阅并冻结存量，燃烧按基线增量在后续工作流推进。

## Consequences

- 每个非 docs-only 的 PR 增加一次 `npm ci`（含约 43 MB 平台二进制）和两次 fallow 运行；hosted runner 上以分钟计，换来到基线不再漂移的机械门禁。
- `fallow:health` 第一次在 CI 上运行，基线必须与 HEAD 同步。升级 fallow 或刷新基线仍然走独立维护 PR，写明 pinned CLI 版本与 HEAD，并逐条审阅新增条目。
- `code-health` 用 merge-base 而不是 base 分支 tip 作为比较点，避免把 main 自己新增的改动算进 PR；报告还要匹配 head，防止证据与检出不一致。
- 基线不覆盖 CRAP 的静态估算变化（`coverage_source=estimated`）：CRAP-only finding 会随测试覆盖启发式漂移，这类漂移仍由维护 PR 处理。
- `fallow health --baseline` 对 stale 条目只警告、不失败。启用 `--fail-on-stale-baseline` 会让删除函数的普通 PR 变红，与「维护 PR 才刷新」冲突，因此 stale 仍靠维护 PR 或人工发现。
- 仓库增加 `fallow` 与 8 个平台 optional dependency 的下载体积；不在项目内安装时，`npx fallow` 会回退到远端最新版，因此文档统一使用 npm scripts 与 pinned 版本。

## Testing

- [A1] 在 main `c9f7e84` 上重新生成基线后，`npm run fallow:health` 退出 0：254/254 计数匹配、0 stale、0 remaining；83 条 finding 与 `6413911` 的对照说明已写入结果记录。 — `workflow`
- [A2] `fallow audit --base <merge-base> --format json` 的 `attribution.complexity_introduced` 与 `complexity_worsened` 由 `scripts/ci/fallow-gate.mjs` 断言；负例 fixture 证明任一计数非零时退出 1，短 head SHA 前缀可用，完整 head/base/版本不匹配时退出 1。 — `tests`
- [A3] `package-lock.json` 的所有 `resolved` 指向 `https://registry.npmjs.org/`，`devDependencies.fallow` 是精确的 3.43.0；`npm ci` 在 hosted runner 上安装 linux-x64 平台包。 — `packaging`
- [A4] `AGENTS.md`、`docs/testing.md` 与 code-review skill 把本地命令统一为 `npm run fallow:health` / `npm run fallow:audit`，并写明 `code-health` 的 JSON 断言与维护 PR 规则。 — `plan-docs`
