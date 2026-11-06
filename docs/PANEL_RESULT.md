# Cowork 面板结果（M3 前端）

- 结论：右侧栏 `Cowork` 只读面板已交付——底栏入口 + session scope tab、>480 分栏 / ≤480 钻取、状态 chips 与优先级排序、详情（摘要 / 验证 / 变更文件 / 交接单绝对路径 / MASTER 原文）、两个只读 API（`/api/cowork.overview`、`/api/cowork.handoff`）与客户端构建链（借 DSH checkout 的 esbuild）。真实宿主上默认态、五状态夹具、错误、空、长列表均通过；钻取、深浅色、guide 与两个动作按钮未在真实宿主逐项点过（见「未验证」）。
- 证据：截图落点 `.dsh-cowork/e2e/panel/*.jpg`（gitignored，本机保留）；命令与数值见下。
- 环境：宿主 `dsh web`（web profile，0.2.1-rc.2，由 VS Code 扩展拉起）`http://127.0.0.1:3080`；Chrome 由 BrowserSkill 0.4.2 驱动；插件以 `dev_inject_plugin` 注入。

## 交付面

| 落点 | 职责 |
|---|---|
| [`src/api.ts`](../src/api.ts) | 两条只读 Exact Fetch 路由、项目定位（sessionId → 会话元数据 cwd → `findProjectRoot`）、overview/handoff 纯映射、错误包络 |
| [`src/api-contract.ts`](../src/api-contract.ts) | 两端共享 wire 契约：路径、类型、错误码、排序/计数/默认选中纯函数 |
| [`src/index.ts`](../src/index.ts) | 装配 `connection` 与 `sessionController.list` 端口；不改既有探针与工具 |
| [`src/client/`](../src/client/) | 浏览器半边：tab/底栏/guide 注册、面板壳与列表/详情、样式与本地契约 |
| [`scripts/build-client.mjs`](../scripts/build-client.mjs) | esbuild 单文件 CJS 构建 + 产物自检 |
| [`scripts/build.sh`](../scripts/build.sh) | host 编译后构建 client；`--no-emit` 同时 typecheck client |
| [`tests/`](../tests/) | `api-contract`/`api`/`panel-model` 共 51 个新用例（全量 116） |

## 数据契约（v0 只读）

- `GET /api/cowork.overview?sessionId=` → `{ok:true, project:{repoPath,projectId,masterSessionId,createdAt}, counts:{new,active,awaiting_review,blocked,done}, threads:[{threadId,subject,status,cwd,checkoutPath,createdAt,updatedAt,lastHandoffAt,hasHandoff}]}`。`archived` 不返回；排序 `awaiting_review → blocked → active → new → done`，同状态 `updatedAt` 倒序；上限 500。
- `GET /api/cowork.handoff?sessionId=&threadId=` → `{ok:true, handoff:{record, filePath, masterMessage, formatterVersion}}`。`masterMessage` 是 `formatMasterMessage(record, filePath)` 的读时原文，不落盘、不截断。
- 错误 `{ok:false,error:{code,message,path?}}`：400（缺参 / `session/unknown` / `session/cwd-unavailable`）、404（`project/not-initialized` / `handoff/not-found`）、500（`store/corrupt` 带 path、`internal`）；成功与错误都带 `content-type: application/json` 与 `cache-control: no-store`。
- 认证：路由挂在 `connection` 服务的 Exact Fetch 通道（`/api/*`），继承 Host/Origin 围栏与浏览器 cookie；无 cookie 的 curl 实测 401（0.001 s）。浏览器只传 `sessionId`/`threadId`，项目根由 host 推出，绝不接受路径参数。

## 客户端与构建

- 注册：`sidebarRightTabs.register({id:'@dsh-external/dsh-cowork/panel', kind:'cowork', title, guide:1})` + `sidebar.right.pane.tab` / `.title` + `sidebar.footer.action`（id `cowork-open`）。打开用 `ctx.sidebarRight.openTab('cowork')`；「打开 thread 会话」用 `ctx.uiWorkspace.openSession(threadId)`，服务缺失时禁用并给提示。
- 布局：`ResizeObserver` 测 `.cw-root`——`>480px` 左右分栏（列表 248px + 详情），`≤480px` 单列钻取（可返回「全部 thread」）；状态 chips；列表 `role=listbox/option` + `aria-selected` + 方向键/Home/End；详情 `role=region`；`:focus-visible` 2px 焦点环；`prefers-reduced-motion` 关动效。
- 主题：只消费 14 个公开 token，内部别名（`border-l3`/`interactive-bg-hover`/`radius-sm`）全部带 fallback；未自造 `text-primary`/`state-info`/`focus-ring` 等。
- 构建：`scripts/build-client.mjs` 用 DSH checkout 的 esbuild 0.28.1 产出 `lib/client.js`（53,033 B），首行 `window.__ModuleLoader__.load({ id: "@dsh-external/dsh-cowork", …`，`react` / `react/jsx-runtime` 保持外部 require，产物无 `require("node:`；脚本内置对以上契约的自检。

