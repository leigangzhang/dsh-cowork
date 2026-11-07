# M4-P0 探针结果（安装、持久化、client、dev 门）

- 状态：**进行中（2026-11-07）**。P0 第 1–6 项已完成并有原始输出；第 7 项（默认 config 下探针/E2E 路由不可见）依赖 P2 的 `enableDevRoutes`，完成 P2 后在本文件补验。
- 环境：分支 `feat/m4-packaging`（从 `fix/m3-closeout` 的 `5622759` 开）；DSH `0.2.1-rc.2`、Desktop `2.0.18`、node `v22.22.1`、darwin arm64；用户宿主 `http://127.0.0.1:3080`（`web` profile，dev 注入）；探针宿主 `http://127.0.0.1:3091`（`m4probe`，独立进程）；DSH source checkout `/Users/ray/Workspace/deepseek-harness`。
- 本文只拥有 P0 的命令、输出与结论；分发形态与验收在 [M4 提案](../../../.agents/notes/proposed/feature/2026-11-05-m4-packaging.md)；交付事实在 `docs/M4_RESULT.md`。

## 前置门（M3-FIX）

- 代码/证据基线：M3-FIX 最终提交 `51bbeb1`（marker `.dsh-cowork/e2e/M3_DOCS_READY.json`），HEAD `5622759`。
- `node tools/check-evidence-marker.mjs` 报 `marker.commit 51bbeb1 does not match HEAD 5622759`。`git diff --stat 51bbeb1..HEAD` 只含 `AGENTS.md`、`docs/AGENTTEAM_INTEGRATION_RULES.md`、`.agents/notes/process/2026-11-06-*.md`、`docs/publish.json`，即 3 个 docs-only 提交；M3 代码字节未变。结论：时序失配，不是 M3 回归；M4 另写 marker，不复用 M3 证据。
- 基线四条命令（工作树在 `feat/m4-packaging` 开分支前）：`npm run check` exit 0、`npm test` 330/330、`npm run typecheck` exit 0、`npm run build` exit 0（`lib/client.js` 69 KB）。
- 环境噪声：本地未跟踪、已 gitignore 的 `.marklingo/zh-CN/*.md` 使 publish 检查红；已移到 `/tmp/m4-marklingo-backup-1794039558`（未删除）后四条命令全绿。该目录不属于仓库变更。

## P0-1 最小 hello bundle（bundle patch 机制）

- 目录 `/tmp/m4-p0/hello-bundle`：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入 `id: m4probe-hello`，`index.js` 注册 loopback 路由 `/m4probe-hello/health`。
- `dsh --profile m4probe --from-default-profile web --dump-config` exit 0；`~/.dsh/profiles/m4probe/package.json` 的 bundles 为 `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`。
- `dsh plugin --profile m4probe add /tmp/m4-p0/hello-bundle` exit 0；profile dependencies 增加 `link:/tmp/m4-p0/hello-bundle`，bundles 追加 `m4probe-hello-bundle`。
- `dsh --profile m4probe --dump-config | grep`：出现 `# == m4probe-hello-bundle` 与 `- id: m4probe-hello` / `name: m4probe-hello-bundle`。
- 新进程 `dsh --profile m4probe --port 3091 --no-open` 启动后 `GET /m4probe-hello/health` 返回 `{"ok":true,"bundle":"m4probe-hello-bundle"}`：patch 行被 Loader 装配并执行。
- 用户 `web` profile 未被修改（`~/.dsh/profiles/web/package.json` 与 `cordis.patch.yml` 无变化）。

## P0-2 真包打包与安装

