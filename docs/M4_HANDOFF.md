# M4 交接文档

- 状态：**预案 + 预检（2026-11-05）**，M4 尚未开始。前置门 **M3-FIX 已完成（2026-11-06）**，见 [M3 修复交接](M3_FIX_HANDOFF.md) 与 [M3 结果](M3_RESULT.md)「M3-FIX 收口」；M4 从 M3-FIX 的最终提交开分支，不要把 M3-FIX 已修问题再带进发布物。
- 适用：接手 M4（单插件打包与发布）的 agent 或人。范围：bundle 安装、preset 持久化、client 加载、安装/卸载路径、README 与发布验证；不包含 M5 记忆治理。
- 事实源：[PLAN](PLAN.md) §6 M4 验收；[M4 提案](../.agents/notes/proposed/feature/2026-11-05-m4-packaging.md) 拥有分发形态、preset 方案与验收；[M3 结果](M3_RESULT.md)/[M3 修复交接](M3_FIX_HANDOFF.md) 拥有前置事实；[PANEL_RESULT](PANEL_RESULT.md) 拥有面板设计；[KNOWN_ISSUES](KNOWN_ISSUES.md) 拥有不修项。本文只拥有「从哪继续、先验证什么、怎样算完成」。

## 当前基线（写于 2026-11-05）

- 分支：M3-FIX 收口在 `fix/m3-closeout`（M3 原交付 `feat/m3-review-panel`，`main` 未由 M3/M3-FIX 改动）；M4 从 `fix/m3-closeout` 的最终提交开 `feat/m4-packaging`，或等用户授权合并 `main` 后从 `main` 开。
- M3-FIX 交付证据：真实宿主 E2E run `m3-004629a6-c7de-48c1-92e9-99c474eae1a1` 15/15、`tempRepoRemoved=true`；失败路径实测 `m3-565e31d8-…`；`npm run check` 0、`npm test` 330/330、typecheck/build 0；面板补验截图 `04`–`06` 在 `.dsh-cowork/e2e/panel-m3/`（gitignored）。
- 环境：DSH Desktop Web `http://127.0.0.1:3080`；`dsh` CLI `/Users/ray/bin/dsh`（0.2.1-rc.2）；DSH source checkout `/Users/ray/Workspace/deepseek-harness`（构建用 tsc/esbuild）；profiles `web`/`desktop`/`acp`；当前插件仍是 runtime 注入（`dev_inject_plugin`），重启后需重注入。
- profile patch：`~/.dsh/profiles/web/cordis.patch.yml` 仍有 `- id: dsh-cowork disabled: true`（uninject 写入）与 `- id: dsh-cowork-panel disabled: true`；安装 bundle 前必须清理同名 disabled 条目，否则 bundle 插入的 `id: dsh-cowork` 行会被压住。
- 数据：真实 `.dsh-cowork` 已恢复（一个 thread「路由演示」）；截图/fixture/backup 只在本地，`git status` 应只有 ignored 运行数据。M3-FIX marker `.dsh-cowork/e2e/M3_DOCS_READY.json` 的 `commit` 等于 `fix/m3-closeout` 最终 HEAD，screenshots 含 `04`–`06`；M4 的 marker 应另写，不要把 M3-FIX marker 当 M4 证据。

## 已知事实（写代码前先读）

- DSH bundle 约定（DSH source checkout 的 `docs/user/develop/basic/publish.md`，本机 `/Users/ray/Workspace/deepseek-harness/docs/user/develop/basic/publish.md`）：包在 `package.json` 声明 `dsh.bundle.patch`，pack 里带 `cordis.patch.yml`；patch 数组用 `insert` 行引用安装后的包名；`files` 必须包含 patch 与 `lib`。参考真实例子：`~/.dsh/profiles/web/node_modules/@wxg-prc-cpg/browser-skill-dsh-plugin/`（`dsh.bundle.patch` + `cordis.patch.yml` + `files`）。
- `dsh plugin --profile <name> add <spec>` 会转发 pnpm；首次使用会初始化 profile（base bundle）。本地路径/tarball 安装先验证，不默认 npm 发布。
- Agent preset 有两种持久形态：bundle patch 里的声明式 `@deepseek-ai/dsh-agent-preset` 行（DSH 推荐，见 `packages/preset/agent-preset/README.md`），或插件 `apply` 时的 runtime `agentPresets.register`。M4-P0 必须先验证后者在 bundle 启动加载后重启是否稳定；稳定则保留单一事实源，不稳定再切声明式。不要同时注册两份（duplicate preset ids 会失败）。
- 当前 `src/index.ts` 把 M0/S0/M2/M3 探针与 E2E 路由、`cowork_probe`/`cowork_identity_probe` 工具混在正式入口；M4 用 `enableDevRoutes=false` 默认关闭，维护者置 true 跑 installed-profile E2E。
- 当前 `package.json`：`private: true`、`files: ["lib"]`、无 `dsh.bundle`；`lib/` 由本地 checkout 构建；git 安装拿不到预构建 `lib/`，M4 不承诺 git 安装。

