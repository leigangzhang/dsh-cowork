# Documentation index

What the documents are, and what each one answers. This page only routes: the rules and the facts live in the homes it links to, and nothing is restated here.

| Your question | Where to go |
|---|---|
| 这个插件是什么，装什么，怎么构建 | [README.md](../README.md) |
| 产品范围、架构、里程碑、验收（V0.1，M0–M4） | [PLAN.md](PLAN.md) |
| 主题会话模型重构的阶段计划（V0.2，M6–M12） | [PLAN-V0.2.md](PLAN-V0.2.md) |
| 7 项 M6 宿主探针的结论、证据与限制 | [M6_PROBE_RESULT.md](M6_PROBE_RESULT.md) |
| M6 交付了什么、怎么回滚、M7 前置 | [M6_HANDOFF.md](M6_HANDOFF.md) |
| M7 交付了什么、M8 怎么启动与收口 | [M8_HANDOFF.md](M8_HANDOFF.md) |
| 文档怎么写、放哪里、预算、发布 | [documentation.md](documentation.md) |
| 这个词在这个仓库里是什么意思 | [glossary.md](glossary.md) |
| 怎么向没读过术语表的人解释 | [plain-language.md](plain-language.md) |
| 怎样才算“验证过” | [testing.md](testing.md) |
| M0–M4 已完成阶段的探针、结果与交接文档 | [archived/README.md](archived/README.md) |
| 哪些问题明确不修、什么时候重估 | [KNOWN_ISSUES.md](KNOWN_ISSUES.md) |
| 工程规则与命令 | [AGENTS.md](../AGENTS.md) |
| 哪个文件可以发布 | [publish.json](publish.json) |
| 决策记录怎么写、为什么写 | [.agents/notes/README.md](../.agents/notes/README.md) |
| 一个改动欠哪些证据 | [tools/workflow.json](../tools/workflow.json) |
| 一个需求怎么被路由、新建 thread、经 review 合并 | [routing.md](routing.md) |
| master 与 thread 怎么共享项目上下文、记忆何时注入、handoff 如何上下行 | [context.md](context.md) |

## Every home, and what it owns

| Home | Kind | It owns |
|---|---|---|
| `README.md` | guide | 插件是什么、怎么装、怎么检查 |
| `AGENTS.md` | standing rules | 常驻工程规则与命令入口 |
| `docs/PLAN.md` | plan | V0.1 产品范围、架构、M0–M4 完成记录 |
| `docs/PLAN-V0.2.md` | plan | V0.2 主题会话模型重构：M6–M12 阶段、架构与验收 |
| `docs/M6_PROBE_RESULT.md` | reference | 7 项 M6 宿主探针的结论、证据与限制 |
| `docs/M6_HANDOFF.md` | handoff | M6 交付物、可见性决策、验证、回滚与 M7 前置 |
| `docs/M8_HANDOFF.md` | handoff | M7 交付后的基线、M8 启动顺序、实施顺序、证据、回滚与未验证清单 |
| `docs/testing.md` | guide | 测试分层、证据、flake 政策 |
| `docs/documentation.md` | guide | 文档种类、单一事实源、发布开关 |
| `docs/routing.md` | guide | 路由判定、新建 thread、review 与合并的三张时序图 |
| `docs/context.md` | guide | 共享磁盘面、记忆注入、handoff 上下行与四类会话隔离矩阵 |
| `docs/glossary.md` | reference | 术语含义与拼写 |
| `docs/plain-language.md` | reference | 面向人的说法替换 |
| `docs/KNOWN_ISSUES.md` | reference | 遗留问题的唯一清单：状态、归属与重估触发条件 |
| `docs/archived/README.md` | index | M0–M4 已完成开发记录与交接文档的归档入口 |
| `docs/publish.json` | switch | 唯一发布开关 |
| `tools/workflow.json` | machinery | surface 与证据命令 |
| `.agents/notes/` | records | 决策记录与模板 |
