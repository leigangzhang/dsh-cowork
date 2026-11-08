# Proposal: M7 索引 v2 迁移执行提案

Status: proposed
Date: 2026-11-07
Class: architecture

## Problem

M7 要把 `.dsh-cowork/index.json` 从 v1（六态 thread 中心）迁到 v2（`topics[]` + `workItems[]`），并补上 activity/inbox 的文件读写。数据模型、字段与状态映射已由 [索引 v2 与迁移](2026-11-07-topic-store-v2.md) 拥有；缺的是执行层面的约定：模块怎么拆、迁移在哪个时点触发、备份与写入的顺序、失败如何保留现场、测试先写哪些。

M6 又补了两条约束：取消在途 reviewer 的归档必须 `archiveSession(id,{stopActivity:true})`（立即归档会让会话无法继续），且 `awaiting_review` 迁移时归档失败不能让迁移假装成功（[M6 探针结果](../../../../docs/M6_PROBE_RESULT.md) §3/§4）。没有这些执行约定，M7 容易写成「一次性替换 `store.ts`」，既不可单测，也会顶到单文件读取上限。

## Proposal

**模块与职责（按 [PLAN-V0.2](../../../../docs/PLAN-V0.2.md) §4.2）。**

- `src/store-schema.ts`：v2 类型、状态/标记校验、未知字段容忍策略；纯类型与纯校验，无 I/O。
- `src/store-migration.ts`：纯函数 `migrateV1ToV2(document, options)`，返回归一化 v2 与迁移报告（逐状态计数、被取消的评审、待归档的 reviewer、未知字段）；不读文件、不加锁。
- `src/store.ts`：文件 I/O 与项目锁；v2 读写、备份、原子替换与目录 fsync；`activity.jsonl` 追加/裁剪与 `inbox.json` 原子重写。`activity.ts`/`inbox.ts` 的业务规则在 M8 才引入，M7 不建空壳。
- 保持现有模块边界与 source budget：`src/store.ts` 现约 42 KB，新增逻辑不得把任何 `src/**/*.ts` 推过 50 KiB。

**迁移时点与事务。**

1. 只在「读到 v1 且准备写」的路径迁移；纯读取不迁移、不改文件。
2. 在项目锁内：重读 v1 → 复算 v2 → 校验 v2 → 原子写 `index.v1.backup.json`（已存在则保留首次备份，不覆盖）→ 原子写 `index.json`（temp + rename）→ fsync 目录 → 释放锁。
3. 任一步失败：保留备份与原文件，返回 `store/corrupt`（带路径），不静默重建、不半写。
4. 迁移后再次读取只会看到 v2；`migrateV1ToV2` 对 v2 是恒等（幂等），重复调用不产生第二次备份。

**`awaiting_review` 的取消。** 迁移报告列出每条待取消评审；实际归档旧 reviewer 由 store 的迁移入口在写 v2 前执行：`archiveSession(reviewerSessionId,{stopActivity:true})`。成功则 `awaitingReview=false`、`reviewStatus=null`、`reviewerSessionId=null`；失败则把错误写进报告与 activity，并清空 reviewer 指针（避免悬挂），但不把这次迁移标成「评审已安全取消」。归档是异步 I/O，不能放进纯迁移函数。

**测试先行。** 先写会变红的测试，再实现：

- `tests/store-migration.test.mjs`：六态逐条映射；`awaiting_review` 取消；`done/archived`→resolved；字段重命名；未知状态 fail closed；幂等；备份不覆盖。
- `tests/store.test.mjs`：v1 读取兼容、写只写 v2、round-trip、锁内重读、备份路径、损坏文件报错、activity/inbox 原子写与裁剪。

**范围控制。** M7 不接工具、不改 UI、不切默认行为；完成即停，等确认后再进 M8。

## Alternatives considered

**一次性重写 `store.ts`，不拆 schema/migration 模块。** 否决：迁移无法单测（必须真文件系统与锁），现有 42 KB 再加 v2 逻辑会顶到 50 KiB 读取上限；PLAN-V0.2 §4.2 已定模块边界。

**读时惰性迁移、下次写入才落盘。** 否决：会出现「内存 v2、磁盘 v1」的双事实与并发窗口；计划要求迁移前备份、写只写 v2。

**保留 v1 字段、只增补 v2。** 否决：topic-store-v2 已否决 thread 中心 schema；双写会制造两个事实源和竞争条件。

**把 reviewer 归档放进纯迁移函数。** 否决：迁移函数要可单测；宿主归档是异步 I/O 且会失败，必须由调用方执行并把失败写进报告。

**迁移时自动解决所有状态、不 fail closed。** 否决：未知状态或损坏文档自动重建会掩盖数据问题；计划要求报 `store/corrupt` 并保留现场。

**M7 同时建 `activity.ts`/`inbox.ts` 空壳。** 否决：规则在 M8 才定义，空壳会制造「已存在」的错觉并增加类型面。

## Acceptance criteria

- [A1] v1 六态逐条迁移到 v2；`awaiting_review` 取消在途评审并归档旧 reviewer；`done/archived` 转 resolved；未知状态 fail closed — `tests`
- [A2] 迁移前写 `index.v1.backup.json`，已存在不覆盖；迁移失败保留备份与原文件并报 `store/corrupt` — `tests`
- [A3] 写只写 v2、读兼容 v1；`migrateV1ToV2` 幂等；索引/活动/收件箱共用项目锁 — `tests`
- [A4] reviewer 归档失败写进迁移报告与 activity，不静默成功；`activity.jsonl` 上限与损坏行、`inbox.json` 原子重写有测试 — `tests`
- [A5] 模块边界与 source budget 保持（新逻辑不使任何 `src/**/*.ts` 过 50 KiB），typecheck/build 通过 — `source`

## Risks

- 迁移丢数据：备份、fail closed、逐状态测试；重审条件：出现无法映射的状态或用户报告丢失。
- 旧 reviewer 归档失败留下悬挂会话：报告 + activity 记录；重审条件：真实迁移中多次失败。
- 锁竞争：迁移在锁内完成，超时策略沿用现有 store；重审条件：面板与 turn 事件并发导致迁移超时。
- 未知 v1 字段：记录并保留（未知字段容忍），不静默丢弃；重审条件：出现 schema 漂移。
- 时机风险：M7 只动 store 层、不切默认行为；重审条件：迁移后旧会话不可继续。

## Delivery stages

1. M7.1：`store-schema.ts` + `store-migration.ts` 纯函数，先写失败测试再实现。
2. M7.2：`store.ts` 迁移入口、备份、锁内重读、`store/corrupt` 路径。
3. M7.3：activity/inbox 文件 I/O 与裁剪测试。
4. M7.4：`npm test`、`npm run typecheck`、`npm run build` 全绿；阶段结束停下等确认。
