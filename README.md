# @dsh-external/dsh-cowork

DSH 的项目式主从协作插件。0.2.0 采用**主题会话模型**：master 主会话负责路由、验收与合并决定；每个主题一个可打开继续的 topic 会话，在里面建隔离工作项、提交评审请求；reviewer 按请求独立复核。运行数据、活动流与收件箱都落在目标仓库的 `.dsh-cowork/` 里，一个项目一份。

产品范围、架构与阶段验收见 [docs/PLAN-V0.2.md](docs/PLAN-V0.2.md)；0.1.0 的 thread 模型只作为历史保留在 [docs/PLAN.md](docs/PLAN.md)，不再描述当前行为。

## 它提供什么

- **三个 preset**：`cowork-master`（显示为 `Cowork模式`）、`cowork-topic`、`cowork-reviewer`。新建会话只显示 master；topic/reviewer 由插件内部创建，不出现在选择器。定义与工具面见 [src/presets.ts](src/presets.ts)。
- **22 个业务工具**：初始化、路由、主题、handoff、上报、决策提案、待授权、通知读取、用户评审请求、提问、计划确认、工作项、评审、合并、记忆；名称与注册顺序见 [src/tools.ts](src/tools.ts)，参数以各工具模块为准。
- **右侧栏 CoWork 面板**：宽侧栏两列（主题列表 + 请求收件箱），窄侧栏只列主题并在顶部显示“需要你处理 N 项”，点入面板内全宽收件箱。四类请求（用户评审 / 权限审批 / 提问 / PLAN）按“左侧主题消息 + 行动卡 + 解决后的右侧用户回复”展示；分配、上报、决策提案、自动评审结果与归档用居中灰字；主题卡上有独立的收件箱筛选按钮，⋯ 菜单归档/恢复。十条 `/api/cowork.*` 路由见 [src/api-contract.ts](src/api-contract.ts) 与 [src/inbox-contract.ts](src/inbox-contract.ts)。
- **项目记忆 / 活动流 / 通知账本 / master 收件箱 / 请求收件箱**：跨会话保留决定与事实，状态变化可审计；主题通知写 `.dsh-cowork/notices.json` 账本，master 可用 `cowork_notices` 读取；请求收件箱的请求记录写在 `.dsh-cowork/requests/<requestId>.json`，不读写旧 `inbox.json`；旧收件箱只保留合入、评审退回和跨主题冲突等既有事件。

角色边界、状态机与生命周期规则由 [PLAN-V0.2](docs/PLAN-V0.2.md) 拥有；一次需求的完整闭环见 [routing.md](docs/routing.md)，上下文共享与记忆注入见 [context.md](docs/context.md)。

## 安装

前提：

- Node.js >= 22.19（见 `package.json` 的 `engines`）。
- 本机已安装 DSH app。
- 只有修改 `src/` 或生成新的 client bundle 时，才需要一份装好依赖的 DSH 源码 checkout。`scripts/build.sh` 自动探测常见位置，非默认布局用 `DSH_CHECKOUT` / `DSH_APP_NODE_MODULES` 指定。

### 从 tarball 安装（无需先构建）

仓库跟踪构建后的 `lib/`，因此新机器 clone 后可以直接打包，不要求先跑 `npm run build`：

```bash
npm pack          # 产出 dsh-external-dsh-cowork-0.2.0.tgz
```

也可以直接使用发布者提供的同名 tarball。tarball 只含 `lib/`、`cordis.patch.yml`、`README.md`、`LICENSE` 与 `package.json`。装进**专用 profile**，不要装进正在使用的 `web`/`desktop`：

```bash
dsh --profile <profile> --from-default-profile web --dump-config   # 新建 profile
dsh plugin --profile <profile> add ./dsh-external-dsh-cowork-0.2.0.tgz
dsh --profile <profile> --dump-config    # 应出现 dsh-cowork 层，且只有一行 id: dsh-cowork
dsh --profile <profile> --port 3091 --no-open
```

启动日志会打印带 token 的已认证 URL；用浏览器打开**这条 URL**（不带 token 时 `/api` 返回 401）。新建会话选 `Cowork模式`（preset id 仍是 `cowork-master`），在目标仓库目录调用一次 `cowork_project_init` 完成初始化。

### 修改源码后重新打包

修改 `src/` 后运行：

```bash
npm run build     # 编译 host 到 lib/，并打包浏览器半边 lib/client.js
npm pack          # 产出新的 tarball
```

