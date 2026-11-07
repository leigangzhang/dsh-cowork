# @dsh-external/dsh-cowork

DSH 的项目式主从协作插件：一个 profile 里同时提供 master 主会话、可直接对话的 thread 会话、项目记忆、thread 本地 clone 隔离、handoff 与独立 review。本文件是安装与使用手册；范围、架构与里程碑见 [docs/PLAN.md](docs/PLAN.md)。

## 它是什么

单会话长跑容易失焦、上下文退化、输出漂移。`dsh-cowork` 把项目工作拆成三种会话：

- **master**：路由需求、记录决策、验收与合并，不写实现细节；
- **thread**：一个 subject 一个会话，自己做实现、自己跑检查，用 handoff 交回结果；
- **reviewer**：独立复核 thread 的产物与证据，实现者不自审。

项目数据落在目标仓库里的 `<repo>/.dsh-cowork/`，一个项目一份，插件不往 `~/.dsh` 写项目状态。

## 三个 preset

| preset | 由谁创建 | 职责 |
|---|---|---|
| `cowork-master` | 用户新建会话时选择 | 初始化项目、路由需求、验收、请求 review、合并 thread |
| `cowork-thread` | master 用 `cowork_thread_create` 创建 | 在自己的 clone 里做一件具体的事，结束时 `cowork_handoff` |
| `cowork-reviewer` | master 用 `cowork_review_request` 创建 | 独立读证据、复跑命令、写 `cowork_review_verdict` |

reviewer 的只读性首先来自工具面：这个 preset 不挂 `tool-fs`，所以它没有 read/write/edit 文件工具，读代码只能靠 bash 与搜索工具；protocol 再约束它不改文件、不提交。注意这只是工具面收窄，不是沙箱，见「限制与前提」。

## 安装

前提：

- Node.js >= 22.19（`package.json` 的 `engines`）；
- 本机已安装 DSH app（运行时链接指向它）；
- 本机有一份装好依赖的 DSH 源码 checkout（构建要借它的 `tsc` 与 esbuild）。

`scripts/build.sh` 会自动探测 `~/Workspace/deepseek-harness` 等常见位置，并用已安装的 DSH app 取运行时；非默认布局时用 `DSH_CHECKOUT` / `DSH_APP_NODE_MODULES` 指定。构建不需要先在本仓库执行 `npm install`。

```bash
npm run build
npm pack
```

`npm run build` 编译 host 半边到 `lib/`，并把浏览器半边打包成 `lib/client.js`；`npm pack` 产出 `dsh-external-dsh-cowork-0.1.0.tgz`，只含 `lib/`、`cordis.patch.yml`、`README.md`、`LICENSE` 与 `package.json`。

然后建一个**专用 profile**，把 tarball 装进去（示例 profile 名 `m4probe`，换成你自己的名字）：

```bash
dsh --profile m4probe --from-default-profile web --dump-config
dsh plugin --profile m4probe add ./dsh-external-dsh-cowork-0.1.0.tgz
dsh --profile m4probe --dump-config | grep -A2 '@dsh-external/dsh-cowork'
```

第一条用出厂 `web` 模板创建空 profile 并直接退出（去掉 `--dump-config` 就会顺便启动）；第二条把包写进该 profile 的依赖与 bundles；第三条应看到 `# == @dsh-external/dsh-cowork` 以及 `- id: dsh-cowork` / `name: '@dsh-external/dsh-cowork'`，说明 bundle 层已经就位。

最后用**独立端口**启动这个 profile，重启之后才会用上新装的包：

```bash
dsh --profile m4probe --port 3091 --no-open
```

浏览器打开 `http://127.0.0.1:3091`，新建会话时选 `cowork-master`。

安装注意事项：

- **不要把插件装进你正在用的 profile**（例如 `web`）：`dsh plugin add` 会改该 profile 的依赖与 bundles，必须重启才生效，出问题也不好回滚。新建专用 profile 最省事。
- `--from-default-profile` 会用出厂模板**覆盖同名 profile**，所以名字要挑一个还没在用的。
- 只承诺 tarball 安装。npm 包没有发布：本包 `private: true`，发布需要单独授权。也不要用 git 地址安装——git 装到的是源码仓库，里面没有预构建的 `lib/`，宿主加载不到入口。
- 安装或升级后必须**重启 profile 进程**；旧进程不会热加载新 bundle。
- 如果 `--dump-config` 里看不到 cowork 层，检查该 profile 的补丁里是否留了 `- id: dsh-cowork` 且 `disabled: true`；它会压住 bundle 写入的行，删掉后重装。

## 选择 preset

- 新建会话时选 `cowork-master`，由它开 thread 和 reviewer。
- 不要手动开 `cowork-thread` / `cowork-reviewer` 会话：它们要由 master 的工具创建并登记进项目索引，手动开的会话不在索引里，handoff 与 review 都接不上。
- 默认 preset 不变：没选 cowork preset 的会话行为与以前一致，本插件不影响它们。

## 使用流程