## 第一步：M4-P0 探针（写 `docs/M4_PROBE_RESULT.md`）

按顺序做，每步记录命令、退出码、实际输出。失败就停，不要先写打包物。

1. **M3-FIX 门（已完成）**：`docs/M3_FIX_HANDOFF.md` 的 M3L-1..6 已有证据；四条命令 + 真实 M3 E2E 15/15 + 独立 review pass；M3-FIX HEAD 见 `.dsh-cowork/e2e/M3_DOCS_READY.json`。M4 开工前只需复核该 marker 与 `git rev-parse HEAD` 一致（`node tools/check-evidence-marker.mjs`）。
2. **安装目标**：不动用户 `web`/`desktop`。优先在现有 `~/.dsh` 下创建新 profile `m4probe`：
   - `dsh --profile m4probe --from-default-profile web`（以 CLI 实际行为为准；创建后确认 `~/.dsh/profiles/m4probe` 存在、`web` 未被改）；
   - 若新 profile 拿不到 LLM/账号，先记录实际错误；选项：复制 web profile 的非凭据设置 / 用 `DSH_HOME=/tmp/m4-home` 隔离 / 问用户。**不复制明文 token/凭据进仓库**。
3. **最小 bundle 装配**：在临时目录做一个 hello bundle（`dsh.bundle.patch` + `cordis.patch.yml` + 一行 `insert`），`dsh plugin --profile m4probe add /tmp/hello-bundle`，`dsh --profile m4probe --dump-config` 看行；重启看是否仍在。证明 patch 机制与 pnpm 路径可用，再把真包接进来。
4. **preset 持久化**：安装真包后重启，确认三个 cowork preset 出现在新会话选择里、`sessionController.create({agentPreset:'cowork-master'})` 的 header 正确、reviewer 无 `tool-fs`；若 runtime registration 失败，记录错误并切声明式 `presets.patch.yml` 的 P0 试验。
5. **client 加载**：安装后**重启宿主**再开浏览器；确认底栏「打开 Cowork 面板」/Cowork tab 来自已安装包，不是 dev inject；旧进程不算数（KI-11）。
6. **LLM/账号**：新 profile 里真实 `cowork-master` 能完成一次最小会话（一条消息）；不能则记录缺什么，再决定安装/验证路径。
7. **dev 路由门**：默认 config 下 `/dsh-cowork/probe/health`、`/dsh-cowork/e2e/m3/status` 应为 404；profile patch 覆盖 `enableDevRoutes: true, repoPath: /tmp/m4-e2e` 后可用。确认默认不暴露。

探针结果决定：runtime preset 还是声明式；安装目标是新 profile 还是隔离 DSH_HOME；E2E 用哪个端口/profile。写进结果后再进入 P1。

## 实施顺序

1. **P1 打包骨架**：`package.json` 加 `dsh.bundle.patch`/`files`（lib、cordis.patch.yml、README、LICENSE）/版本 0.1.0；`cordis.patch.yml` 插 `id: dsh-cowork, name: '@dsh-external/dsh-cowork'`；`private` 处理分阶段（本地 tarball 可保留，npm 发布才改）；`npm pack` 检查内容。
2. **P2 preset + dev 门**：按 P0 结论保留 runtime registration 或迁声明式；加 `enableDevRoutes`（Schemastery，默认 false），把 probe/S0/M2/M3 路由与两个探针工具包在开关里；正式工具/preset/panel API 不受影响。
3. **P3 安装/重启/迁移**：清 profile patch 的 disabled 条目；clean profile 安装 tarball；`--dump-config`；重启；新会话；完整 flow（init/route/thread/handoff/review verdict/needs_revision 退回/pass 合并）；浏览器打开新 profile 的 Web UI（独立端口，如 3091，不替 3080）验证 panel；卸载并确认 `.dsh-cowork` 数据保留、旧会话 preset 不可恢复的后果写清。
4. **P4 文档与发布**：README（安装/选择 preset/使用/卸载/数据落点/限制）、`docs/M4_RESULT.md`、`docs/M4_PROBE_RESULT.md`、M4 决策记录迁 `implemented/`、PLAN §6/KNOWN_ISSUES（KI-3 关闭、KI-11 按安装路径更新）/publish.json；四条命令 + `npm run check` + 独立 verifier/reviewer；`feat/m4-packaging` push；npm 发布与 `main` 合并需用户明确授权。