`lib/` 是提交产物，构建后要连同源码改动一起提交；`*.tgz` 仍是本地产物，不进入 git。

安装注意：

- `--from-default-profile` 只用于新建 profile（目标必须尚不存在）；已有 profile 去掉该参数。
- 安装、升级、卸载后都要重启 profile 进程，旧进程不会热加载新 bundle。
- 只承诺 tarball 安装：包是 `private: true`，未发布 npm；不要直接把 git 地址当作安装源。
- `--dump-config` 看不到 cowork 层时，检查 profile 补丁里是否有 `disabled: true` 的 `dsh-cowork` 条目压住了 bundle 行。

## 一次需求的闭环

1. **初始化**：master 调用 `cowork_project_init`，索引记录 `masterSessionId`。
2. **路由**：`cowork_route` 按三层判断复用或新建主题；明确指定的已解决主题返回 `resolvedMatch` 并新建主题，不向旧主题发消息。
3. **主题内工作**：topic 用 `cowork_work_item_create` 建隔离工作项（clone 到 `.dsh-cowork/workitems/<id>`，分支 `cowork/<id>`），在 clone 里提交；可以并行多个工作项。
4. **请求评审**：工作就绪后 topic 调用 `cowork_review_request`；插件校验范围、创建 reviewer、写 pending 请求文件并投递评审说明。
5. **出 verdict**：reviewer 自己读代码、复跑验证，按 `requestId` 写一次 `cowork_review_verdict`（`pass` / `needs_revision` / `reject`）；verdict 后 reviewer 会话归档。
6. **合并**：master 收到 `merge-needed` 收件箱后，用 `cowork_checkout_merge` 合并同一 head 已通过评审的工作项；`main`/`master` 不动，冲突保留 clone 由主题解决。
7. **handoff / 上报**：主题结束时调用 `cowork_handoff`；`done` 写摘要与交付确认，`blocked` 置 handoff 阻塞。进度/阻塞也可以先用 `cowork_topic_report` 单独上报。这些事件写 activity 与通知账本，不再通过收件箱唤醒 master；master 用 `cowork_notices` 读取。
8. **已解决与重开**：主题没有自动 resolved；空闲从最后一次活动起 24 小时。用户从主题卡 ⋯ 菜单归档（会同时归档宿主主题会话），已解决卡同一菜单恢复（unarchive，不写通知）。待授权通过 `cowork_authorization_request` 产生，由 master 或该主题会话调用 `authorization.resolve` 决定。

主题页提供单列四组列表和 ⋯ 归档/恢复；点卡片或“需要你处理”打开主题会话。宽侧栏下右侧是请求收件箱：四类请求解决后右侧出现用户回复并唤醒主题会话，通知只读；主题卡筛选按钮只过滤收件箱，不打开会话。决策记录查看、工作项和评审详情不在主题页，留给后续工作项页。

## 主题页、收件箱与 reviewer 的可见性

- **主题页是单列列表**：四组按阻塞 / 运行中 / 空闲 / 已解决排序，已解决默认折叠；卡片两行，标记在主题名右侧、时间在摘要右侧；⋯ 菜单只有归档或恢复。需要你处理只统计 pending 请求（待授权 / 待审核 / 待回答 / 待确认）。
- **收件箱是 Cowork tab 内的第二列**：宽侧栏（面板内容宽 ≥620px）左主题栏固定、右收件箱独立滚动；窄侧栏隐藏收件箱，顶部显示“需要你处理 N 项”，点击进入面板内全宽收件箱。宿主当前没有右栏宽度 setter，插件不操作宿主布局（[KI-42](docs/KNOWN_ISSUES.md)）。
- **请求与自动评审是两条线**：用户评审请求（`cowork_user_review_request`）有卡片和通过/退回动作；自动 reviewer 的 `review-verdict` 只投影成居中灰字记录，无动作、无链接、不进入待处理计数。只有 authorization 会改变主题阻塞状态。
- **归档会归档宿主主题会话**：菜单归档通过 resolve 路由清 block/authorization、写只给主会话的 `topic-archived` 通知，并 `archiveSession` 主题会话；恢复走 reopen/unarchive，不产生通知。主题会话不再按 v1 的方式常驻左侧栏。
- **reviewer 不出现在 CoWork 列表**：面板只列主题，评审结果由 review 工具/请求文件承载；主题页不再展示评审卡。verdict 后插件归档 reviewer 会话。
- **宿主左侧栏可能看到 reviewer**：插件没有会话过滤接口，这是已接受的上限（[KI-28](docs/KNOWN_ISSUES.md)）；不要理解为 reviewer 已对宿主隐藏。
- **会话提醒卡按 B 延期**：运行宿主没有 A2 notice 通道，主会话/主题会话不显示分配/上报/提案/待授权提醒；`notices.json` 账本照写并保持 pending，master 用 `cowork_notices` 读取。宿主 A2 发布后补端口适配器与客户端渲染器（[KI-40](docs/KNOWN_ISSUES.md)）。

