# Documentation index

What the documents are, and what each one answers. This page only routes: the rules and the facts live in the homes it links to, and nothing is restated here.

| Your question | Where to go |
|---|---|
| 这个插件是什么，装什么，怎么构建 | [README.md](../README.md) |
| 产品范围、架构、里程碑、验收 | [PLAN.md](PLAN.md) |
| 文档怎么写、放哪里、预算、发布 | [documentation.md](documentation.md) |
| 这个词在这个仓库里是什么意思 | [glossary.md](glossary.md) |
| 怎么向没读过术语表的人解释 | [plain-language.md](plain-language.md) |
| 怎样才算“验证过” | [testing.md](testing.md) |
| M0 五项 API 风险证明了什么、原始证据在哪 | [M0_PROBE_RESULT.md](M0_PROBE_RESULT.md) |
| M1 从哪开始、先验证什么、怎样算完成 | [M1_HANDOFF.md](M1_HANDOFF.md) |
| M1 S0 探针证明了什么（preset 组合、调用者身份） | [M1_S0_RESULT.md](M1_S0_RESULT.md) |
| M1 交付了什么、A1–A8 的原始证据与限制在哪 | [M1_RESULT.md](M1_RESULT.md) |
| 工程规则与命令 | [AGENTS.md](../AGENTS.md) |
| M2-P0 证明了什么：会话绑定、记忆注入、worktree/EPERM、clone 方案 | [M2_PROBE_RESULT.md](M2_PROBE_RESULT.md) |
| M2 交付了什么、M2A1–M2A8 的原始证据与限制在哪 | [M2_RESULT.md](M2_RESULT.md) |
| M2 后来的人从哪接手、已决问题与陷阱 | [M2_HANDOFF.md](M2_HANDOFF.md) |
| Cowork 面板能挂在右侧栏的哪个 slot、多宽、用哪些 token | [PANEL_RECON.md](PANEL_RECON.md) |
| Cowork 右侧栏面板怎么实现、先验证什么 | [PANEL_HANDOFF.md](PANEL_HANDOFF.md) |
| 哪个文件可以发布 | [publish.json](publish.json) |
| 决策记录怎么写、为什么写 | [.agents/notes/README.md](../.agents/notes/README.md) |
| 一个改动欠哪些证据 | [tools/workflow.json](../tools/workflow.json) |

## Every home, and what it owns

| Home | Kind | It owns |
|---|---|---|
| `README.md` | guide | 插件是什么、怎么装、怎么检查 |
| `AGENTS.md` | standing rules | 常驻工程规则与命令入口 |
| `docs/PLAN.md` | plan | 产品范围、架构、里程碑 |
| `docs/testing.md` | guide | 测试分层、证据、flake 政策 |
| `docs/documentation.md` | guide | 文档种类、单一事实源、发布开关 |
| `docs/glossary.md` | reference | 术语含义与拼写 |
| `docs/plain-language.md` | reference | 面向人的说法替换 |
| `docs/M1_HANDOFF.md` | guide | M1 实施入口：读什么、先验证什么、完成定义 |
| `docs/M1_RESULT.md` | record | M1 交付面、A1–A8 证据、限制与回滚 |
| `docs/M2_PROBE_RESULT.md` | record | M2-P0 环境事实、原始输出与 F 方案依据 |
| `docs/M2_RESULT.md` | record | M2 交付面、M2A1–M2A8 证据、限制与回滚 |
| `docs/M2_HANDOFF.md` | guide | M2 交接：已决问题、陷阱、验证与回滚 |
| `docs/PANEL_RECON.md` | record | 面板落点、宽度、主题 token、打包与热更新事实 |
| `docs/PANEL_HANDOFF.md` | guide | 面板实施入口：客户端探针、API 契约、验收 |
| `docs/publish.json` | switch | 唯一发布开关 |
| `tools/workflow.json` | machinery | surface 与证据命令 |
| `.agents/notes/` | records | 决策记录与模板 |
