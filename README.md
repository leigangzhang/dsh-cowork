# @dsh-external/dsh-cowork

DSH 项目式主从协作插件：在一个 profile 内提供「master 主会话 + 可直接对话的 thread 会话 + 项目记忆 + worktree 隔离 + 路由 + handoff + review」的 Cloud Cowork 式协作模式。

## 它解决什么

单会话长跑容易失焦、上下文退化、输出漂移。`dsh-cowork` 把项目拆成一个轻量 master 和多个持久 thread：

- **master**：路由用户需求、记录决策、验收交付，不承载实现细节；
- **thread**：每个 Future/特性一个普通 DSH 会话，用户可以直接打开、继续对话；
- **project memory**：项目级记忆，物理隔离在 `<repo>/.dsh-cowork/`，不全局串；
- **handoff**：thread 完成/阻塞后写结构化交接单，并唤醒 master；
- **worktree**：每个写代码的 thread 可落到独立 git worktree，master 独占合并；
- **review**：独立 review 会话复核产物与证据，实现者不自审。

## 架构

```
dsh-cowork/
├── package.json            # dsh.bundle.patch + dsh.client + engines
├── cordis.patch.yml        # insert: dsh-cowork
├── presets/                # cowork-master / cowork-thread
├── src/
│   ├── index.ts            # 装配：注册 service/tools/presets/routes
│   ├── session-slice.ts    # sessionController 薄封装
│   ├── store.ts            # .dsh-cowork 索引/handoff 原子读写
│   ├── router.ts           # 关键词打分 + 模型辅助路由
│   ├── handoff.ts          # 结构化 handoff 与投递
│   ├── memory.ts           # 项目记忆（默认文件，可换适配器）
│   ├── worktree.ts         # git CLI worktree 适配器
│   ├── review.ts           # review 会话生命周期
│   ├── tools.ts            # cowork_* 工具
│   ├── routes.ts           # loopback HTTP API
│   └── client.ts           # 客户端项目面板
├── test/                   # store / router / handoff 单元与契约测试
├── tools/                  # 可执行约定（workflow.json + check-invariants.mjs）
├── docs/                   # 产品方案与文档规范
└── .agents/notes/          # 决策记录
```

数据落在 `<repo>/.dsh-cowork/`（默认 gitignore），核心状态不写入 `~/.dsh`。

## 仓库布局

| 路径 | 作用 |
|---|---|
| `docs/PLAN.md` | 产品与实现方案：范围、里程碑、验收 |
| `docs/README.md` | 文档索引 |
| `docs/documentation.md` | 文档种类、单一事实源、发布开关 |
| `docs/glossary.md` | 项目术语与拼写 |
| `docs/plain-language.md` | 面向人的说法替换表 |
| `docs/testing.md` | 测试策略与证据 |
| `AGENTS.md` | 常驻工程规则 |
| `tools/workflow.json` | surface 与证据映射 |
| `.agents/notes/` | 决策记录模板与流程 |

## 本地检查

```bash
npm run check              # 可执行约定（AGENTS 预算 / workflow.json / 模板 / 发布清单）
npm run check:self-test    # 证明守卫能变红
npm test                   # 仓库自身契约测试
npm run typecheck          # TypeScript 检查（依赖安装后）
npm run build              # host 构建（类型取自 DSH 源码 checkout，运行时链接已安装 app，无需设置 DSH_CHECKOUT）
```

`npm run build` 现在可直接运行（M0 已完成）：类型来自 DSH 源码 checkout、运行时链接已安装 app，脚本自动探测；client 半边在 M0 移除、M3 恢复。

## 安装

```bash
# 构建后：
dsh plugin --profile web add /Users/ray/Workspace/dsh-cowork
# 重启 dsh web，新建会话选择 cowork-master 或 cowork-thread
```

发布后将以 npm 包安装：`dsh plugin --profile web add @dsh-external/dsh-cowork`。

## 文档与许可

- 文档规范见 [docs/documentation.md](docs/documentation.md)；文档索引见 [docs/README.md](docs/README.md)。
- 许可：MIT，与 DeepSeek Harness 官方一致。