## 验证与证据（M4 完成时必须能复述）

- 包：`npm run build` → `npm pack`；tarball 文件列表只含 lib/patch/README/LICENSE；`npm pack --dry-run` 记录。
- 安装：`dsh plugin --profile m4probe add ./dsh-cowork-0.1.0.tgz`；`--dump-config` 有 cowork 层；重启后仍在；不污染 `web`。
- 运行：新 session 选 `cowork-master`；业务工具 11 个（9+2）可见；reviewer preset 无 `tool-fs`；panel API 200；client 真实 Chrome 加载。
- 端到端：installed-profile 的真实 flow 至少覆盖 pass 合并 + needs_revision 修复复审；证据含 profile 路径、DSH/包版本、sessionId、review 文件、索引快照；截图（panel/两档或安装后的 list/detail）。
- 卸载：`dsh plugin --profile m4probe remove @dsh-external/dsh-cowork`；项目数据仍在；旧会话恢复失败的用户提示写进 README/结果；删除 `m4probe` profile（只删自己创建的）。
- 命令：`npm run check` / `npm test` / `npm run typecheck` / `npm run build` 全绿；独立 reviewer pass；marker/证据指针一致。

## 陷阱

- **不要**把 bundle 装进用户正在用的 `web` profile，也不要改 `default` preset 为 cowork；用 `m4probe` 并在结束后删除。
- **不要**在旧进程里验证 client/preset（KI-11、KI-3）；安装/迁移后必须重启宿主。
- **不要**在 profile patch 留着 `- id: dsh-cowork disabled: true` 就安装；它会压住 bundle 行。安装前清理，安装后 `--dump-config` 核对。
- **不要**同时 runtime + 声明式注册 preset；duplicate id 会失败。
- **不要**把探针/E2E 路由默认暴露给用户；`enableDevRoutes=false` 是默认，E2E 用 profile patch 覆盖。
- **不要**复制账号 token/凭据到仓库或证据；新 profile 的 LLM 可用性是 P0 决策点。
- **不要**默认 npm publish、创建远端仓库、装系统级依赖；这些需要用户许可。
- **不要**把 `main` 当工作分支；M4 分支从 M3-FIX 最终提交开，push 分支，合并 `main` 等授权。
- **不要**让 M4 继承 M3-FIX 未修问题；门不过就停。
- 如果并行/多 agent：按 P18 用已配置 profile + worktree；实现者不自审；门禁生成任务要有可读标题；不归档团队除非用户确认。

## 完成定义

- M4-P0 有结果、假设被验证或修正；M4A1..M4A8（见 [M4 提案](../.agents/notes/proposed/feature/2026-11-05-m4-packaging.md)）全部有证据。
- 新 profile 只装一个包即可用；重启后 preset/client/tools 正常；安装、升级/重装、卸载与数据落点写进 README；旧会话卸载风险写明。
- `npm run check`/`npm test`/typecheck/build 全绿；installed-profile E2E 通过；独立 reviewer pass；证据落盘（`.dsh-cowork/e2e/` 或 docs 指针），不提交运行数据。
- `main` 未擅动；npm 未发布（除非用户明确授权）；M4 结果、提案迁移、KNOWN_ISSUES/PLAN/publish 同步。

## 回滚

- 卸载 `m4probe` 里的 bundle；删除自己创建的 `m4probe` profile；不动 `web`/`desktop`。
- 代码回滚：按 P1–P4 提交 revert；M3/M3-FIX 交付不动。
- 数据：`.dsh-cowork` 不随包删除；卸载/回滚前如需保留旧会话，先归档/导出；fixture/E2E 运行目录是 gitignored，可删除。
- 运行时：开发期可继续用 `dev_inject_plugin /Users/ray/Workspace/dsh-cowork` 作为回退，但不要把它当作 M4 的验收路径。
