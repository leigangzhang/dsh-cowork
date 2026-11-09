# @dsh-external/dsh-cowork

DSH 的项目式主从协作插件。0.2.0 采用**主题会话模型**：一个 profile 里同时提供 master 主会话、按主题创建的 topic 会话、按评审请求创建的 reviewer，以及项目记忆、隔离工作项、评审请求、活动流与 master 收件箱。产品范围、架构与阶段计划见 [docs/PLAN-V0.2.md](docs/PLAN-V0.2.md)；0.1.0 的 thread 模型保留在 [docs/PLAN.md](docs/PLAN.md) 作为历史，不再描述当前行为。

项目数据落在目标仓库的 `<repo>/.dsh-cowork/`，一个项目一份；插件不往 `~/.dsh` 写项目状态。

## 角色

| 角色 | 载体 | 职责 | 不做什么 |
|---|---|---|---|
| master | 普通会话 + `cowork-master` | 项目入口；路由需求、记录决定、验收与合并决定 | 不写实现；工具面无 `fs`/`bash`/搜索 |
| topic | 普通会话 + `cowork-topic` | 一个主题一个会话；可含多个工作项；自己提交评审请求、写摘要与证据 | 不向其他主题发消息，不合并别人的分支 |
| reviewer | 普通会话 + `cowork-reviewer` | 按一次评审请求独立复核，给出一个 verdict | 不改代码、不合并、不解决冲突；verdict 后归档 |
| 插件 | host 插件 + 右侧栏 CoWork tab | 三态生命周期、路由、评审请求、reviewer 生命周期、隔离目录、活动流、收件箱、记忆文件 | 不做产品决定，不判断质量 |

## 四个 preset

| preset | 谁创建 | 职责 | 工具面 |
|---|---|---|---|
| `cowork-master` | 用户新建会话时选择 | 初始化项目、路由、验收、按评审结果决定合并 | persona、常驻指令、时间、ask-user、todo；无 `fs`/`bash`/搜索 |
| `cowork-topic` | 插件在路由新建主题或 `cowork_topic_create` 时创建 | 在主题内工作、创建隔离工作项、提交评审请求、handoff | topic 全套：`fs`、`bash`、搜索、jobs、ask-user、todo、present |
| `cowork-thread` | 不再新建；仅兼容旧会话 | `cowork-topic` 的弃用别名，工具行完全相同 | 同 `cowork-topic` |
| `cowork-reviewer` | 插件在评审请求被接受时创建 | 只读复核一次请求并写一个 verdict | 仅 `bash` + 文件搜索；无 `fs`（无 read/write/edit） |

