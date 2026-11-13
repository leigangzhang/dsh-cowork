# Decision: 文档管理与撰写标准按参考仓库还原

Status: implemented
Date: 2026-11-13
Class: process

## Problem

`docs/AGENTS.md` 已经吸收 agent-workflow-kit 的文档治理骨架，但被裁成最小版：缺少 skill 这一 kind、四段式技能契约、命名规则、目录架构、完整的 link/mirror/generate 三分法、预算细节、防劣质清单的完整边界。仓库也没有自己的 `write-docs`、`prose-standard` 与 `trim-cot-leakage` skill，下一次写文档只能凭规则正文重新推导步骤；规则与操作之间没有任何可执行检查。

`docs/` 的物理结构与语义类型也不一致：当前实现交接散在根目录，`docs/handoff/` 把实施交接、交付/探针结果和侦察记录平铺在一起；`prose-standard` 还带着 vendor、Cordis、postmortem、cookbook、双语与生成物等本仓库不使用的通用规则。

文档检查此前硬编码在 `check-invariants.mjs`：加一条规则要改代码，空语料不单独报错，自测只覆盖部分谓词而非每个 check kind 的正反 fixture。参考项目的 `checks[] + runner + empty-corpus + per-kind self-test` 逻辑没有完整落地。全量 Markdown 链接、public/根文档的索引可达性、机器可读的 kind/skeleton 映射，以及统一的文件大小上限也都没有硬闸门。

## Decision

- [docs/AGENTS.md](../../../../docs/AGENTS.md) 是文档规则的唯一 home：kind、命名、one-home-per-fact、tutorial/reference 二分、link/mirror/generate、预算、发布开关、防劣质清单与已知边界都在这里。结构按参考仓库还原，路径、命令和“暂无生成页/镜像登记表”的项目事实就地改写。
- `.agents/skills/write-docs/SKILL.md` 管写作与评审步骤，`.agents/skills/prose-standard/SKILL.md` 管完整命题、按位置所需的正文覆盖和边界判断，`.agents/skills/trim-cot-leakage/SKILL.md` 管 CoT/会话残留、变更叙述和推理过程泄漏；三个 skill 都保留 `## When to use`、`## How`、`## Verification`、`## Anti-patterns`，`description` 是加载条件而不是摘要。
- `prose-standard` 从本地 `deepseek-harness/.agents/skills/dsh-prose-standard` 迁移：保留编辑判断、完整命题、按位置覆盖、workflow、borderline decisions 和 `references/examples.md` 中适用于本项目的示例；把悬空指针换成本项目的 `write-docs`、`trim-cot-leakage`、[docs/AGENTS.md](../../../../docs/AGENTS.md) 与实际检查，并删除 vendor、Cordis、postmortem、cookbook、双语、生成物和 archived-notes 等本仓库不使用的通用规则。
- [docs/AGENTS.md](../../../../docs/AGENTS.md) 增加 `## Directory layout`：`docs/` 根只放索引、通用规则、项目级计划/指南/参考和独立文件；同语义记录进入 `docs/design/<feature>/` 和 `docs/handoff/`，不按 `guide/reference/plan` 这种 kind 拆目录。
- `docs/handoff/` 平铺 handoff、result 与 recon 记录；设计目录按功能分组，只保留当前设计文档及其引用的模板资产。所有 tracked Markdown、JSON、源码注释和测试中的路径引用同步重写，`docs/publish.json` 改为按 `docs/handoff/*` 和 `docs/design/*` 分类。
- `docs/README.md` 和 `AGENTS.md` 只增加指针，不复制规则。`.agents/skills/` 作为 agent 输入在 [docs/publish.json](../../../../docs/publish.json) 中统一登记为 `internal`。
- [tools/workflow.json](../../../../tools/workflow.json) 的 `checks[]` 承载文档规则，[tools/doc-gate-engine.mjs](../../../../tools/doc-gate-engine.mjs) 为每个 kind 提供一个 runner：`budget`、`required-sections`、`forbidden-regex`、`link-target`、`publish-manifest`、`skill-trigger`、`docs-layout`、`design-assets`、`index-reachable`、`kind-manifest`。`tools/check-invariants.mjs` 只保留 notes 生命周期、指针和 skill 目录完整性等项目规则。
- `markdown-links` 对全部 tracked Markdown 做本地相对链接检查；`doc-index-reachability` 要求所有 public 文档和 `docs/` 根文档可从 [docs/README.md](../../../../docs/README.md) 到达；`markdown-size` 以 50 KiB 为全仓库 Markdown 安全上限。
- [docs/kinds.json](../../../../docs/kinds.json) 把每个 Markdown 映射到唯一 kind；`skeletonCheck` 只能指向已声明的 `required-sections` check。`kind-manifest` 拒绝未分类、重复分类、未知 kind、空 assignment 和悬空 skeleton 映射。
- 引擎拒绝零匹配的 check，`npm run check:self-test` 用临时 fixture 证明每个 kind 的 invalid 输入变红、valid 输入变绿，并额外覆盖 empty corpus、word/byte budget 和 publish 的四种失败方向；`--list` 与 `--changed BASE [--worktree-only]` 提供按改动面选择 check 的迭代模式。
- [tools/workflow.json](../../../../tools/workflow.json) 增加 `agent-skills` surface；`npm run check` 校验 skill 的 front matter、触发词、四段式正文和相对链接，`docs-layout` 拒绝根目录散落的 handoff/result/recon 或归档根目录散落的记录，负例由 `npm run check:self-test` 证明会变红。
- 存量文档不重写正文；新文档、被重构的文档、skill 与本次移动后的路径从本决策起受同一门禁约束。生成页与镜像仍不启用，首次引入时必须同时带来生成器/登记表和对应 `--check`。

