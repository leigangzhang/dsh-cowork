# Documentation index

What the documents are, and what each one answers. This page only routes: the rules and the facts live in the homes it links to, and nothing is restated here.

| Your question | Where to go |
|---|---|
| 这个插件是什么，装什么，怎么构建 | [README.md](../README.md) |
| 产品范围、架构、里程碑、验收（V0.1，M0–M4） | [PLAN.md](PLAN.md) |
| 主题会话模型重构的阶段计划（V0.2，M6–M12） | [PLAN-V0.2.md](PLAN-V0.2.md) |
| 文档怎么写、放哪里、预算、发布 | [AGENTS.md](AGENTS.md)；执行步骤见 [write-docs](../.agents/skills/write-docs/SKILL.md) |
| 行文里哪些契约/覆盖要保留，哪些叙述该删 | [prose-standard](../.agents/skills/prose-standard/SKILL.md) |
| 怎么删掉行文里的 CoT/会话残留、变更叙述 | [trim-cot-leakage](../.agents/skills/trim-cot-leakage/SKILL.md) |
| 怎么审查改动、准备 PR、判断 review finding 是否修好 | [dsh-cowork-review](../.agents/skills/dsh-cowork-review/SKILL.md) |
| 这个词在这个仓库里是什么意思 | [glossary.md](glossary.md) |
| 怎么向没读过术语表的人解释 | [plain-language.md](plain-language.md) |
| 怎样才算“验证过” | [testing.md](testing.md) |
| 各阶段的 handoff、result 与 recon 记录 | [handoff/README.md](handoff/README.md) |
| 哪些问题明确不修、什么时候重估 | [KNOWN_ISSUES.md](KNOWN_ISSUES.md) |
| 工程规则与命令 | [AGENTS.md](../AGENTS.md) |
| 哪个文件可以发布 | [publish.json](publish.json) |
| 决策记录怎么写、为什么写 | [.agents/notes/README.md](../.agents/notes/README.md) |
| 一个改动欠哪些证据 | [tools/workflow.json](../tools/workflow.json) |
| 一个需求怎么被路由、新建 topic、经评审与工作项合并 | [routing.md](routing.md) |
| AgentTeams 的 DAG、门禁、worktree 与交付规则 | [agent-teams.md](agent-teams.md) |
| 按功能划分的设计文档、前后端方案与模板资产 | [design/README.md](design/README.md) |
| 主题怎么记录决策、怎么把结果交接给 master | [decision-and-handoff.md](decision-and-handoff.md) |
| master 与 topic 怎么共享项目上下文、记忆何时注入、handoff/通知账本如何上下行 | [context.md](context.md) |

## Every home, and what it owns

| Home | Kind | It owns |
|---|---|---|
| `README.md` | guide | 插件是什么、怎么装、怎么检查 |
| `AGENTS.md` | standing rules | 常驻工程规则与命令入口 |
| `docs/PLAN.md` | plan | V0.1 产品范围、架构、M0–M4 完成记录 |
| `docs/PLAN-V0.2.md` | plan | V0.2 主题会话模型重构：M6–M12 阶段、架构与验收 |
| `docs/testing.md` | guide | 测试分层、证据、flake 政策 |
| `docs/AGENTS.md` | guide | 文档种类、命名、目录架构、单一事实源、预算、发布开关与防劣质清单 |
| `docs/agent-teams.md` | guide | 项目级 AgentTeams DAG、影响扫描、门禁、worktree、审查与交付规则 |
| `.agents/skills/` | skill | 按 `description` 触发的文档撰写与行文清理流程 |
| `docs/routing.md` | guide | 三层路由、topic/工作项/评审请求的生命周期、改投与合并 |
| `docs/decision-and-handoff.md` | guide | 决策记录与会话交接的实现与用法 |
| `docs/context.md` | guide | 共享磁盘面、记忆注入、handoff/通知账本上下行与四类会话隔离矩阵 |
| `docs/glossary.md` | reference | 术语含义与拼写 |
| `docs/plain-language.md` | reference | 面向人的说法替换 |
| `docs/KNOWN_ISSUES.md` | reference | 遗留问题的唯一清单：状态、归属与重估触发条件 |
| `docs/handoff/README.md` | index | 所有 handoff、result、recon 记录的入口 |
| `docs/design/README.md` | index | 按功能划分的设计文档与当前模板资产入口 |
| `docs/design/<feature>/` | records | 当前设计文档及其直接引用的模板资产 |
| `docs/publish.json` | switch | 唯一发布开关 |
| `docs/kinds.json` | switch | 每个 Markdown 的唯一 kind 与 skeleton 检查映射 |
| `tools/workflow.json` | machinery | surface、check 配置与证据命令 |
| `.agents/notes/` | records | 决策记录与模板 |
