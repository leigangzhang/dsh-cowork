# Decision: AgentTeams 规则分层、可执行审查与交付门禁

Status: implemented
Date: 2026-11-08
Class: process

## Problem

2026-11-08 对 M7、M8、M9 三个 AgentTeams 会话的复盘显示，交付质量可靠，但调度反复出现五类成本：

- 派单前没有扫描测试、共享注册表、文件预算和 guard，导致 inScope 外文件在实现中才暴露；M7/M8/M9 都出现过 amend、阻塞或 `undeclared` 失败。
- verification 结论没有从第一次就绑定 `HEAD`、diff sha256 和 `git status`，导致后续重复全量验证或旧 verdict 与当前字节不匹配。
- 低风险 finding 被拆成单条 repair 任务，注释修复又触发文档同步和整轮复审；M9 后段约 42 分钟花在收口而不是功能开发。
- reviewer 的策略是 `readonly`，只能读文件、不能执行验证命令；所谓独立审查仍依赖 verifier 的执行证据。
- 失败任务、合并、push、PR 和文档收口经常不在任务台账内，最终看板无法反映真实交付路径。

同时，用户级 P18、项目规则和预定义 profile 对 worktree、审查、收口等内容有重复；项目规则缺少浏览器/面板硬入口，而浏览器规则本身来自之前 M3/M4 的实战经验，不能在去重时丢失。

## Decision

规则现在按四层分工：

- 用户级 `~/.agents/AGENTS.md` 的 `P18` 只保留跨项目原则：profile 优先、边界物理化、任务契约自包含、独立且可执行的审查、证据随产物、审查双闸、显式交付闭环、保守收口与成本控制。
- 项目级 [docs/AGENTTEAM.md](../../../../docs/AGENTTEAM.md) 拥有 DAG、影响面扫描、gate artifact、worktree、批量收口、交付任务和浏览器/面板规则；R3 要求首个 verification 绑定 `HEAD`、diff sha256、`git status`；R6 要求派单前 grep 引用、检查文件预算并把受影响测试写入 inScope；R10 要求 review 后的 finding 一次批量修复，纯注释/文档变更走 `npm run check` 和 delta review，并建立显式 `delivery` 任务。
- 项目入口 [AGENTS.md](../../../../AGENTS.md) 只保留指针和硬约束，并要求队长在创建计划前读 [docs/AGENTTEAM.md](../../../../docs/AGENTTEAM.md)。浏览器/面板规则以摘要形式保留在 `## AgentTeams` 段：先修 host health 与 overview API，复用浏览器 session，隔离 fixture 与 live 数据，不用 sleep 当 readiness。
- 部署 profile 的本地配置 `~/.dsh/profiles/{web,desktop}/cordis.patch.yml` 使用可执行只读审查策略：`impl-review`、`impl-review-parallel`、`refactor-parallel` 的 reviewer 使用 `verify-only`；新增 `impl-review-parallel`（4 个成员，两个实现者各用独立 worktree）；队长协议保持在 240 字符内，`pair-review` 做同样的去冗长处理。这些 profile 是部署配置，不进入仓库提交。

浏览器/面板规则继续由项目规则 R8/R9 拥有；[AGENTS.md](../../../../AGENTS.md) 中的英文条目是必须加载的摘要指针，不重复 R8/R9 的操作细节。

## Alternatives considered

**把所有细节继续放在 P18。** 否决：P18 会重新变成项目手册，跨项目复用时会带入 worktree、marker、fixture 等本仓库专属概念；通用原则和项目机制混在同一层，违背分级配置。

**把所有规则塞进 AGENTS.md。** 否决：AGENTS.md 有 80 行预算，且项目约定 AGENTS.md 只拥有指针；细节已经分散到 `docs/AGENTTEAM.md`、`docs/AGENTS.md` 和 `tools/workflow.json`，再复制会造成漂移。

**保留 reviewer 的 `readonly` 策略。** 否决：M7/M8/M9 的 reviewer 都明确无法执行命令，最终只能采信 verifier；这不能满足“独立复核运行结果”的要求。改用 `verify-only` 后仍配合隔离副本和只读协议，因为 bash 本身不是 OS 沙箱。

**把第二个实现者直接加进 `impl-review`。** 否决：单实现者仍是多数任务的正确默认，强行四成员会增加每次建队的成本和空闲成员；因此新增独立的 `impl-review-parallel`，按需选用。

**为每条低风险 finding 建 repair 任务并重新全量验证。** 否决：M9 的注释修复已经证明这会把收口拉长，并让旧 verdict 因字节变化而失效；改为批量 cleanup，只有行为变化才重开完整 verification/review。

**改动 `/Applications` 下的插件包来修改预定义 profile。** 否决：预定义 profile 属于用户部署配置，应通过 `~/.dsh/profiles/*/cordis.patch.yml` 落地；修改安装包既不可维护，也会在升级时丢失。

## Consequences

收益：任务契约在派单前更可能包含真实影响面；verification 结果可以从产物身份复用；review 能执行最小只读验证；低风险 finding 不再逐条放大；merge、push、PR 不再只存在于队长脑中；浏览器/面板的实战规则仍有明确入口。

代价：首次 verification 需要记录 artifact；review 后的修复需要先批量整理；`delivery` 增加一个显式任务；reviewer 的 `verify-only` 仍允许 bash 写文件，必须用隔离副本和 protocol 兜底；新增 profile 需要在新会话里实际启动后才能证明成员路由和工具策略可用。规则要求先在本项目运行两个阶段，再考虑把新原则提升到 P18。

## Testing

- [A1] `AGENTS.md` 保持 80 行以内，并在 `## AgentTeams` 段包含 R8/R9 浏览器条目 — `context-rules`
- [A2] [docs/AGENTTEAM.md](../../../../docs/AGENTTEAM.md) 是项目规则唯一 home，`docs/publish.json` 对该路径恰好分类一次 — `publication`
- [A3] 项目规则包含 gate artifact、影响面扫描、批量 cleanup、delivery 任务和更新后的 DAG — `decisions`
- [A4] `npm run check` 通过，`npm test` 通过 596/596 — `context-rules`, `publication`
- [A5] web/desktop profile YAML 均可解析，各 8 个 profile，队长协议段 ≤240 字符，目标 reviewer 为 `verify-only` — `decisions`（部署配置在仓库外；本记录保存一次性 Ruby 校验结论，CI 覆盖标 unpinned）
- [A6] `build-codex-agents.sh --check` 通过，用户级 P18 的生成物与源一致 — `decisions`（用户级 `~/.agents` 不在本仓库版本控制内；本记录保存一次性校验结论，CI 覆盖标 unpinned）
