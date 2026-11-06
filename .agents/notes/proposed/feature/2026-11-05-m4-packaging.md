# Proposal: M4 单插件打包与发布（预案）

Status: proposed
Date: 2026-11-05
Class: feature

## Problem

M3 的能力已经可用，但只以 `dev_inject_plugin` 的 runtime 注入形式存在：重启后插件与 preset 消失（[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) KI-3）、同名包 client 在旧进程内不生效（KI-11）、安装/卸载没有正式路径，用户无法只装一个包就用上 cowork。PLAN §6 M4 的验收是：

- 一个新 profile 只安装 `dsh-cowork` 一个包即可获得全部能力；
- `dsh plugin --profile web add <path or npm>` 后重启可用；
- README 含安装、使用、卸载、数据落点说明。

仓库当前没有 `dsh.bundle`、没有 `cordis.patch.yml`、没有安装/发布测试；`lib/` 是本地构建产物，`private: true`，探针/E2E 路由与工具混在正式入口里；preset 仍由插件 `apply` 时的 runtime `registerPresets` 注册。M3 还留下一个前置：**M4 必须在 M3-FIX 完成之后开始**——否则 panel API 超时、失败 E2E 清理、`tools.ts` 读预算等问题会原样进入发布物。

M4 的未知项不是“能不能写 README”，而是：bundle patch 能否把宿主插件行装配进去；重启后 preset 是否仍然可用；安装后的 client 是否能加载；新的 profile 能否在不污染用户 `web` profile、不复制凭据的前提下跑真实会话与 E2E。

## Proposal

**前置门（必须先过）**

- `docs/M3_FIX_HANDOFF.md` 的 M3L-1..6 全部关闭；四条命令全绿、真实 M3 E2E 15/15、独立复审 pass、分支已推送。M4 从 M3-FIX 的最终提交开 `feat/m4-packaging`，不从 pre-fix 的 M3 字节开始。
- 先做 M4-P0 探针（见下），结论写 `docs/M4_PROBE_RESULT.md`；与假设冲突就改本预案，不带着假设写安装物。

**分发形态**

- 交付一个 **bundle 包**：`package.json` 声明 `dsh.bundle.patch` → `./cordis.patch.yml`；patch 只做一行 `insert`：`id: dsh-cowork`，`name: '@dsh-external/dsh-cowork'`（与现有工具/协议同名，避免 entry id 分叉）。
- M4 先验证 **本地路径 + tarball** 安装（`dsh plugin --profile <scratch> add ./dsh-cowork-<version>.tgz`），不默认发布 npm；`npm publish` 需要用户明确授权。git install 不在 M4 承诺范围：本仓库的构建依赖 DSH source checkout 的 tsc/esbuild，git 安装拿不到预构建 `lib/`；README 写清这一点，不写一个跑不通的 `prepare`。
- `files` 只含运行必需：`lib`、`cordis.patch.yml`、`README.md`、`LICENSE`；`tools/`、`tests/`、`docs/`、`.dsh-cowork/` 不进包。`private` 在本地 tarball 阶段可保留；真正 npm 发布时再改为非 private 并补 `publishConfig`/repository/keywords，二者分开提交。
- 版本从 `0.0.1` 升到 `0.1.0`（首个可安装 bundle，SemVer minor）；README 写安装、preset 选择、使用、卸载、数据落点（`.dsh-cowork/index.json`、`handoffs/`、`reviews/`、`threads/`、`memory/`、`e2e/`）。

**preset 持久化：runtime registration on bundle load（M4 的主选）**

- M3 的交接预期是把 preset 行迁到 bundle patch。M4-P0 先验证一个更小的事实：bundle 安装后，插件在宿主启动时被 Loader 挂载，`apply` 里的 `agentPresets.register` 在重启后的新会话/新 preset 选择中是否稳定生效。
  - 若稳定：**保留 `src/presets.ts` 的单一事实源与 runtime `registerPresets`**；持久化来自 bundle 启动加载，而不是 YAML 复制。这样 dev inject 仍可复用同一份 preset，避免 YAML 与代码两份行清单、避免外部 bundle 引用 DSH 内部子插件包的解析问题。
  - 若不成立（例如 registry 尚未挂载/注册失败）：退回声明式 `presets.patch.yml`，在 bundle patch 中插入三个 `@deepseek-ai/dsh-agent-preset` 行；此时必须把子插件包补进 `peerDependencies` 并验证外部 bundle 的解析，`src/presets.ts` 只保留 preset id 常量与 persona/测试数据。
