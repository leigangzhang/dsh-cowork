# Decision: 文档管理与撰写标准按参考仓库还原

Status: implemented
Date: 2026-11-13
Class: process

## Problem

`docs/AGENTS.md` 已经吸收 agent-workflow-kit 的文档治理骨架，但被裁成最小版：缺少 skill 这一 kind、四段式技能契约、命名规则、目录架构、完整的 link/mirror/generate 三分法、预算细节、防劣质清单的完整边界。仓库也没有自己的 `write-docs`、`prose-standard` 与 `trim-cot-leakage` skill，下一次写文档只能凭规则正文重新推导步骤；规则与操作之间没有任何可执行检查。

`docs/` 的物理结构与语义类型也不一致：当前实现交接散在根目录，`docs/archived/` 把实施交接、交付/探针结果和侦察记录平铺在一起；`prose-standard` 还带着 vendor、Cordis、postmortem、cookbook、双语与生成物等本仓库不使用的通用规则。

## Decision

- [docs/AGENTS.md](../../../../docs/AGENTS.md) 是文档规则的唯一 home：kind、命名、one-home-per-fact、tutorial/reference 二分、link/mirror/generate、预算、发布开关、防劣质清单与已知边界都在这里。结构按参考仓库还原，路径、命令和“暂无生成页/镜像登记表”的项目事实就地改写。
- `.agents/skills/write-docs/SKILL.md` 管写作与评审步骤，`.agents/skills/prose-standard/SKILL.md` 管完整命题、按位置所需的正文覆盖和边界判断，`.agents/skills/trim-cot-leakage/SKILL.md` 管 CoT/会话残留、变更叙述和推理过程泄漏；三个 skill 都保留 `## When to use`、`## How`、`## Verification`、`## Anti-patterns`，`description` 是加载条件而不是摘要。
- `prose-standard` 从本地 `deepseek-harness/.agents/skills/dsh-prose-standard` 迁移：保留编辑判断、完整命题、按位置覆盖、workflow、borderline decisions 和 `references/examples.md` 中适用于本项目的示例；把悬空指针换成本项目的 `write-docs`、`trim-cot-leakage`、[docs/AGENTS.md](../../../../docs/AGENTS.md) 与实际检查，并删除 vendor、Cordis、postmortem、cookbook、双语、生成物和 archived-notes 等本仓库不使用的通用规则。
- [docs/AGENTS.md](../../../../docs/AGENTS.md) 增加 `## Directory layout`：`docs/` 根只放索引、通用规则、项目级计划/指南/参考和独立文件；同语义记录进入 `docs/design/<feature>/`、`docs/handoffs/` 和 `docs/archived/{handoffs,results,recon}/`，不按 `guide/reference/plan` 这种 kind 拆目录。
- 当前交接移动到 `docs/handoffs/`，历史交接/结果/侦察移动到 `docs/archived/handoffs|results|recon/`；所有 tracked Markdown、JSON、源码注释和测试中的路径引用同步重写，`docs/publish.json` 改为按 `docs/handoffs/*` 分类。
- `docs/README.md` 和 `AGENTS.md` 只增加指针，不复制规则。`.agents/skills/` 作为 agent 输入在 [docs/publish.json](../../../../docs/publish.json) 中统一登记为 `internal`。
- [tools/workflow.json](../../../../tools/workflow.json) 增加 `agent-skills` surface；`npm run check` 校验 skill 的 front matter、触发词、四段式正文和相对链接，`docs-layout` 拒绝根目录散落的 handoff/result/recon 或归档根目录散落的记录，负例由 `npm run check:self-test` 证明会变红。
- 存量文档不重写正文；新文档、被重构的文档、skill 与本次移动后的路径从本决策起受同一门禁约束。生成页与镜像仍不启用，首次引入时必须同时带来生成器/登记表和对应 `--check`。

## Alternatives considered

