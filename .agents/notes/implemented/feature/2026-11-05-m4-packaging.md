# Decision: M4 单插件打包与发布

Status: implemented
Date: 2026-11-05
Class: feature

## Problem

M3 的能力已经可用，但只以 `dev_inject_plugin` 的 runtime 注入形式存在：宿主重启即失去插件与 preset，同名包 client 在旧进程内不生效，安装与卸载没有正式路径，用户无法只装一个包就用上 cowork。PLAN §6 M4 的验收是：

- 一个新 profile 只安装 `dsh-cowork` 一个包即可获得全部能力；
- `dsh plugin --profile web add <path or npm>` 后重启可用；
- README 含安装、使用、卸载、数据落点说明。

未知项不是「能不能写 README」，而是 bundle patch 能否把宿主插件行装配进去、重启后 preset 是否仍可用、安装后的 client 能否从已安装包加载、新 profile 能否在不污染用户 `web` profile 的前提下跑真实会话与 E2E、默认配置下探针面是否对用户关闭。

## Decision

**交付形态是一个 bundle 包。** `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`、版本 `0.1.0`、`files: [lib, cordis.patch.yml, README.md, LICENSE]`，并保持 `private: true`。`cordis.patch.yml` 只做一行 `insert`：`id: dsh-cowork`、`name: '@dsh-external/dsh-cowork'`，行名与工具、preset、client 共用同一实例；`tools/`、`tests/`、`docs/`、`.dsh-cowork/` 不进包。M4 只承诺本地 tarball 安装（`dsh plugin --profile <p> add ./dsh-external-dsh-cowork-0.1.0.tgz`）；npm 未发布，git 安装不支持。

**preset 持久化保留 runtime registration。** `src/presets.ts` 仍是三个 cowork preset 的唯一事实源；bundle 安装后由宿主 Loader 挂载插件，`apply` 里的 `agentPresets.register` 在重启后稳定生效，dev 注入复用同一份定义。不迁声明式 `@deepseek-ai/dsh-agent-preset` 行，也不把 `agent-preset-registry` 的 `default` 改成 cowork——cowork 是用户在新建会话时显式选择的 workflow。

**正式入口与 dev 探针分离。** `Config` 增加 `enableDevRoutes: z.boolean().default(false)`。默认 `false` 时，`src/index.ts` 不注册 `/dsh-cowork/probe/*` 与 `/dsh-cowork/e2e/*` 路由、不注册 `cowork_probe` / `cowork_identity_probe`、也不挂 M0/S0/M2/M3 runner 的 session 事件监听；11 个业务工具、三个 preset、panel API 与 memory prompt 不受影响。维护者用 profile patch 覆盖 `id: dsh-cowork` 的 `config`（`enableDevRoutes: true`、`repoPath`）跑 installed-profile E2E。

**软链路径在 dev 面规范化。** `src/probe-model.ts` 的 `canonicalRepoPath` 在路径存在时 `realpath`、缺失时原样返回；`src/index.ts` 的 dev 配置用它在启动时规范化 `repoPath`，使 runner 的 fixture、会话 cwd 与证据断言共用同一前缀。业务工具按调用者 cwd 找项目，`repoPath` 只在失败提示里回显为插件默认仓库；只有 dev runner 用它定位 fixture 与证据。

**README 是用户手册。** [README](../../../../README.md) 写安装（build → pack → 新 profile → add → 重启）、选择 preset、使用流程、数据落点、卸载与升级、限制与前提；不再把交接与探针事实写进用户文档。

安装验证路径固定为：新 profile `m4verify`（`--from-default-profile web`，只装本包）→ `--dump-config` 核对层 → 重启 → 默认面 404/401 → dev patch 覆盖后跑 15 步 E2E → 真实 Chrome 面板 → 卸载并确认数据保留。交付事实见 [M4 结果](../../../../docs/M4_RESULT.md)，探针输出见 [M4-P0 探针](../../../../docs/M4_PROBE_RESULT.md)。

## Alternatives considered

**只做 README，继续让用户用 dev 注入。** 否决：重启即消失、client 缓存问题、没有卸载路径，满足不了 PLAN M4 的「只装一个包」。

**把 preset 行直接迁到 bundle patch（M3 交接的原预期）。** 否决：P0 已证 runtime registration 在 bundle 启动加载后重启仍稳定；声明式会复制行清单、把外部 bundle 绑到 DSH 内部子插件包的解析。若宿主升级改变 registry 挂载时机，再以新记录切换。

