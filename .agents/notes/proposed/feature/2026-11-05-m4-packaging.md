# Proposal: M4 单插件打包与发布（预案）

Status: proposed
Date: 2026-11-05
Class: feature

## Problem

M3 的能力已经可用，但只以 `dev_inject_plugin` 的 runtime 注入形式存在：重启后插件与 preset 消失（[KNOWN_ISSUES](../../../../docs/KNOWN_ISSUES.md) KI-3）、同名包 client 在旧进程内不生效（KI-11）、安装/卸载没有正式路径，用户无法只装一个包就用上 cowork。PLAN §6 M4 的验收是：

- 一个新 profile 只安装 `dsh-cowork` 一个包即可获得全部能力；
- `dsh plugin --profile web add <path or npm>` 后重启可用；
- README 含安装、使用、卸载、数据落点说明。

截至 2026-11-07 的代码事实（`fix/m3-closeout` 最终提交 `5622759`，M4 从它开 `feat/m4-packaging`）：

- `package.json` 声明 `dsh.client`、`exports["./client"]`，但没有 `dsh.bundle`；`files` 只有 `lib`；仍是 `private: true`、版本 `0.0.1`。
- `src/index.ts` 在正式入口**无条件**注册 M0/S0/M2/M3 探针与 E2E 路由、`cowork_probe`、`cowork_identity_probe`；`Config` 只有 `repoPath` / `promptTimeoutMs` / 两个存储路径。
- 三个 preset 由 `apply` 时的 runtime `agentPresets.register` 注册；`src/presets.ts` 是唯一行清单。
- `lib/` 是本地构建产物（types 来自 DSH source checkout，runtime link 到已安装 app）；git 安装拿不到预构建 `lib/`。
- M3-FIX 已完成；证据 marker `.dsh-cowork/e2e/M3_DOCS_READY.json` 的 `commit` 是 `51bbeb1`，其后只有 3 个 docs-only 提交到 HEAD `5622759`（`git diff --stat 51bbeb1..HEAD` 只含 `AGENTS.md`、`docs/`、`.agents/notes/`），因此 `node tools/check-evidence-marker.mjs` 报 HEAD 失配是时序，不是 M3 代码回归；M4 的 marker 另写，不复用 M3 的。

M4 的未知项不是“能不能写 README”，而是：bundle patch 能否把宿主插件行装配进去；重启后 preset 是否仍然可用；安装后的 client 是否能从已安装包加载；新的 profile 能否在不污染用户 `web` profile、不复制凭据的前提下跑真实会话与 E2E；默认配置下探针面是否对用户关闭。

**P0 探针结论（2026-11-07，详见 [M4 探针结果](../../../../docs/M4_PROBE_RESULT.md)）**

- 最小 hello bundle 安装到 `m4probe` 后 `--dump-config` 出现 `# == m4probe-hello-bundle` 层，新进程里它的 loopback 路由返回 200：bundle patch 装配与 pnpm 路径可用。
- 真包（临时 `dsh.bundle` + `cordis.patch.yml`，版本 `0.1.0`）打成 `dsh-external-dsh-cowork-0.1.0.tgz` 后安装，`--dump-config` 出现 `# == @dsh-external/dsh-cowork` 与 `id: dsh-cowork`；新进程 health 报 `version: 0.1.0` 且 `repoPath` 来自 profile patch，说明插件从已安装包加载。
- 重启后的新进程里，M3 E2E 的 `setup`/`thread-a-create`/`thread-a-work`/`review-a-request` 通过：`cowork-master` 可创建、`agentPreset` 记录正确、真实 LLM 在 `m4probe` 里能完成会话、reviewer 会话可建。
- 真实 Chrome 打开 `127.0.0.1:3091`（m4probe）后底栏出现「打开 Cowork 面板」，tab 显示「Cowork 关闭」，面板渲染空态：client 来自安装包，不依赖 dev 注入，也没有同进程缓存例外（KI-11 在安装/重启路径不复现）。
- **P0-F1（必须修）**：E2E 的 `repoPath` 配成 `/tmp/m4-e2e` 时，宿主把会话 cwd 规范化为 `/private/tmp/...`，而 runner 断言仍用 `/tmp/...`，`review-a-pass` 因“review 文件不在 reviews 目录下”失败。产品工具本身按调用者 cwd 解析项目，不受影响；这是 dev/E2E 面的路径规范化缺口。
- **P0-F2（验证副作用）**：`m4probe` 与用户 `web` 共用 `~/.dsh`，因此 3091 能看到用户全部会话，E2E 也会把测试会话写进共享会话存储；收尾必须归档/清理测试会话并删除 `m4probe`，不能把测试数据留在用户会话列表。
- **P0-F3（环境）**：本地未跟踪且已 gitignore 的 `.marklingo/zh-CN/*.md` 会让 `npm run check` 与 publish 测试变红；基线期间移到 `/tmp/m4-marklingo-backup-*`，未删除，不属于仓库变更。