- `package.json` 临时加 `dsh.bundle.patch`、`files: [lib, cordis.patch.yml, README.md, LICENSE]`、版本 `0.1.0`；新增 `cordis.patch.yml`（`insert: [{id: dsh-cowork, name: '@dsh-external/dsh-cowork'}]`）。这是 P1 的最小骨架，P1 再补测试/文档校验。
- `npm run build` exit 0；`npm pack --json` exit 0 → `dsh-external-dsh-cowork-0.1.0.tgz`，248,608 B，78 个文件；全部落在 `lib/`（含 `.js.map`）、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`。
- `dsh plugin --profile m4probe add ./dsh-external-dsh-cowork-0.1.0.tgz` exit 0；pnpm 提示 peer dependency warning，但安装与运行均正常（peer 由宿主安装提供）。profile bundles 追加 `@dsh-external/dsh-cowork`。
- `--dump-config` 出现 `# == @dsh-external/dsh-cowork` 与 `- id: dsh-cowork` / `name: '@dsh-external/dsh-cowork'`。
- profile patch 写入 `- id: dsh-cowork config: {repoPath: /tmp/m4-e2e}` 后重启（新进程）：
  - `GET /dsh-cowork/probe/health` → `{"ok":true,"plugin":"@dsh-external/dsh-cowork","version":"0.1.0","repoPath":"/tmp/m4-e2e",...}`，证明插件从已安装包加载且 profile 覆盖生效；
  - `GET /api/cowork.overview` → 401（路由已注册，trust fence 生效，不是 404）；
  - `GET /dsh-cowork/e2e/m3/status?runId=x` → 404（未知 runId；路由此时仍注册）。

## P0-3 preset 持久化与 LLM/账号

- 在 3091 上 `POST /dsh-cowork/e2e/m3/run` → `runId=m3-804b002d-7f57-4b06-a3c7-5e8f53a01362`。
- 步进结果：`setup`、`thread-a-create`、`thread-a-work`、`review-a-request` 通过；`review-a-pass` 失败（见 P0-F1）；run 终态 `failed`，证据 `/tmp/m4-e2e/.dsh-cowork/e2e/M3_E2E.json`（32,093 B），fixture 已由 `finally` 删除。
- 已证：`cowork-master` / `cowork-reviewer` 在重启后的新进程里可注册并被 `sessionController.create` 选中（setup 断言 `agentPreset=cowork-master` 通过）；真实 LLM 在 `m4probe` 内完成 thread 工作与 reviewer verdict（A 线的 work/request 步通过）；**runtime registration 在 bundle 启动加载后重启仍稳定**。
- 未证：完整的 15 步 flow；待 P2 修 P0-F1 后在最终 installed-profile E2E 补。

## P0-4 client 加载（真实 Chrome）

- 全新宿主进程（3091）+ 从已安装包加载后，真实 Chrome 打开 3091 的启动 URL：底栏出现「打开 Cowork 面板」；点击后出现 `tab "Cowork 关闭"`、`sectionheader "Cowork"`、空态文案「这个仓库还没有 Cowork 项目 / 在 cowork-master 会话中调用 cowork_project_init」。
- 截图：`.dsh-cowork/e2e/m4-p0/01-installed-client-panel-empty.jpg`（2723×1539，gitignored）。
- 结论：client 来自安装包，不依赖 dev 注入；KI-11 的“同进程同名包缓存”在安装 + 新进程路径不复现。旧进程验证不算数。

## P0-F1 软链路径导致 E2E 断言失败（必须修）

- 失败断言：`review-a-pass` — “review file lives under the reviews directory”；实际路径 `/private/tmp/m4-e2e/.dsh-cowork/e2e/m3-repo/.dsh-cowork/reviews/...`，runner 期望前缀 `/tmp/m4-e2e/...`。
- 因果：宿主把会话 cwd 规范化为真实路径（`/private/tmp`），而 `repoPath` 配置保留 `/tmp`；runner 的断言用配置前缀。产品工具按调用者 cwd 解析项目，不受影响。
- 处置：P2 在启动时把 dev/E2E 的 `repoPath` 规范化为真实路径（存在才 realpath），加确定性单测；最终 E2E 在修复后重跑一次，不原样重试同一失败形状。

## P0-F2 共享 home 的验证副作用（收尾必须处理）

- `m4probe` 与用户 `web` 共用 `~/.dsh`：3091 侧栏能读到用户全部会话（约 1.2 MB 列表），E2E 的测试会话也写入共享会话存储；失败 run 的会话已由 runner 归档，但测试会话目录仍在 `~/.dsh/sessions/`。
- 收尾：归档/清理 M4 测试会话，删除 `m4probe` profile；确认 `web`/`desktop` manifest、patch 与真实 `.dsh-cowork` 数据未变。

## P0-F3 本地 .marklingo 噪声

- 未跟踪、已 gitignore 的 `.marklingo/zh-CN/*.md` 触发 `publish-manifest` 红；不属 M4 代码/文档变更，基线期间移出工作区，最终报告说明其位置。