- P0 必须验证：安装后重启，新会话能选 `cowork-master` / `cowork-thread` / `cowork-reviewer`；工具面正确（reviewer 无 `tool-fs`）；`sessionController.create({agentPreset:'cowork-master'})` 的 header 记录正确；旧 runtime 的 preset id 不发生冲突。
- 不把 `agent-preset-registry` 的 `default` 改成 cowork：用户的默认 session 仍是 standard；cowork 是显式选择的 workflow。README 写选择方式。

**正式入口与 dev 探针分离**

- 现有 `src/index.ts` 把 M0 probe、S0、M2/M3 E2E 路由与 `cowork_probe`/`cowork_identity_probe` 工具混在正式入口，安装后会对用户暴露无用的 loopback 探针与 E2E 启动面。M4 加配置 `enableDevRoutes: false`（Schemastery，随 Config 持久化）：
  - `false`（默认）：不注册 `/dsh-cowork/probe/*`、`/dsh-cowork/e2e/m2|m3/*`、`cowork_probe`、`cowork_identity_probe`；正式能力（9+2 业务工具、presets、panel API、memory prompt）不受影响。
  - `true`：维护者用 profile patch 覆盖 `id: dsh-cowork` 的 config，跑 E2E/探针；M4 自己的 installed-profile E2E 就是这样跑。
- 不把 `enableDevRoutes` 作为产品能力宣传；README 只写它是维护者选项（或干脆不写，放进 M4 交接）。这比直接删除探针代码安全，也避免 M4 为了 E2E 再引入一条 dev 注入路径。

**安装、重启与验证路径**

- 用**新的 profile**（例如 `m4probe`）验证，不动用户正在用的 `web`/`desktop` profile；优先在现有 `~/.dsh` 下新建 profile（共享账号/设置，但不选为默认），若 P0 发现新 profile 拿不到 LLM/账号，再评估“复制一份 web profile 到临时 profile”或 `DSH_HOME=/tmp/...` 的隔离方案，结论写进探针结果，不复制凭据。
- 验证顺序：`dsh --profile m4probe --from-default-profile web`（创建）→ `dsh plugin --profile m4probe add ./dsh-cowork-0.1.0.tgz` → `dsh --profile m4probe --dump-config`（应出现 `# == @dsh-external/dsh-cowork` 与 `id: dsh-cowork`）→ 重启 → 新会话用 `cowork-master` → 跑真实 flow（init/route/thread/handoff/review/merge）→ 浏览器打开该 profile 的 Web UI，确认底栏/tab/panel 加载 → `dsh plugin --profile m4probe remove @dsh-external/dsh-cowork` → 数据仍在、旧会话提示/可恢复策略写清楚。
- `--dump-config` 与启动使用不同 profile 的端口（例如 3091），避免与用户宿主 3080 混淆；验证结束删除 `m4probe` profile。

**迁移与卸载**

- 从 runtime 注入迁移：`dev_uninject_plugin dsh-cowork` → 清掉 profile patch 里由 uninject 写入的 `- id: dsh-cowork disabled: true` → 安装 bundle；否则 disabled 条目会压住 bundle 插入的同一 id 行。
- 卸载：`dsh plugin --profile <p> remove @dsh-external/dsh-cowork` 移除 bundle 层；`.dsh-cowork` 数据不删。卸载后**已有** session 的 header 仍记录 `cowork-master`，preset 定义随 bundle 消失，恢复会失败——README/结果必须明确；建议卸载前归档/导出相关会话，或保留 bundle。新会话不受影响。
- 重装/升级：bundle 不会自动更新（DSH 插件页约定），卸载后安装新版本；索引 version 仍为 1，review/handoff 数据向后兼容。

**文档与发布**

- README（面向用户）：安装（本地 tarball / npm 授权时）、选择 cowork preset、发起/接收 review、卸载、数据落点、限制（git install 不支持、dev 路由默认关闭、卸载后旧会话 preset 不可恢复）。
- `docs/M4_RESULT.md`、`docs/M4_PROBE_RESULT.md`、`docs/M4_HANDOFF.md`；PLAN §6 M4、KNOWN_ISSUES（KI-3 关闭、KI-11 说明安装路径）、publish.json 分类；本提案落地后迁入 `implemented/`。
- 不发布 npm、不创建远端仓库、不改 `~/.dsh` 的默认 profile，除非用户明确授权。

## Alternatives considered

**只做 README，继续让用户用 dev 注入。** 否决：重启即消失、client 缓存问题、没有卸载路径，满足不了 PLAN M4 的“只装一个包”。

**把 preset 行直接迁到 bundle patch（M3 交接的原预期）。** 暂缓而不是否决：它是 DSH 推荐的声明式形态，但会把 `src/presets.ts` 的行清单复制到 YAML，并让外部 bundle 依赖 DSH 内部子插件包的解析；如果 P0 证明 bundle 加载时的 runtime registration 重启后稳定，保留单一事实源更小、更少回归，dev 注入也还能复用。P0 失败时立即切回声明式。

