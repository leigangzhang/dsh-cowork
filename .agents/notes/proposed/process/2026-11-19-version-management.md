# Proposal: 决策记录驱动下的版本管理

Status: proposed
Date: 2026-11-19
Class: process

## Problem

V0.1 和 V0.2 的版本边界由 PLAN 承担：PLAN 同时拥有范围、阶段、验收和版本号。这个模型适合计划驱动的阶段，但它把版本边界和计划文档绑死了，进入决策记录驱动后会产生四个问题：

- **版本边界没有新的载体。** PLAN-V0.2 的 M6–M12 已经交付，后续工作由决策记录和实时需求驱动，没有 PLAN-V0.3；如果继续等 PLAN，版本会无限停在 `0.2.0`。
- **版本号已经失真。** `package.json` 仍是 `0.2.0`，M12 交付后已有数百个提交，仓库没有任何 tag；无法从版本号判断某个提交是否属于 0.2、0.3 或更后的工作。
- **测试和证据把版本号写死。** [packaging.test.mjs](../../../../tests/guards/packaging.test.mjs)、[host-smoke.test.mjs](../../../../tests/guards/host-smoke.test.mjs)、[tests/e2e/manifest.json](../../../../tests/e2e/manifest.json) 和 `tests/e2e/evidence/0.2.0.json` 都直接绑定 `0.2.0`，升版本时容易漏改，门禁也可能拿旧证据放行。
- **决策记录不能单独充当版本清单。** 决策记录回答“为什么”和契约，记录按工作流拆散；它不回答“这一版包含哪些工作、验证了什么、兼容性如何、哪些问题被接受”。没有汇总物时，tag 只能是一个任意提交快照。

当前没有对外分发需求，所以不需要 GitHub Release 或 npm 发布；但仍需要可复现的版本基线，否则回滚、安装和真实 case 反馈都无法稳定对应到某个版本。

## Proposal

### 1. 四类事实各归其位

- **决策记录**：继续保存设计选择、契约、备选方案和重估条件；落地后不再改写。
- **`CHANGELOG.md`**：版本边界的唯一汇总物，每个 tag 一条记录；只链接决策记录和证据，不重复正文。
- **annotated tag `vX.Y.Z`**：不可变的版本指针，指向一个通过检查的提交。
- **PLAN**：可选。已完成的 PLAN 可以退役或归档；任何版本都不再以 PLAN 是否存在为前提。

版本边界由“上一个 tag 之后的差异”定义，不由 PLAN 的章节或里程碑定义。

### 2. 版本号规则

- `main` 的 `package.json.version` 表示**下一个将要打 tag 的开发版本**，不是已发布版本。
- 0.x 阶段：新增功能、行为变更或破坏性变更升 minor（`0.3.0`）；兼容修复升 patch（`0.2.1`）；公共契约稳定后才考虑 `1.0.0`。
- 版本号只在开发线切换或切补丁版本时升，不按 commit、Feature 或 PR 逐个升。
- 需要预发布时使用 `vX.Y.Z-rc.N`，并让 `package.json.version` 与 tag 去掉前缀后的字符串完全一致。

### 3. tag 的创建条件

一个 `vX.Y.Z` tag 只在下面条件同时成立时创建：

1. 本版包含的决策记录已经落地，或明确记录“无需决策记录”的理由；
2. 对应测试、覆盖率、E2E 和打包证据在当前提交上通过；
3. 破坏性变更、数据迁移、回滚路径和已知问题已经写入 `CHANGELOG.md`；
4. 提交在 `main` 上，工作区干净，`package.json.version` 与 tag 去掉 `v` 后一致。

tag 使用 annotated tag，创建后不移动、不删除。错误发布只能通过下一个 patch tag 修正，不能重写已有版本。

### 4. `CHANGELOG.md` 记录格式

每个版本一条，最新在上，至少包含：

- 版本号和日期；
- 本版包含的决策记录链接；
- 实际运行的验证命令和结果指针；
- 破坏性变更、迁移与回滚方式；
- 已知问题和明确接受的限制。

没有决策记录的普通修复写一句说明，并注明“无需决策记录”的理由；决策记录本身不复制到 changelog。

### 5. 版本号与测试/证据解耦

- [packaging.test.mjs](../../../../tests/guards/packaging.test.mjs)、[host-smoke.test.mjs](../../../../tests/guards/host-smoke.test.mjs) 不再写死 `0.2.0`，改为从 `package.json` 读取并与运行时/健康检查比较。
- [tests/e2e/manifest.json](../../../../tests/e2e/manifest.json) 的 `pluginVersion` 与 `package.json.version` 同源；E2E 证据文件名使用当前版本，`npm run check` 在缺少当前版本证据或版本不一致时报红。
- 版本 bump 的最小改动集固定为：`package.json`、`CHANGELOG.md`、E2E manifest/证据，以及确实包含用户可见版本的 README 段落。

