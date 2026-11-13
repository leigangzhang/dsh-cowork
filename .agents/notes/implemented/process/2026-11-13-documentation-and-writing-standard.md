# Decision: 文档管理与撰写标准按参考仓库还原

Status: implemented
Date: 2026-11-13
Class: process

## Problem

`docs/documentation.md` 已经吸收 agent-workflow-kit 的文档治理骨架，但被裁成最小版：缺少 skill 这一 kind、四段式技能契约、命名规则、完整的 link/mirror/generate 三分法、预算细节、防劣质清单的完整边界。仓库也没有自己的 `write-docs` 与 `trim-prose` skill，下一次写文档只能凭规则正文重新推导步骤；规则与操作之间没有任何可执行检查。

## Decision

- [docs/documentation.md](../../../../docs/documentation.md) 是文档规则的唯一 home：kind、命名、one-home-per-fact、tutorial/reference 二分、link/mirror/generate、预算、发布开关、防劣质清单与已知边界都在这里。结构按参考仓库还原，路径、命令和“暂无生成页/镜像登记表”的项目事实就地改写。
- `.agents/skills/write-docs/SKILL.md` 管写作与评审步骤，`.agents/skills/trim-prose/SKILL.md` 管会话残留、变更叙述和推理过程泄漏；两个 skill 都保留 `## When to use`、`## How`、`## Verification`、`## Anti-patterns`，`description` 是加载条件而不是摘要。
- `docs/README.md` 和 `AGENTS.md` 只增加指针，不复制规则。`.agents/skills/` 作为 agent 输入在 [docs/publish.json](../../../../docs/publish.json) 中统一登记为 `internal`。
- [tools/workflow.json](../../../../tools/workflow.json) 增加 `agent-skills` surface；`npm run check` 校验 skill 的 front matter、触发词、四段式正文和相对链接，负例由 `npm run check:self-test` 证明会变红。
- 存量文档不按新标准重写；新文档、被重构的文档和 skill 从本决策起受同一门禁约束。生成页与镜像仍不启用，首次引入时必须同时带来生成器/登记表和对应 `--check`。

## Alternatives considered

**逐字复制参考仓库。** 否决：参考稿链接 `dev/README.md`、`dev/contracts/mirrors.json`、双语 sidecar 和 Python 检查脚本，这些在当前仓库不存在；照抄会把新标准变成一组坏链接，并让读者误以为生成、镜像和双语机制已经可用。

**整份翻译成中文。** 否决：现有政策文档与 agent 输入以英文为主，skill 也按参考仓库保持英文；只翻译标准会制造两套词汇并打断 `AGENTS.md` 的指针链。中文继续用于面向用户的文档和汇报。

**只写规则，不加 skill 和检查。** 否决：这会把“文档怎么写”留在需要重新解释的正文里；没有 `description` 与四段式，host 无法按触发条件加载写作流程，规则也无法在提交前变红。

**顺手重写全部存量文档。** 否决：用户要求面向未来的新文档，存量归档、交接和设计记录已有历史语义；全量重写会制造无关 diff，并破坏已发布页面的链接与证据。

## Consequences

- 新 Markdown 必须命中 `docs/publish.json` 恰好一次，新 skill 必须通过 front matter、触发词、四段式和链接检查。
- 写作流程成为可加载的 agent 输入，但 `npm run check` 只证明结构和触发词，不证明 host 在具体任务中真的加载了它；内容质量仍由 review 判定。
- 当前没有生成页、镜像登记表或双语配对，标准只写接入条件，不假装这些机制已经存在。
- 存量文档保持原状；它们的 kind 由目录与内容现状指定，不因本决策被批量迁移。

## Testing

- [A1] 新标准包含 kind、one-home、tutorial/reference、link/mirror/generate、预算、发布、防劣质清单和已知边界，并由 `docs-policy` 检查 section 形状 — `plan-docs`
- [A2] 两个 skill 的 `description` 以加载条件开头，四段式非空，相对链接可解析 — `agent-skills`
- [A3] `.agents/skills/` 的每个 Markdown 文件在发布清单中恰好分类一次并为 `internal` — `publication`
- [A4] `npm run check` 对缺 section 和摘要式 description 的合成 skill 会变红，证明规则有负例 — `workflow`