## 升级到 0.2.0：迁移与回滚

0.1.0 的索引是 v1（`threads[]`），0.2.0 写 v2（`topics[]` + `workItems[]`）。**首次写路径**会执行一次性迁移：`cowork_project_init`、`cowork_route`、`cowork_handoff` 等写入会触发，**打开 CoWork 面板也会**（面板的 overview 会执行一次生命周期写路径）。纯读不会迁移。

迁移做的事：

- 迁移前把原始 v1 字节复制到 `<repo>/.dsh-cowork/index.v1.backup.json`（只写一次，不覆盖已有备份）。
- 映射：`new/active` → `active`；`awaiting_review` → `active` 并取消在途评审（旧 reviewer 归档）；`blocked` → `active` + `blocked`；`done/archived` → `resolved`；`threadId`→`topicId`、`subject`→`title`、`checkoutPath`→`legacyCheckoutPath`；`new/archived` 用 `legacyStatus` 标记保留。
- 迁移成功后向 `activity.jsonl` 追加一条 `status-changed`（“migrated project index to v2”）与每条归档失败的 `error` 行；v2 已落盘，活动写失败不回滚迁移。
- fail closed：未知 v1 状态或校验失败报 `store/corrupt`，备份与原始文件保持原样。规则与实现见 [store-migration.ts](src/store-migration.ts) 与 [store.ts](src/store.ts)。

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
4. 删除迁移新增的 `activity.jsonl`（迁移前已有的活动文件不要删），保留 `memory/`、`handoffs/`、`reviews/` 与已有 `inbox.json`；`.write.lock` 可保留。
5. 卸载 0.2.0，重装 0.1.0 tarball 并重启。回滚期间不要用 0.2.0 打开面板，否则会再次迁移。

卸载本身不会改写 `<repo>/.dsh-cowork/`；只要没有用 0.2.0 写入或打开面板，数据保持原样。

## 0.2.0 破坏性变更

- 面板/API 从 v1 thread wire 换成 v2 wire（主题、工作项、评审请求、活动、收件箱）；`/api/cowork.handoff` 路由移除。外部消费方按 [api-contract.ts](src/api-contract.ts) 的 v2 形状重接（[KI-6](docs/KNOWN_ISSUES.md)）。
- `cowork_handoff` 只接受 `blocked` / `done`；`awaiting_review` 不再是合法状态。
- `cowork_review_request` 只接受 topic 会话调用，master 调用被明确拒绝；每次请求绑定 `requestId` 并新建 reviewer。
- `cowork_checkout_merge` 按 `workItemId` 合并，要求同一 head 的评审已通过；`allowUnreviewed` / `overrideReason` 已移除；`threadId` 仅作为旧 clone 的兼容参数。
- `cowork-thread` preset 已删除；使用它的旧会话在升级后无法恢复。新会话和存量 topic 都使用 `cowork-topic`。
- 写入路径只写 v2；v1 旧文件（旧 handoff/review 文件）只读。

## 卸载

```bash
dsh plugin --profile <profile> remove @dsh-external/dsh-cowork
```

- profile 的 bundles 回到安装前集合，`node_modules/@dsh-external` 为空，`--dump-config` 不再有 cowork 层。
- `<repo>/.dsh-cowork/` 不随卸载删除：索引、记忆、handoff 与评审文件都保留。
- 使用 cowork preset 的旧会话在卸载后无法恢复（preset 定义随包消失）；卸载前先归档或导出要保留的会话。

## 限制与前提