1. **初始化**：在 `cowork-master` 会话里，以目标仓库为 cwd 调用 `cowork_project_init`。它写 `.dsh-cowork/index.json`，把当前会话记为 master；幂等，换一个会话再调会被拒绝。
2. **路由或建 thread**：用户每提一个需求，master 用 `cowork_route({ intent })` 复用已有 thread 或新建；需要精确控制时用 `cowork_thread_create({ subject, brief })`。
3. **thread 里工作**：thread 只改自己 subject 范围内的文件，结束（完成或阻塞）时调用 `cowork_handoff({ status, summary, commandsRun, changedPaths })`。`status` 取 `awaiting_review` / `blocked` / `done`；没 handoff 的 thread 不算完成。
4. **请求 review**：master 对 `awaiting_review` 的 thread 调用 `cowork_review_request({ threadId })`，插件创建独立 reviewer 会话并把 thread 标成 pending。
5. **出结论**：reviewer 读 handoff、改动的文件并自己复跑验证命令，然后写一次 `cowork_review_verdict({ threadId, verdict, summary, findings })`；`needs_revision` / `reject` 必须给出可执行的 findings。
6. **合并**：只有 `verdict: pass` 才能让 master 调 `cowork_checkout_merge({ threadId })` 合并该 thread 的 clone。`needs_revision` 退回 thread 修复并重新 handoff、再次请求 review；`reject` 表示这个 thread 被阻塞。
7. **看板**：Web UI 右侧栏的 Cowork 面板读同一份索引（`/api/cowork.overview`），用来确认 thread 状态、待办 review 与最终 verdict。

## 数据落点

所有项目数据都在 `<repo>/.dsh-cowork/`：

| 路径 | 内容 |
|---|---|
| `index.json` | 项目 id、master 会话、thread 清单与状态、review 状态 |
| `handoffs/` | 每次 handoff 一份 `<threadId>-<stamp>.json` |
| `reviews/` | 每次 review 一份 `<threadId>-<stamp>.json`：verdict、findings、verification |
| `threads/` | 隔离 thread 的本地 clone（`cowork_thread_create` 的 `isolated`），分支 `cowork/<threadId>` |
| `memory/` | 项目记忆，由 `cowork_memory_write` 追加 |
| `e2e/` | 维护者跑端到端验证时的证据与临时仓库，日常使用不会产生 |

写入通过 `.dsh-cowork/.write.lock` 串行化，避免并发写坏索引。本仓库的 [.gitignore](.gitignore) 已忽略 `.dsh-cowork/`；在你自己的项目里也请把它加进 `.gitignore`——handoff、review 和 thread clone 都是运行数据，不该提交。

## 卸载与升级

```bash
dsh plugin --profile m4probe remove @dsh-external/dsh-cowork
```

- `.dsh-cowork/` 不随卸载删除，项目数据保留。
- **旧会话会在卸载后失效**：会话 header 里仍记着 `cowork-master` / `cowork-thread` / `cowork-reviewer`，而这些 preset 的定义随包一起消失，恢复这类会话会失败。卸载前把要保留的会话归档或导出，或先把 thread 的 handoff、review、合并走完。
- 新会话不受影响，只是不再有 cowork preset 可选。
- 升级 / 重装 = `remove` 之后 `add` 新的 tarball，再重启 profile。

## 限制与前提

- **dev 探针与 E2E 路由默认不启用**：`/dsh-cowork/probe/*`、`/dsh-cowork/e2e/*` 这些路由和两个探针工具是维护者选项，正常安装看不到，本手册不展开。
- **client 只支持 web**：`dsh.client.platform` 是 `web`，面板只挂在 Web UI 的右侧栏。
- **reviewer 的只读不是沙箱**：它没有文件读写工具，但 bash 仍然可以改文件（[KI-15](docs/KNOWN_ISSUES.md)）。只读性靠 preset 与 protocol，重要 review 仍应由人复核。
- **文件策略前提是 workspace-write**：thread 的 clone 写在 `<repo>/.dsh-cowork/threads/` 下，这个目录必须可写；把部署策略改成 read-only 时，clone 与提交会失败。
- **合并冲突不自动解决**：`cowork_checkout_merge` 遇到冲突会报错，需要人工或让 thread 处理后再合并。

## 仓库布局

```text
dsh-cowork/
├── package.json          # dsh.bundle.patch / dsh.client / files
├── cordis.patch.yml      # insert: dsh-cowork
├── src/
│   ├── index.ts          # 装配：service / tools / presets / routes
│   ├── presets.ts        # cowork-master / thread / reviewer 的 preset 定义
│   ├── session-slice.ts  # sessionController 薄封装
│   ├── store.ts          # .dsh-cowork 索引与 handoff/review 原子写
│   ├── router.ts         # 关键词打分 + 模型辅助路由
│   ├── handoff.ts        # handoff 校验与投递
│   ├── memory.ts         # 项目记忆（默认文件，可换适配器）
│   ├── memory-prompt.ts  # 记忆块注入 system prompt
│   ├── checkout.ts       # git clone 适配（thread 隔离）
│   ├── review.ts         # review 会话生命周期
│   ├── review-tools.ts   # cowork_review_request / cowork_review_verdict
│   ├── tools.ts          # 其余 cowork_* 工具
│   ├── api.ts            # loopback HTTP API（含 /api/cowork.overview）
│   ├── api-contract.ts   # 面板与 API 共享的契约
│   └── client/           # 右侧栏 Cowork 面板
├── tests/                # 模块与仓库契约测试
├── tools/                # workflow.json + check-invariants.mjs
├── docs/                 # 方案、交接、已知问题与文档规范
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
| 产品范围、架构、里程碑、验收 | [docs/PLAN.md](docs/PLAN.md) |
| M4 打包与发布的交接、验收与回滚 | [docs/M4_HANDOFF.md](docs/M4_HANDOFF.md) |
| 明确不修的问题与重估条件 | [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) |
| 怎样才算验证过、证据怎么留 | [docs/testing.md](docs/testing.md) |
| 文档种类、单一事实源、发布开关 | [docs/documentation.md](docs/documentation.md) |
| 全部文档索引 | [docs/README.md](docs/README.md) |
| 常驻工程规则 | [AGENTS.md](AGENTS.md) |
| 改一个文件欠哪些证据 | [tools/workflow.json](tools/workflow.json) |

## 许可

MIT，与 DeepSeek Harness 官方一致。