### 6. 当前过渡

1. 在 0.2 的真实证据仍通过时，为当前状态补 `CHANGELOG.md` 的 `0.2.0` 条目，打内部基线 tag `v0.2.0`；**不发 GitHub Release，不发 npm**。
2. 把 `main` 的 `package.json.version` 升到 `0.3.0`，同步版本门禁和 E2E manifest。
3. v0.2 的真实会话/项目反馈继续收集；发现的 0.2 问题用 `0.2.1`、`0.2.2` 等 patch tag 修正，不重新打 `v0.2.0`。
4. 工作项和 ArtifactStudio 在 `0.3.0` 开发线上推进；两者完成、证据齐备后写 `0.3.0` 条目，再打 `v0.3.0`。
5. 退役 PLAN 时同步更新 README、文档索引和 [code-review skill](../../../skills/code-review/SKILL.md) 的必读入口，把版本边界指向 `CHANGELOG.md` 和决策记录。

### 7. 发布不是 tag 的同义词

- 没有分发需求时，只打 tag，不创建 GitHub Release。
- 需要分发时，GitHub Release 只能复用同一个 tag，并附上 `npm pack` 生成的 tarball 和 sha256；发布仍需要用户明确授权。
- `package.json` 保持 `private: true`；除非明确决定更换分发方式，不走 npm 发布。

## Alternatives considered

**继续用 PLAN 作为版本边界。** 否决：V0.2 完成后没有 V0.3 PLAN，后续工作已经是决策记录驱动；强行补 PLAN 会让计划文档变成版本流水账，且已完成的 PLAN 退役后版本边界仍然缺失。

**只靠决策记录，不建 `CHANGELOG.md`。** 否决：决策记录按工作流拆散，不能告诉用户某个 tag 包含哪些工作、跑过什么证据、有哪些兼容性影响。changelog 只做汇总和链接，成本远低于重新组织 PLAN。

**让每个 Feature 或每个 merge 都打 tag。** 否决：tag 会变成高频快照，语义版本失去含义，且每次都要求完整证据不现实。版本应按一组可验收的决策切分。

**继续把 `0.2.0` 写死在测试里，升版本时手工搜索替换。** 否决：这正是当前漂移的来源；测试应从 `package.json` 读取版本，E2E 证据按版本命名，并由门禁检查一致性。

**用 GitHub Release 作为版本事实源。** 否决：仓库当前没有发布 workflow，`private: true` 也不适合 npm；Release 只是 tag 的可选分发视图，不能反过来决定版本。

## Acceptance criteria

- [A1] `CHANGELOG.md` 存在并被 [docs/publish.json](../../../../docs/publish.json) 分类；每个 tag 都有对应条目，版本号和日期可从文件直接读出 — `plan-docs`
- [A2] `package.json.version`、tag 去掉 `v` 后的版本、changelog 最新版本三者一致；不一致时 `npm run check` 或版本 guard 变红 — `tests`
- [A3] packaging、host smoke、E2E manifest 不再硬编码 `0.2.0`；当前版本没有 E2E 证据时门禁失败 — `tests`
- [A4] 版本 bump 的改动集、tag 创建条件和 patch 规则写进当前决策记录及其落地文档 — `plan-docs`
- [A5] 退役 PLAN 后 README、文档索引和 review skill 不再把 PLAN 作为版本边界；链接指向 changelog 和决策记录 — `decisions`

## Risks

- 0.2 还未完成真实 case 验证就打了内部基线 tag；后续修复会产生 `0.2.x` patch。这会让版本序列变长，但比让 `0.2.0` 永远漂移更可控。
- `CHANGELOG.md` 可能与决策记录重复。约束是只写版本范围和链接，不复制设计论证。
- 版本 guard 需要处理 `-rc.N` 排序和 tag 未拉取的情况；实现时必须用测试固定排序和缺 tag 的失败信息。
- 不是每个变更都有决策记录；changelog 需要显式写“无需决策记录”的理由，否则会退化成提交列表。
- 0.x 的 minor 仍可能包含破坏性变更；必须在 changelog 和 README 中写明，不能假装遵循稳定的 1.x 语义。
- 如果未来出现外部消费方或多条发布分支，需要重新评估 patch 分支和版本候选规则。

## Delivery stages

1. **门禁解耦。** 新增版本一致性 guard，packaging/host-smoke/E2E manifest 改为读取 `package.json`；补负向测试。
2. **基线与 0.3 开发线。** 补 `CHANGELOG.md` 的 0.2.0 条目，打 `v0.2.0` 内部基线，升 `main` 到 `0.3.0`，更新 E2E manifest/证据。
3. **V0.3 收口。** 工作项和 ArtifactStudio 完成后补 `0.3.0` 条目，跑完整证据，打 `v0.3.0`；无明确授权不发 Release。