**逐字复制参考仓库。** 否决：参考稿链接 `dev/README.md`、`dev/contracts/mirrors.json`、双语 sidecar 和 Python 检查脚本，这些在当前仓库不存在；照抄会把新标准变成一组坏链接，并让读者误以为生成、镜像和双语机制已经可用。

**整份翻译成中文。** 否决：现有政策文档与 agent 输入以英文为主，skill 也按参考仓库保持英文；只翻译标准会制造两套词汇并打断 `AGENTS.md` 的指针链。中文继续用于面向用户的文档和汇报。

**只写规则，不加 skill 和检查。** 否决：这会把“文档怎么写”留在需要重新解释的正文里；没有 `description` 与四段式，host 无法按触发条件加载写作流程，规则也无法在提交前变红。

**保留 `trim-prose` 作为泄漏清理 skill 的名称。** 否决：`prose-standard` 覆盖一般行文判断，`trim-prose` 的 “trim” 会被误读为所有正文都该缩短；`trim-cot-leakage` 精确指向 CoT/推理残留，不再和完整的行文标准混名。

**让 `docs/archived/` 继续平铺。** 否决：交接、结果与侦察记录混在同一目录，新记录会继续按“先到先放”而不是按语义族归位；目录本身就无法回答一个文件属于哪类记录。

**按 guide/reference/plan 等 document kind 建目录。** 否决：kind 由读者和问题机械决定，同一语义族可能跨 kind；按 kind 拆会把项目规则、计划与记录切碎，且与“通用规则、项目文档和独立文件留在 docs/ 根”的要求冲突。

**保留 `prose-standard` 中所有源技能规则。** 否决：vendor、Cordis、postmortem、cookbook、双语和生成物规则在本仓库没有对应对象，保留会制造无法执行的义务，并让 agent 在错误的前提上判断。

**顺手重写全部存量文档。** 否决：用户要求整理目录与规则，不是改写历史内容；全量重写会制造无关 diff，并破坏已发布页面的证据语义。

## Consequences

- 新 Markdown 必须命中 `docs/publish.json` 恰好一次，新 skill 必须通过 front matter、触发词、四段式和链接检查。
- 写作流程成为三个可加载的 agent 输入；`prose-standard` 保留完整源技能与示例，`trim-cot-leakage` 只处理推理/会话泄漏。`npm run check` 只证明结构、命名和触发词，不证明 host 在具体任务中真的加载了它；内容质量仍由 review 判定。
- 当前没有生成页、镜像登记表或双语配对，标准只写接入条件，不假装这些机制已经存在。
- 存量文档正文保持原状；它们的 kind 由内容决定，目录位置按语义族迁移。
- 移动后的旧外部链接不再解析到旧路径；仓库内 tracked 引用已同步到新路径。

## Testing

- [A1] 新标准包含 kind、目录架构、one-home、tutorial/reference、link/mirror/generate、预算、发布、防劣质清单和已知边界，并由 `docs-policy` 检查 section 形状 — `plan-docs`
- [A2] 三个 skill 的 `description` 以加载条件开头，四段式非空，相对链接可解析，且 `trim-prose` 目录不再存在 — `agent-skills`
- [A3] `.agents/skills/` 的每个 Markdown 文件（含 `prose-standard/references/examples.md`）在发布清单中恰好分类一次并为 `internal` — `publication`
- [A4] `npm run check` 对缺 section 和摘要式 description 的合成 skill 会变红，证明规则有负例 — `workflow`
- [A5] `prose-standard` 保留完整命题、按位置覆盖、workflow、borderline decisions 和适用示例，且不含 vendor、Cordis、postmortem、cookbook、双语或生成物规则 — `agent-skills`
- [A6] `docs/` 根只保留通用规则、项目文档与独立文件；当前交接在 `docs/handoffs/`，历史交接/结果/侦察在 `docs/archived/{handoffs,results,recon}/`，并由 `docs-layout` 负例证明会变红 — `plan-docs`
- [A7] 移动文件后的所有 tracked Markdown 相对链接可解析，发布清单仍对每个文件恰好分类一次 — `publication`