## Alternatives considered

**逐字复制参考仓库。** 否决：参考稿链接 `dev/README.md`、`dev/contracts/mirrors.json`、双语 sidecar 和 Python 检查脚本，这些在当前仓库不存在；照抄会把新标准变成一组坏链接，并让读者误以为生成、镜像和双语机制已经可用。

**整份翻译成中文。** 否决：现有政策文档与 agent 输入以英文为主，skill 也按参考仓库保持英文；只翻译标准会制造两套词汇并打断 `AGENTS.md` 的指针链。中文继续用于面向用户的文档和汇报。

**只写规则，不加 skill 和检查。** 否决：这会把“文档怎么写”留在需要重新解释的正文里；没有 `description` 与四段式，host 无法按触发条件加载写作流程，规则也无法在提交前变红。

**保留 `trim-prose` 作为泄漏清理 skill 的名称。** 否决：`prose-standard` 覆盖一般行文判断，`trim-prose` 的 “trim” 会被误读为所有正文都该缩短；`trim-cot-leakage` 精确指向 CoT/推理残留，不再和完整的行文标准混名。

**让 `docs/handoff/` 继续平铺。** 否决：交接、结果与侦察记录混在同一目录，新记录会继续按“先到先放”而不是按语义族归位；目录本身就无法回答一个文件属于哪类记录。

**按 guide/reference/plan 等 document kind 建目录。** 否决：kind 由读者和问题机械决定，同一语义族可能跨 kind；按 kind 拆会把项目规则、计划与记录切碎，且与“通用规则、项目文档和独立文件留在 docs/ 根”的要求冲突。

**保留 `prose-standard` 中所有源技能规则。** 否决：vendor、Cordis、postmortem、cookbook、双语和生成物规则在本仓库没有对应对象，保留会制造无法执行的义务，并让 agent 在错误的前提上判断。

**继续把 check 硬编码在 `check-invariants.mjs`。** 否决：规则无法从配置看出，新增 kind 没有 runner 覆盖，自测也无法证明每个 kind 都能失败；参考实现的配置驱动、空语料拒绝和 per-kind fixture 才是可维护的闸门。