## 真实宿主证据

1. **构建与加载**：`npm run build` exit 0；注入器前置校验 `client ✓`；浏览器网络出现 `…@dsh-external/dsh-cowork-panel/client.js`（200）；底栏出现「打开 Cowork 面板」，点击后右侧栏出现 `Cowork` tab。
2. **默认态（真实项目）**：截图 `01-real-project-default.jpg`。头部 `/Users/ray/Workspace/dsh-cowork` + 刷新；chips 进行中 0 / 待审查 0 / 受阻 0 / 已完成 1 / 新建 0；列表「已完成 · 路由演示 · 3 小时前 · 交接单」；详情含摘要、3 条验证（exit 0 绿色 chip）、变更文件、交接单绝对路径 + 复制按钮、MASTER 折叠。
3. **MASTER 原文**：截图 `02-real-project-master-expanded.jpg`。展开后 `pre.cw-master` 文本长度 889，与最新 handoff 的 `formatMasterMessage` 输出长度一致，首行 `handoff from thread session-…`。
4. **五状态夹具**：截图 `03-five-status-fixture.jpg`。chips 1/1/1/1/1；排序 待审查 → 受阻 → 进行中 → 新建 → 已完成（archived 不出现）；长主题行存在；验证行含 exit 1 红色 chip；变更文件 3 个 chip。
5. **错误态**：截图 `04-error-store-corrupt.jpg`。`项目记录已损坏` + 错误码 `store/corrupt` + `index.json` 绝对路径 + 重试。
6. **空态**：截图 `05-empty-not-initialized.jpg`。`这个仓库还没有 Cowork 项目` + `cowork_project_init` 引导 + 刷新。
7. **长列表**：截图 `06-long-list-46-threads.jpg`。46 条、chips 7/1/1/35/1、列表可滚动。
8. **真机抓到的缺陷与修复**：`GET /api/cowork.handoff` 曾挂死——`sessionController.inspect()` 读整个会话事件日志，对运行中/较大的会话不返回。改用 `sessionController.list()`（只读元数据）后 overview 0.3–0.9 s、handoff 即时返回（提交 `fix(panel): read the session cwd from the session listing`）。

## 未在真实宿主验证（如实）

- **≤480 钻取**：`chooseLayout` 有单测、真实分栏态已验；把面板压到 480 以下的真机操作被 BrowserSkill 的 strict-observation 闸门挡住（窗口 resize / 设备模拟 / 页内 eval 均返回 `observation changed`）。需要人工把右侧栏拖窄后确认一次。
- **light/dark**：token 对比度已按实际值用脚本算过（light 18.90 / 5.80 / 18.90，dark 17.45 / 12.11 / 17.45，正文/次要文字/主按钮均 ≥4.5:1），但主题切换未在真机点过。
- **guide entry 点击、打开 thread 会话、复制成功/失败反馈**：源码与单测覆盖，真机未点。
- **no-handoff 详情、长主题截断的视觉**：列表行已出现，详情未逐项截图。

## 限制与合并注意

- **同名换包不生效**：宿主 `client-modules` 按「loader name + baseUrl」缓存包元数据且不失效；同一进程内把 `@dsh-external/dsh-cowork` 从「无 client 声明」换成「有」不会成为 client row。真机验证使用临时改名包 `@dsh-external/dsh-cowork-panel`（loader id 同步改名）；交付物仍是原名，正常安装路径（`dsh plugin add` 后重启）不受影响。重审条件：宿主提供可失效的扫描。
- **M2 字段改名已同步**：合并 M2 后 wire 字段为 `checkoutPath`，`src/api-contract.ts` 与 host/client 两处映射一致；M2 store 会把旧索引里的 `worktreePath` 归一化，面板不保留跨分支垫片。
- 只读：API 与面板都不写任何项目文件；数据通道为 connection Exact Fetch（提案原「仅 loopback」表述已按实际改为 Host/Origin 围栏 + 浏览器 cookie）。
- HMR：无 `pnpm run dev:web` 时，client 改动要重建并刷新页面。

## 回滚

- 代码：按提交 revert（`git log --oneline feat/cowork-panel`）。
- 运行时：`dev_uninject_plugin dsh-cowork` 移除注入；`.dsh-cowork/` 是项目数据，保留（含本目录的 E2E 截图）。