preset 定义在 [src/presets.ts](src/presets.ts#L121-L199)，阶段决策见 [PLAN-V0.2 §5.8](docs/PLAN-V0.2.md#58-预设与记忆)。

## 业务工具

15 个业务工具的注册顺序与角色以 [src/tools.ts](src/tools.ts#L55-L76) 为准；下表只说明用途，不复制参数。

| 工具 | 角色 | 用途 |
|---|---|---|
| `cowork_project_init` | master | 初始化项目索引，把调用会话登记为 master；幂等，`takeOver` 可显式接管 |
| `cowork_project_status` | master/topic | 有界的项目摘要、待决定收件箱与活动尾部；同时执行生命周期读取点 |
| `cowork_route` | master | 三层路由；可指定 `topicId`、`brief`、`forceCreate` |
| `cowork_topic_create` | master | 显式新建主题（会话 + 索引记录） |
| `cowork_thread_create` | master | `cowork_topic_create` 的弃用别名 |
| `cowork_topic_list` | master/topic | 有界主题列表 |
| `cowork_thread_list` | master/topic | `cowork_topic_list` 的弃用别名 |
| `cowork_handoff` | topic | 以 `blocked` 或 `done` 汇报；写审计文件并更新主题 |
| `cowork_topic_resolve` | master | 手动标记主题已解决（幂等，无撤销） |
| `cowork_work_item_create` | topic/master | 创建隔离工作项：clone 到 `.dsh-cowork/workitems/<id>`，分支 `cowork/<id>` |
| `cowork_review_request` | 仅 topic | 校验范围后创建 reviewer、写 pending 评审请求文件并投递评审说明 |
| `cowork_review_verdict` | reviewer | 对 `requestId` 写一次 verdict；`pass` / `needs_revision` / `reject` |
| `cowork_memory_write` | master/topic | 追加项目记忆条目 |
| `cowork_memory_search` | master/topic | 检索项目记忆 |
| `cowork_checkout_merge` | master | 合并同一 head 已通过评审的工作项；`main` 不动 |

角色守卫、失败码与参数细节在各工具模块（[project](src/project-tools.ts#L149-L197)、[route](src/route-tools.ts#L441)、[topic](src/topic-tools.ts#L442-L514)、[work item](src/checkout-tools.ts#L199)、[review](src/review-tools.ts#L528-L835)、[merge](src/checkout-tools.ts#L574)、[memory](src/memory-tools.ts#L40-L105)）。

## 主题与 reviewer 的可见性

- **主题保留在左侧栏**：主题是普通 DSH 会话，插件不归档主题；打开主题只是切换主区，不新增或移除左侧栏条目。已解决主题仍列在 CoWork 与左侧栏，可打开并重新打开。
- **reviewer 不出现在 CoWork 列表**：面板只列主题；评审结果以评审卡挂在主题详情。verdict 后插件归档 reviewer 会话。
- **宿主左侧栏可能看到 reviewer**：插件没有会话过滤接口，这是已接受的上限（[KI-28](docs/KNOWN_ISSUES.md)），不要理解为“reviewer 已对宿主隐藏”。

## 安装

前提：Node.js >= 22.19（`package.json` 的 `engines`）；本机已安装 DSH app；构建还需要一份装好依赖的 DSH 源码 checkout。`scripts/build.sh` 会自动探测常见位置，非默认布局用 `DSH_CHECKOUT` / `DSH_APP_NODE_MODULES` 指定。

```bash
npm run build
npm pack
```

`npm run build` 编译 host 到 `lib/` 并打包浏览器半边 `lib/client.js`；`npm pack` 产出 `dsh-external-dsh-cowork-0.2.0.tgz`，只含 `lib/`、`cordis.patch.yml`、`README.md`、`LICENSE` 与 `package.json`。

建一个**专用 profile** 再安装，不要装进正在使用的 `web`/`desktop`：

```bash
dsh --profile <profile> --from-default-profile web --dump-config
dsh plugin --profile <profile> add ./dsh-external-dsh-cowork-0.2.0.tgz
dsh --profile <profile> --dump-config        # 应出现 dsh-cowork 层，且只有一行 id: dsh-cowork
dsh --profile <profile> --port 3091 --no-open
```

启动日志会打印带 token 的已认证 URL；用浏览器打开**这条 URL**（不带 token 时 `/api` 返回 401）。新建会话时选择 `cowork-master`，在目标仓库目录调用一次 `cowork_project_init`。

安装注意事项：

- `--from-default-profile` 只用于新建 profile，目标必须尚不存在；使用已有 profile 时去掉该参数。
- 安装或升级后必须重启 profile 进程，旧进程不会热加载新 bundle。
- 只承诺 tarball 安装：本包 `private: true`，未发布 npm；也不要用 git 地址安装（git 源码没有预构建的 `lib/`）。
- 若 `--dump-config` 看不到 cowork 层，检查 profile 补丁里是否有 `disabled: true` 的 `dsh-cowork` 条目压住了 bundle 行。

## 升级到 0.2.0：迁移与回滚

0.1.0 的索引是 v1（`threads[]`），0.2.0 写 v2（`topics[]` + `workItems[]`）。**首次写路径**会执行一次性迁移：`cowork_project_init`、`cowork_route`、`cowork_handoff` 等写入会触发，打开 CoWork 面板也会（面板的 overview 会执行一次生命周期写路径）。纯读不会迁移。

迁移做的事：

- 迁移前把原始 v1 字节复制到 `<repo>/.dsh-cowork/index.v1.backup.json`（只写一次，不覆盖已有备份）。
- v1 → v2 映射：`new/active` → `active`；`awaiting_review` → `active` 并取消在途评审（`awaitingReview=false`、`reviewStatus=null`，旧 reviewer 归档）；`blocked` → `active` + `blocked`；`done/archived` → `resolved`；`threadId`→`topicId`、`subject`→`title`、`checkoutPath`→`legacyCheckoutPath`；`new/archived` 用 `legacyStatus` 标记保留。
- 迁移成功后向 `activity.jsonl` 追加一条 `status-changed`（“migrated project index to v2”）及每条归档失败的 `error` 行；v2 已落盘，活动写失败不回滚迁移。
- 迁移是 fail closed 的：未知 v1 状态或校验失败会报 `store/corrupt`，备份与原始文件保持原样。规则与实现见 [store-migration.ts](src/store-migration.ts#L209-L360) 与 [store.ts](src/store.ts#L973-L1078)。

升级命令（同一路径的 tgz 会被判为已安装，必须先 remove）：

```bash
dsh plugin --profile <profile> remove @dsh-external/dsh-cowork
dsh plugin --profile <profile> add ./dsh-external-dsh-cowork-0.2.0.tgz
# 重启 profile
```

回滚到 0.1.0：

1. 升级前保留 0.1.0 的 tarball；升级后先备份整个 `<repo>/.dsh-cowork/`。
2. 停止宿主进程，确认端口已释放。
3. `cp .dsh-cowork/index.v1.backup.json .dsh-cowork/index.json`。
4. 删除迁移新增的 `activity.jsonl`（若迁移前不存在；迁移前已有的活动文件不要删），保留 `memory/`、`handoffs/`、`reviews/`；`.write.lock` 可保留。
5. 卸载 0.2.0，重装 0.1.0 tarball 并重启。回滚期间不要用 0.2.0 打开面板，否则会再次迁移。

真实项目的索引在卸载后不会被改写；只要没有用 0.2.0 写入或打开面板，`.dsh-cowork/` 仍是原样。

## 0.2.0 破坏性变更

- 面板/API 从 v1 thread wire 换成 v2 wire：主题、工作项、评审请求、活动、收件箱；`/api/cowork.handoff` 路由移除。外部消费方需按 [api-contract.ts](src/api-contract.ts#L15-L31) 的 v2 形状重接（[KI-6](docs/KNOWN_ISSUES.md)）。
- `cowork_handoff` 只接受 `blocked` / `done`；`awaiting_review` 不再是合法状态。
- `cowork_review_request` 只接受 topic 会话调用；master 调用被明确拒绝。评审请求绑定 `requestId`，每次请求新建 reviewer。
- `cowork_checkout_merge` 按 `workItemId` 合并，要求同一 head 的评审已通过；`allowUnreviewed` / `overrideReason` 已移除；`threadId` 仅作为旧 clone 的兼容参数。
- 旧 `cowork-thread` preset 保留一个版本作为别名；新会话使用 `cowork-topic`。旧 `cowork-thread` 会话仍可继续，但不再有 v1 的 handoff/评审语义。
- 写入路径只写 v2；v1 旧文件（旧 handoff/review 文件）只读，不再新增。

## 一次需求的闭环

1. **初始化**：master 在目标仓库调用 `cowork_project_init`；索引记录 `masterSessionId`，主题会话与 master 都保留在左侧栏。
2. **路由**：用户需求进入 master，`cowork_route` 按三层判断复用主题或新建；明确指定已解决主题时返回 `resolvedMatch` 并新建主题，不向已解决主题发消息。
3. **主题内工作**：topic 用 `cowork_work_item_create` 建隔离工作项，在 clone 里提交；可以并行多个工作项，主题是集成分支的负责人。
4. **请求评审**：工作就绪后 topic 调用 `cowork_review_request`，插件校验范围、创建 reviewer、写 pending 请求文件并投递评审说明。
5. **出 verdict**：reviewer 自己读代码、复跑验证，按 `requestId` 写一次 `cowork_review_verdict`。`pass` 在共享工作区直接确认交付、有工作项时进入合并决定；`needs_revision` 只把 findings 投回主题；`reject` 把主题置 blocked 并写收件箱。
6. **合并**：master 收到 `merge-needed` 收件箱后，用 `cowork_checkout_merge` 合并同一 head 已通过评审的工作项。插件拒绝 main/master、拒绝脏 clone、拒绝 head 已移动的范围；冲突保留 clone 由主题解决。
7. **handoff**：主题结束（或阻塞）时调用 `cowork_handoff`。`done` 写摘要与交付确认，不唤醒 master；`blocked` 置标记并通过收件箱唤醒 master。
8. **已解决与重开**：满足“无待评审、未阻塞、最新评审不是 `needs_revision`、无进行中工作项、有摘要、已确认交付、静默超过 `resolveAfterMs`”时自动标记 resolved（默认 3 天），用户也可手动标记；没有撤销。用户打开已解决主题并输入，或面板“重新打开”，把它置回 active 并清空 `resolvedAt/resolvedBy`。
9. **面板**：右侧栏 CoWork tab 提供主题列表/详情、活动、已解决与重开、改投。六条 `/api/cowork.*` 路由见 [api-contract.ts](src/api-contract.ts#L15-L31)。

路由判定、工作项与评审的时序、状态归属和失败处置见 [routing.md](docs/routing.md)；master/topic/reviewer 的上下文共享见 [context.md](docs/context.md)。

## 数据落点

| 路径 | 内容 |
|---|---|
| `index.json` | v2 项目索引：master、主题、工作项、路由目标 |
| `activity.jsonl` | 有界活动流（最多 500 条 / 512 KiB），所有状态与决定的可审计证据 |
| `inbox.json` | master 收件箱；最多 50 条，投递后写 `deliveredAt` |
| `handoffs/` | 每次 handoff 一份 `<topicId>-<stamp>.json` 审计文件 |
| `reviews/` | 每次评审请求一份 `<topicId>-<requestId>.json`（pending 或 verdict） |
| `workitems/` | 隔离工作项 clone，分支 `cowork/<workItemId>` |
| `memory/` | 项目记忆三文件（constraints / decisions / facts） |
| `e2e/` | 维护者端到端与安装验证证据，日常使用不产生 |

写入通过 `.dsh-cowork/.write.lock` 串行化。本仓库 [.gitignore](.gitignore) 已忽略 `.dsh-cowork/`；在你自己的项目里也请加入 `.gitignore`——索引、活动、评审与 clone 都是运行数据。

## 卸载

```bash
dsh plugin --profile <profile> remove @dsh-external/dsh-cowork
```

- profile 的 bundles 回到安装前的集合，`node_modules/@dsh-external` 为空，`--dump-config` 不再有 cowork 层。
- `<repo>/.dsh-cowork/` 不随卸载删除：项目索引（v1 或 v2 的原样）、记忆、handoff 与评审文件都保留。
- 使用 cowork preset 的旧会话在卸载后无法恢复（preset 定义随包消失）；卸载前先归档或导出要保留的会话。
- 升级 / 重装 = `remove` 之后 `add` 新 tarball，再重启 profile。

## 限制与前提

- **dev 探针与 E2E 路由默认不启用**：`/dsh-cowork/probe/*`、`/dsh-cowork/e2e/*` 与两个探针工具只在 `enableDevRoutes: true` 时注册，正常安装不可见。
- **client 只支持 web**：`dsh.client.platform` 是 `web`，面板只挂 Web UI 右侧栏。
- **reviewer 的只读不是沙箱**：工具面无 `fs`，但 `bash` 仍可改文件；只读性靠 preset 与 protocol（[KI-15](docs/KNOWN_ISSUES.md)）。
- **合并冲突不自动解决**：冲突中止主仓合并并保留工作项 clone，由主题或人处理后再合并（[KI-4](docs/KNOWN_ISSUES.md)）。
- **`main`/`master` 不动**：插件拒绝合并到受保护分支；默认分支由人收口。
- **收件箱是 at-least-once**：投递成功但 `deliveredAt` 未写时可能重复提示，不会丢事件（[KI-23](docs/KNOWN_ISSUES.md)）。
- **工作项 clone 只含已提交文件**：看不到主仓未提交改动与本地依赖，需要自装依赖（[KI-1](docs/KNOWN_ISSUES.md)）；隔离提供方当前只实现 clone（[KI-27](docs/KNOWN_ISSUES.md)）。
- **文件策略前提是 workspace-write**：隔离目录必须可写（[KI-5](docs/KNOWN_ISSUES.md)）。
- **面板 API**：loopback + 同源 + JSON content-type；写路由只允许该项目 master。

## 仓库布局

```text
dsh-cowork/
├── package.json          # dsh.bundle.patch / dsh.client / files
├── cordis.patch.yml      # insert: dsh-cowork
├── src/
│   ├── index.ts          # 装配：服务 / 工具 / presets / 路由 / dev 面
│   ├── tools.ts          # 15 个业务工具的装配顺序
│   ├── tool-runtime.ts   # 依赖包、项目打开、生命周期读取点、收件箱
│   ├── project-tools.ts / route-tools.ts / topic-tools.ts
│   ├── checkout-tools.ts / review-tools.ts / memory-tools.ts
│   ├── routing.ts / router-model.ts     # 三层路由与模型兜底
│   ├── topic.ts / topic-events.ts       # 三态生命周期与事件
│   ├── activity.ts / inbox.ts           # 活动流与收件箱
│   ├── store.ts / store-schema.ts / store-migration.ts
│   ├── work-item.ts / checkout.ts / checkout-teardown.ts
│   ├── review-request.ts                # 请求记录、文件与合并门
│   ├── session-slice.ts / session-visibility.ts
│   ├── presets.ts / memory.ts / memory-prompt.ts
│   ├── api.ts / api-contract.ts / panel-probe.ts
│   ├── m12-e2e.ts / m12-e2e-support.ts   # 维护者真实全链路 E2E（默认不启用）
│   └── client/           # 右侧栏 CoWork 面板
├── tests/                # 模块与仓库契约测试
├── tools/                # workflow.json + check-invariants.mjs
├── docs/                 # 方案、评审记录、已知问题与文档规范
└── .agents/notes/        # 决策记录
```

## 本地检查

```bash
npm run check              # 可执行约定（AGENTS 预算 / workflow.json / 模板 / 发布清单）
npm run check:self-test    # 证明上述守卫能变红
npm test                   # 仓库自身的契约测试
npm run typecheck          # TypeScript 检查（依赖同构建前提）
npm run build              # host + client 构建
```

## 文档索引

| 想了解 | 看哪里 |
|---|---|
| 0.2.0 产品范围、架构、M6–M12 阶段与验收 | [docs/PLAN-V0.2.md](docs/PLAN-V0.2.md) |
| 0.1.0 产品范围与 M0–M4 历史 | [docs/PLAN.md](docs/PLAN.md) |
| 一个需求如何被路由、评审与合并 | [docs/routing.md](docs/routing.md) |
| master/topic/reviewer 如何共享上下文与记忆 | [docs/context.md](docs/context.md) |
| 术语含义与拼写 | [docs/glossary.md](docs/glossary.md) |
| 明确不修的问题与重估条件 | [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) |
| 怎样才算验证过、证据怎么留 | [docs/testing.md](docs/testing.md) |
| 文档种类、单一事实源、发布开关 | [docs/documentation.md](docs/documentation.md) |
| 全部文档索引 | [docs/README.md](docs/README.md) |
| 常驻工程规则 | [AGENTS.md](AGENTS.md) |
| 改一个文件欠哪些证据 | [tools/workflow.json](tools/workflow.json) |

## 许可

MIT，见 [LICENSE](LICENSE)。