**发布到 npm 作为 M4 默认出口。** 否决：需要用户授权与 npm 账号；本阶段先验证本地 tarball 安装，npm 发布作为后续动作。

**支持 git 安装（`prepare` 构建）。** 否决：构建依赖 DSH source checkout 的 tsc/esbuild，无法做成自包含 `prepare`；写一个会失败的承诺比不写更糟。若未来提供自包含构建链，再评估。

**把 dev 探针直接删掉。** 否决：M4 自己的 installed-profile E2E 还需要探针/E2E 路由；用默认关闭的 config 分离正式与维护者面，风险更小。彻底拆分 dev entry 留到后续需要时。

**改 `agent-preset-registry` 的 default 为 cowork。** 否决：会改变所有新会话的默认行为；不能替用户做默认选择。

**只把 E2E 的 repoPath 改成 `/private/tmp` 绕过 P0-F1，不改代码。** 否决：软链前缀会让任何维护者在 `/tmp` 下复现同一失败；用一次 `realpath` 规范化加确定性单测，把陷阱固化成可验证行为更小、更稳。

## Consequences

- 现在一个干净 profile 只装 `@dsh-external/dsh-cowork` 一个包，重启后即有 cowork preset、11 个业务工具与右侧栏面板；`--dump-config` 出现 `# == @dsh-external/dsh-cowork` 与 `- id: dsh-cowork`。
- 安装面只有本地 tarball；`private: true`，npm 未发布；git 安装不支持（没有预构建 `lib/`）。升级/重装是 remove 后 add 新 tarball，再重启 profile。
- dev/E2E 面默认关闭：用户装完看不到 `/dsh-cowork/probe/*`、`/dsh-cowork/e2e/*` 与两个探针工具；只有维护者用 profile patch 覆盖 `enableDevRoutes`。默认面实测 `/dsh-cowork/probe/*` 与 `/dsh-cowork/e2e/*` 全 404、`/api/cowork.overview` 401。
- 卸载只移除 bundle 层，`.dsh-cowork` 数据保留；旧会话 header 仍记 cowork preset，而定义随包消失，恢复会失败——README 要求卸载前归档/导出。
- 验证会写共享 `~/.dsh`：E2E 会话只被 runner 归档、不删除；验证 profile `m4verify` 在收口时删除，不留在用户环境里。
- `lib/**` 整目录进包，`.js.map` 随行；当前接受，需要缩小体积时再改 `files` 或构建。
- 重估触发：宿主升级改变 preset registry 挂载时机（重跑 P0 并评估声明式）；`client-modules` 的 pkgMeta 缓存提供可失效扫描或正式安装路径也复现 client 不加载（重评 KI-11）；npm 发布或合并 `main` 需要用户明确授权，届时另写发布记录而不是改写本记录。

## Testing

- [M4A1] bundle 在干净 profile 中安装成功，`--dump-config` 出现 cowork 层与 `id: dsh-cowork`，patch 不改变 base/web 既有行 — `packaging`
- [M4A2] 重启后三个 cowork preset 可选、工具面正确（reviewer 无 `tool-fs`）、`sessionController.create({agentPreset:'cowork-master'})` 的 header 正确 — `source`, `tests`
- [M4A3] 安装后的 client 在真实 Chrome 加载，底栏/tab/面板可用，无 dev 注入、无同进程缓存例外 — `source`, `packaging`
- [M4A4] 安装后的 profile 跑通真实 flow：project init、thread、handoff、review verdict、`needs_revision` 退回、pass 合并；证据含 profile、sessionId、review 文件与索引快照 — `tests`, `packaging`
- [M4A5] 卸载移除 bundle 层、保留 `.dsh-cowork` 数据；旧会话 preset 不可恢复写进用户文档 — `source`, `publication`
- [M4A6] `enableDevRoutes=false` 时探针/E2E 路由与两个探针工具不注册；置 `true` 可跑 M4 E2E；dev `repoPath` 在软链前缀下断言稳定 — `source`, `tests`
- [M4A7] `files` 只含 lib/patch/README/LICENSE；`npm pack` 产物可安装；git install 不支持与 npm 未发布都写清 — `packaging`, `publication`
- [M4A8] README/M4 结果/探针/交接、PLAN/KNOWN_ISSUES/publish 分类完成；四条命令通过；独立 reviewer pass — `publication`, `packaging`