**发布到 npm 作为 M4 默认出口。** 否决：需要用户授权与 npm 账号；本阶段先验证本地 tarball/路径安装，npm 发布作为后续动作。

**支持 git 安装（`prepare` 构建）。** 否决：构建依赖 DSH source checkout 的 tsc/esbuild，无法做成自包含 `prepare`；写一个会失败的承诺比不写更糟。若未来提供自包含构建链，再评估。

**把 dev 探针直接删掉。** 否决：M4 自己的 installed-profile E2E 还需要探针/E2E 路由；用默认关闭的 config 分离正式与维护者面，风险更小。彻底拆分 dev entry 留到后续需要时。

**改 `agent-preset-registry` 的 default 为 cowork。** 否决：会改变所有新会话的默认行为，cowork 是显式 workflow；不能替用户做默认选择。

## Acceptance criteria

- [M4A1] bundle 包在干净 profile 中 `dsh plugin add` 成功；`--dump-config` 出现 cowork 层与 `id: dsh-cowork`；patch 不改变 base/web 既有行 — `packaging`
- [M4A2] 重启后新会话可选三个 cowork preset，工具面正确（reviewer 无 `tool-fs`），`sessionController.create({agentPreset:'cowork-master'})` 的 header 正确 — `source`, `tests`, `packaging`
- [M4A3] 安装后的 client 在真实 Chrome 加载，底栏/tab/panel 可用；无 dev 注入、无同一进程缓存例外 — `source`, `packaging`
- [M4A4] 安装后的 profile 跑通真实 flow：project init、thread、handoff、review verdict、needs_revision 退回、pass 合并；证据含 profile 路径、sessionId、review 文件与索引快照 — `tests`, `packaging`
- [M4A5] 卸载移除 bundle 层、保留 `.dsh-cowork` 数据；旧会话 preset 不可恢复的后果写进文档 — `source`, `publication`
- [M4A6] `enableDevRoutes=false` 时探针/E2E 路由与两个探针工具不注册；维护者置 true 可跑 M4 E2E — `source`, `tests`
- [M4A7] `files` 只含 lib/patch/README/LICENSE；`npm pack` 产物可安装；git install 不支持与 npm 发布未授权都写清 — `packaging`, `publication`
- [M4A8] README/M4 结果/探针/交接、PLAN/KNOWN_ISSUES/publish 分类完成；四条命令 + `npm run check` 通过；独立 reviewer pass — `publication`, `packaging`

## Risks

- **preset 持久化假设不成立**：P0 必须先验证；失败则切声明式，别在实现中途猜。
- **外部 bundle 行解析**：host 插件行/子插件行从 bundle baseUrl 解析失败会静默跳过；`--dump-config` + 启动日志 + 新会话 header 三重验证。
- **profile 污染**：只在 `m4probe` 新 profile 操作；不推 `main`、不改用户默认 profile；验证后删除 profile；账号/凭据不复制到仓库。
- **卸载破坏旧会话**：preset 定义消失会让旧会话恢复失败；文档必须写清，必要时先归档。
- **dev 探针默认开启**：会给用户暴露无用的 E2E 启动面；默认 false，并用测试/启动验收确认。
- **构建/发布不可复现**：`lib` 由本地 DSH checkout 构建；tarball 必须包含预构建产物并记录版本与构建命令；npm 发布留待授权。
- **同一进程 client 缓存**：安装后首次必须重启宿主再验证；旧进程的示例不算数（KI-11）。
- **M3-FIX 未完成**：M4 会继承未修问题；前置门不过就停下，不做“先发后修”。

## Delivery stages

1. **P0 探针**：bundle patch 装配 + 重启 preset 持久化 + 安装后 client + 新 profile 的 LLM/账号可行性 + runtime/declarative 二选一；写 `docs/M4_PROBE_RESULT.md`。
2. **P1 打包骨架**：`dsh.bundle`/`cordis.patch.yml`/`files`/`private`/version；`enableDevRoutes` 与探针分离；packaging 单测 + `npm pack`。
3. **P2 安装与迁移**：干净 profile 安装、`--dump-config`、重启、preset/工具、卸载与数据保留；从 dev 注入迁移说明。
4. **P3 installed-profile E2E 与 UI**：新 profile 的独立端口 Web UI、真实 flow 15 步、panel 截图；证据落 docs/本地。
5. **P4 文档与发布**：README、M4 结果/探针/交接、PLAN/KNOWN_ISSUES/publish、决策记录迁移；四条命令 + 独立 reviewer；npm 发布/`main` 合并按用户授权。