## Proposal

**前置门（已完成）**

- M3-FIX 的 M3L-1..6 已关闭、四条命令 330/330、真实 M3 E2E 15/15、独立复审 pass；`feat/m4-packaging` 从 `5622759` 开分支，不带 M3-FIX 已修问题进发布物。
- P0 结论已写入 `docs/M4_PROBE_RESULT.md`；P0-F1 在 P2 内修掉后再跑最终 installed-profile E2E。

**分发形态**

- 交付一个 **bundle 包**：`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`；patch 只做一行 `insert`：`id: dsh-cowork`，`name: '@dsh-external/dsh-cowork'`（与工具/协议同名，避免 entry id 分叉）。
- M4 只验证 **本地路径 + tarball** 安装（`dsh plugin --profile <scratch> add ./dsh-external-dsh-cowork-<version>.tgz`），不发布 npm；`npm publish` 需要用户明确授权。git install 不在 M4 承诺范围：本仓库构建依赖 DSH source checkout 的 tsc/esbuild，git 安装拿不到预构建 `lib/`；README 写清这一点，不写一个跑不通的 `prepare`。
- `files` 只含运行必需：`lib`、`cordis.patch.yml`、`README.md`、`LICENSE`；`tools/`、`tests/`、`docs/`、`.dsh-cowork/` 不进包。`private` 在本地 tarball 阶段保留；真正 npm 发布时再改为非 private 并补 `publishConfig`/repository/keywords，二者分开提交。
- 版本从 `0.0.1` 升到 `0.1.0`（首个可安装 bundle，SemVer minor）。P0 实测 `npm pack` 产物 248,608 B、78 个文件，全部落在 `lib/`（含 source map）、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`。

**preset 持久化：runtime registration on bundle load（P0 已验证，保留）**

- 保留 `src/presets.ts` 的单一事实源与 runtime `registerPresets`：bundle 安装后由宿主启动时 Loader 挂载插件，`apply` 里的 `agentPresets.register` 在重启后稳定生效（P0 的 `setup`/`review-a-request` 已证）。
- 不迁声明式 `@deepseek-ai/dsh-agent-preset` 行：那会把 `src/presets.ts` 的行清单复制到 YAML、让外部 bundle 依赖 DSH 内部子插件包的解析；P0 没有出现必须切换的证据。dev inject 也继续复用同一份 preset。
- 不把 `agent-preset-registry` 的 `default` 改成 cowork：用户的默认 session 仍是 standard；cowork 是显式选择的 workflow。README 写选择方式。

**正式入口与 dev 探针分离**

- `Config` 增加 `enableDevRoutes: z.boolean().default(false)`。默认 `false` 时：
  - 不注册 `/dsh-cowork/probe/*`、`/dsh-cowork/e2e/m2|m3/*` 路由；
  - 不注册 `cowork_probe` / `cowork_identity_probe`；
  - 不构造/挂载 M0/S0/M2/M3 runner 的 session 事件监听（保持正式能力不受影响：11 个业务工具、3 个 preset、panel API、memory prompt）。
  - `true` 时保持现有全部探针与 E2E 面；维护者用 profile patch 覆盖 `id: dsh-cowork` 的 config 跑 M4 installed-profile E2E。
- 同时修 **P0-F1**：dev/E2E 使用的 `repoPath` 在启动时规范化为真实路径（存在则 `realpath`），使 runner 的 fixture、会话 cwd、证据断言使用同一前缀；加确定性单测（`/tmp` → `/private/tmp` 这类软链前缀不再让断言失败）。
- 不把 `enableDevRoutes` 作为产品能力宣传；README 只写它是维护者选项（或放进 M4 交接）。

**安装、重启与验证路径**

- 用**新的 profile** `m4probe` 验证，不动用户正在用的 `web`/`desktop`：`dsh --profile m4probe --from-default-profile web`（P0 已创建，bundles = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`）→ 安装 tarball → `--dump-config` 核对层 → 重启（新进程）→ 新会话选 `cowork-master` → 真实 flow → 浏览器打开 `127.0.0.1:3091`（独立端口，不替 3080）→ 卸载 → 数据保留 → 删除 `m4probe`。
- 验证顺序与证据：默认 config 下 `/dsh-cowork/probe/health`、`/dsh-cowork/e2e/m3/status` 必须 404；`/api/cowork.overview` 必须是 401（路由存在、trust fence 生效）而不是 404；profile patch 覆盖 `enableDevRoutes: true, repoPath: /private/tmp/m4-e2e` 后跑一次 M3 runner 的 15 步（pass 合并 + needs_revision→修复→复审→合并）；证据写到 `.dsh-cowork/e2e/M4_*`（本地 gitignored）并在 `docs/M4_RESULT.md` 记录 profile 路径、包版本、sessionId、review 文件、索引快照。
- 浏览器验证用 browser-skill 连接真实 Chrome，复用同一个长生命周期 session/tab；截图落在 `.dsh-cowork/e2e/m4/`（gitignored）。收尾归档/清理测试会话，删除 `m4probe`，确认 `web` 未被改。

**迁移与卸载**

- 从 runtime 注入迁移：`dev_uninject_plugin dsh-cowork` → 清掉用户 profile patch 里由 uninject 写入的 `- id: dsh-cowork disabled: true` → 安装 bundle；否则 disabled 条目会压住 bundle 插入的同一 id 行。**M4 不修改用户 `web` profile 的这一条目**，只在 README/结果里写清迁移步骤。
- 卸载：`dsh plugin --profile <p> remove @dsh-external/dsh-cowork` 移除 bundle 层；`.dsh-cowork` 数据不删。卸载后**已有** session 的 header 仍记录 `cowork-master`，preset 定义随 bundle 消失，恢复会失败——README/结果必须明确；建议卸载前归档/导出相关会话，或保留 bundle。新会话不受影响。
- 重装/升级：bundle 不会自动更新（DSH 插件页约定），卸载后安装新版本；索引 version 仍为 1，review/handoff 数据向后兼容。

**文档与发布**

- README（面向用户）：安装（本地 tarball，npm 授权时补）、选择 cowork preset、发起/接收 review、卸载、数据落点（`.dsh-cowork/index.json`、`handoffs/`、`reviews/`、`threads/`、`memory/`、`e2e/`）、限制（git install 不支持、dev 路由默认关闭、卸载后旧会话 preset 不可恢复）。
- `docs/M4_RESULT.md`、`docs/M4_PROBE_RESULT.md`、`docs/M4_HANDOFF.md` 更新；PLAN §6 M4、KNOWN_ISSUES（KI-3 关闭、KI-11 按安装路径更新）、publish.json 分类；本提案落地后迁入 `implemented/` 并改写为现在时。
- 不发布 npm、不创建远端仓库、不改 `~/.dsh` 的默认 profile，除非用户明确授权；`main` 的合并/推送同样需要授权。

## Alternatives considered

**只做 README，继续让用户用 dev 注入。** 否决：重启即消失、client 缓存问题、没有卸载路径，满足不了 PLAN M4 的“只装一个包”。

**把 preset 行直接迁到 bundle patch（M3 交接的原预期）。** 否决：P0 已证 runtime registration 在 bundle 启动加载后重启仍稳定；声明式会复制行清单、把外部 bundle 绑到 DSH 内部子插件包解析，收益不抵成本。若未来出现注册时机回归，再以新提案切换。

**发布到 npm 作为 M4 默认出口。** 否决：需要用户授权与 npm 账号；本阶段先验证本地 tarball 安装，npm 发布作为后续动作。

**支持 git 安装（`prepare` 构建）。** 否决：构建依赖 DSH source checkout 的 tsc/esbuild，无法做成自包含 `prepare`；写一个会失败的承诺比不写更糟。若未来提供自包含构建链，再评估。

**把 dev 探针直接删掉。** 否决：M4 自己的 installed-profile E2E 还需要探针/E2E 路由；用默认关闭的 config 分离正式与维护者面，风险更小。彻底拆分 dev entry 留到后续需要时。

**改 `agent-preset-registry` 的 default 为 cowork。** 否决：会改变所有新会话的默认行为，cowork 是显式 workflow；不能替用户做默认选择。

**只把 E2E 的 repoPath 改成 `/private/tmp` 绕过 P0-F1，不改代码。** 否决：软链前缀会让任何维护者在 `/tmp` 下复现同一失败，且 runner 的证据前缀依赖宿主 cwd 规范化；用一次 `realpath` 规范化 + 单测把陷阱固化成可验证行为更小、更稳。

## Acceptance criteria

- [M4A1] bundle 包在干净 profile 中 `dsh plugin add` 成功；`--dump-config` 出现 cowork 层与 `id: dsh-cowork`；patch 不改变 base/web 既有行 — `packaging`
- [M4A2] 重启后新会话可选三个 cowork preset，工具面正确（reviewer 无 `tool-fs`），`sessionController.create({agentPreset:'cowork-master'})` 的 header 正确 — `source`, `tests`, `packaging`
- [M4A3] 安装后的 client 在真实 Chrome 加载，底栏/tab/panel 可用；无 dev 注入、无同一进程缓存例外 — `source`, `packaging`
- [M4A4] 安装后的 profile 跑通真实 flow：project init、thread、handoff、review verdict、needs_revision 退回、pass 合并；证据含 profile 路径、sessionId、review 文件与索引快照 — `tests`, `packaging`
- [M4A5] 卸载移除 bundle 层、保留 `.dsh-cowork` 数据；旧会话 preset 不可恢复的后果写进文档 — `source`, `publication`
- [M4A6] `enableDevRoutes=false` 时探针/E2E 路由与两个探针工具不注册；维护者置 true 可跑 M4 E2E；dev `repoPath` 在软链前缀下断言稳定 — `source`, `tests`
- [M4A7] `files` 只含 lib/patch/README/LICENSE；`npm pack` 产物可安装；git install 不支持与 npm 发布未授权都写清 — `packaging`, `publication`
- [M4A8] README/M4 结果/探针/交接、PLAN/KNOWN_ISSUES/publish 分类完成；四条命令 + `npm run check` 通过；独立 reviewer pass — `publication`, `packaging`

## Risks

- **preset 持久化**：P0 已在当前宿主版本验证 runtime 注册可用；宿主升级改变 registry 挂载时机时需重跑 P0 并重新评估声明式方案。
- **外部 bundle 行解析**：host 插件行/子插件行从 profile baseUrl 解析失败会静默跳过；`--dump-config` + 启动日志 + 新会话 header 三重验证。
- **软链路径（P0-F1）**：`/tmp` → `/private/tmp` 已实测让 E2E 断言失败；P2 必须修并加单测，最终 E2E 重跑一次，不原样重试。
- **共享 home 污染（P0-F2）**：`m4probe` 读到用户的 1.2 MB 会话列表、E2E 会话写进共享存储；收尾必须归档/清理测试会话、删除 `m4probe`，并确认 `web`/`desktop` 的 manifest 与 patch 未变。
- **profile 污染**：只在 `m4probe` 操作；不推 `main`、不改用户默认 profile；账号/凭据不复制到仓库；卸载时只删自己创建的 profile。
- **卸载破坏旧会话**：preset 定义消失会让旧会话恢复失败；文档必须写清，必要时先归档。
- **dev 探针默认开启**：会给用户暴露无用的 E2E 启动面；默认 false，并用路由 404 + 工具缺席的测试/启动验收确认。
- **构建/发布不可复现**：`lib` 由本地 DSH checkout 构建；tarball 必须包含预构建产物并记录版本与构建命令；npm 发布留待授权。
- **同一进程 client 缓存**：安装后首次必须重启宿主再验证；旧进程的示例不算数（KI-11）。
- **本地 `.marklingo/`（P0-F3）**：未跟踪且已 gitignore 的生成物会让 `npm run check` 变红；M4 不把它当仓库事实，收尾恢复/说明，不用它伪造绿门。

## Delivery stages

1. **P0 探针（已完成 2026-11-07）**：bundle patch 装配、真包安装与重启、preset/LLM、client、dev 路由现状；结果写 `docs/M4_PROBE_RESULT.md`；发现 P0-F1..F3。
2. **P1 打包骨架**：`dsh.bundle`/`cordis.patch.yml`/`files`/`private`/version `0.1.0`；packaging 测试 + `npm pack` 文件清单；P0 已先落最小骨架，P1 补齐测试与文档校验。
3. **P2 正式入口与 dev 门**：`enableDevRoutes`（默认 false）包住探针路由/工具/runner；dev `repoPath` realpath 规范化 + 单测；类型/测试/构建。
4. **P3 安装与迁移**：干净 profile 安装、`--dump-config`、重启、preset/工具、默认路由 404、installed-profile E2E、真实 Chrome panel、卸载与数据保留；收尾清理测试会话与 profile。
5. **P4 文档与发布**：README、M4 结果/探针/交接、PLAN/KNOWN_ISSUES/publish、决策记录迁移；四条命令 + 独立 verifier/reviewer；push 分支；npm 发布/`main` 合并按用户授权。