- **dev 面默认关闭**：`/dsh-cowork/probe/*`、`/dsh-cowork/e2e/*` 与探针工具只在 `enableDevRoutes: true` 时注册，正常安装不可见。
- **client 只支持 web**：`dsh.client.platform` 是 `web`，面板挂在 Web UI 右侧栏。
- **reviewer 的只读不是沙箱**：工具面无 `fs`，但 `bash` 仍可改文件；只读性靠 preset 与 protocol（[KI-15](docs/KNOWN_ISSUES.md)）。
- **合并冲突不自动解决**：冲突中止主仓合并并保留工作项 clone，由主题或人处理（[KI-4](docs/KNOWN_ISSUES.md)）。
- **`main`/`master` 不动**：插件拒绝合并到受保护分支，默认分支由人收口。
- **收件箱是 at-least-once**：投递成功但 `deliveredAt` 未写时可能重复提示，不会丢事件（[KI-23](docs/KNOWN_ISSUES.md)）。
- **请求收件箱的文件打开依赖桌面宿主**：PLAN/提案的“查看全文”由宿主 `sessionController.openWorkspacePath({ path, action: 'reveal' }, signal)` 执行（插件 port 传 `AbortSignal.timeout(10s)`；服务端解析仓库内路径，浏览器只传 id）；宿主没有该能力或拒绝时路由返回 `inbox/open-unsupported`，UI 显示错误，不伪造打开。
- **右栏宽度由宿主控制**：插件没有宽度 setter；窄侧栏只能降级为面板内全宽收件箱，不操作宿主 DOM（[KI-42](docs/KNOWN_ISSUES.md)）。
- **工作项 clone 只含已提交文件**：看不到主仓未提交改动与本地依赖，需要自装依赖（[KI-1](docs/KNOWN_ISSUES.md)）；隔离提供方当前只实现 clone（[KI-27](docs/KNOWN_ISSUES.md)）。
- **文件策略前提是 workspace-write**：隔离目录必须可写（[KI-5](docs/KNOWN_ISSUES.md)）。
- **workspace 记录启动补建（过渡，[KI-39](docs/KNOWN_ISSUES.md)）**：启动时只对存在 `.dsh-cowork/index.json` 的项目补建缺失的 DSH workspace，并 attach 会话；手动删除 workspace 后若其会话仍在项目根，下次启动会被重建。目标机制仍是只由 `cowork_project_init` / 会话创建登记。
- **面板 API 的信任边界**：loopback + 同源 + JSON content-type；写路由只允许该项目的 master。

## 本地检查

```bash
npm run check              # 可执行约定（AGENTS 预算 / workflow.json / 模板 / 发布清单）
npm run check:self-test    # 证明上述守卫能变红
npm test                   # 契约与行为测试
npm run test:coverage      # host TypeScript 覆盖率下限
npm run test:host-smoke    # 打包当前 lib/，在临时 DSH profile 启动并检查健康路由
npm run check:lib-sync     # 检查 src 与已提交 lib/ 的构建摘要是否一致
npm run change-scope -- --base <verified-base>  # 列出 committed/staged/unstaged/untracked 路径
npm run typecheck          # TypeScript 检查（依赖同构建前提）
npm run build              # host + client 构建
```

`test:host-smoke` 使用临时 `DSH_HOME` 和临时 npm 缓存，不读写用户的真实 profile。`lib/` 已跟踪到 git；源码变更后运行 `npm run build`，并把对应的 `lib/` 变更一起提交。`npm test` 会运行同一个 `lib/build-info.json` 校验，源码改了而 `lib/` 没重建会直接变红。

审查与交付流程见 [.agents/skills/README.md](.agents/skills/README.md)（`code-review` / `pre-push-checks` / `pr-description` / `merging-stacked-prs` / `find-simplifications`）；PR 结构由 [pr-description](.agents/skills/pr-description/SKILL.md) 声明，不再维护独立的 `.github` 模板文件。

## 文档与规则

- 产品范围与架构：[PLAN-V0.2](docs/PLAN-V0.2.md)（V0.2）、[PLAN](docs/PLAN.md)（V0.1 历史）。
- 路由与上下文：[routing.md](docs/routing.md)、[context.md](docs/context.md)。
- 术语：[glossary.md](docs/glossary.md)、面向非术语读者的说法：[plain-language.md](docs/plain-language.md)。
- 遗留与重估条件：[KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)；怎样才算验证过：[testing.md](docs/testing.md)。
- 文档规范与发布开关：[docs/AGENTS.md](docs/AGENTS.md)；全部文档索引：[docs/README.md](docs/README.md)。
- 仓库常驻规则：[AGENTS.md](AGENTS.md)；改一个文件欠哪些证据：[tools/workflow.json](tools/workflow.json)。

## 许可

MIT，见 [LICENSE](LICENSE)。