**只检查 agent 输入的链接。** 否决：没有成对文档工具作为其余 Markdown 的兜底时，普通文档坏链会静默腐烂；全量本地链接检查是确定性的，外部 URL 不联网即可排除。

**只靠 review 判断 kind 和索引可达性。** 否决：kind 与“public/根文档是否可达”都能机械判定；没有声明清单时，新页面可以存在但永远不被索引，kind 也会随作者记忆漂移。

**顺手重写全部存量文档。** 否决：用户要求整理目录与规则，不是改写历史内容；全量重写会制造无关 diff，并破坏已发布页面的证据语义。

## Consequences

- 新 Markdown 必须命中 `docs/publish.json` 恰好一次，新 skill 必须通过 front matter、触发词、四段式和链接检查。
- 文档检查现在由 `tools/workflow.json#checks` 配置驱动；新增 kind 必须同时提供 runner、配置和 invalid/valid 自测，否则 `npm run check:self-test` 的 kind-coverage 会变红。
- 新 Markdown 必须同时进入 `docs/publish.json` 与 `docs/kinds.json`；public/根文档还必须能从 `docs/README.md` 到达。
- 全量本地链接检查不验证外网可用性，也不校验 URL fragment 是否命中目标标题；这两项仍靠 review 或后续专用检查。
- 写作流程成为三个可加载的 agent 输入；`prose-standard` 保留完整源技能与示例，`trim-cot-leakage` 只处理推理/会话泄漏。`npm run check` 只证明结构、命名、触发词和路径形状，不证明 host 在具体任务中真的加载了它；内容质量仍由 review 判定。
- 当前没有生成页、镜像登记表或双语配对，标准只写接入条件，不假装这些机制已经存在。
- 存量文档正文保持原状；它们的 kind 由内容决定，目录位置按语义族迁移。
- 移动后的旧外部链接不再解析到旧路径；仓库内 tracked 引用已同步到新路径。

## Testing

- [A1] 新标准包含 kind、目录架构、one-home、tutorial/reference、link/mirror/generate、预算、发布、防劣质清单和已知边界，并由 `docs-policy` 检查 section 形状 — `plan-docs`
- [A2] 三个 skill 的 `description` 以加载条件开头，四段式非空，相对链接可解析，且 `trim-prose` 目录不再存在 — `agent-skills`
- [A3] `.agents/skills/` 的每个 Markdown 文件（含 `prose-standard/references/examples.md`）在发布清单中恰好分类一次并为 `internal` — `publication`
- [A4] `npm run check` 对缺 section 和摘要式 description 的合成 skill 会变红，证明规则有负例 — `workflow`
- [A5] `prose-standard` 保留完整命题、按位置覆盖、workflow、borderline decisions 和适用示例，且不含 vendor、Cordis、postmortem、cookbook、双语或生成物规则 — `agent-skills`
- [A6] `docs/` 根只保留通用规则、项目文档与独立文件；当前交接在 `docs/handoff/`，历史交接/结果/侦察在 `docs/handoff/{handoffs,results,recon}/`，并由 `docs-layout` 负例证明会变红 — `plan-docs`
- [A7] 移动文件后的所有 tracked Markdown 相对链接可解析，发布清单仍对每个文件恰好分类一次 — `publication`
- [A8] 文档 check 由 `tools/workflow.json#checks` 声明，9 个 kind 各自有 runner；零匹配 check 被拒绝 — `workflow`
- [A9] `npm run check:self-test` 对每个 kind 的 invalid fixture 变红、valid fixture 变绿，并覆盖 empty corpus、word/byte budget 和 publish 四种失败方向 — `workflow`
- [A10] 全部 tracked Markdown 链接可解析；public 与 `docs/` 根文档可从 `docs/README.md` 到达；每个 Markdown 在 `docs/kinds.json` 中恰好一个 kind；Markdown 不超过 50 KiB — `plan-docs`
