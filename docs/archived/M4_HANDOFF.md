# M4 交接：已完成交付与下一会话 runbook

- 状态：**已完成（2026-11-07，`feat/m4-packaging`）**。M4A1–A7 的证据在 [M4 结果](M4_RESULT.md)；M4A8 的文档同步与本轮独立 verifier/reviewer 结论由收口 marker `.dsh-cowork/e2e/M4_DOCS_READY.json` 记录。本文只拥有「最终基线、怎样复核、从哪开始 M5、回滚」。
- 事实源：[PLAN](../PLAN.md) §6 M4/M5 拥有范围与验收；[M4 决策](../../.agents/notes/implemented/feature/2026-11-05-m4-packaging.md) 拥有分发形态、preset 与 dev 门的选择；[M4 结果](M4_RESULT.md) 拥有交付面、逐条证据与限制；[M4-P0 探针](M4_PROBE_RESULT.md) 拥有探针原始输出；[README](../../README.md) 拥有面向用户的安装/使用/卸载；[KNOWN_ISSUES](../KNOWN_ISSUES.md) 拥有不修项。

## 最终基线

- 分支：`feat/m4-packaging`，从 `fix/m3-closeout` 的 `5622759` 开；关键提交 `914f997`（bundle 层）、`9451efc`（packaging 契约测试）、`d3751ed`（dev 门 + `canonicalRepoPath`）、`46de4e3`（README 手册），其后是文档收口提交。最终 HEAD 以收口 marker 的 `commit` 为准。
- 包：`@dsh-external/dsh-cowork@0.1.0`，`private: true`；`npm pack` 产物 `dsh-external-dsh-cowork-0.1.0.tgz`，78 个文件，只含 `lib/**`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`。
- 四条命令：`npm run check` exit 0；`npm test` 346/346；`npm run typecheck` exit 0；`npm run build` exit 0（`lib/client.js` 69 KB）。
- 真实安装：profile `m4verify`（`--from-default-profile web`，只装本包），installed-profile E2E runId `m3-d5e44800-91d0-41d7-a6f6-e80a9ac5213e`，15/15，`host.pluginVersion=0.1.0`。证据与限制见 [M4 结果](M4_RESULT.md)。
- 未动：用户 `web`/`desktop` profile、`main` 分支、npm registry。

## 可安装面与数据落点

- 安装、选择 preset、使用流程、数据落点、卸载与升级、限制：见 [README](../../README.md)。本文不复制这些事实。
- 一句话形态：装一个 bundle，`cordis.patch.yml` 插一行 `id: dsh-cowork`；项目数据只落 `<repo>/.dsh-cowork/`，插件不写 `~/.dsh` 的项目状态。

## 维护者验证步骤（全新 profile，按序）

1. `npm run build && npm pack`，确认产物清单只含 lib/patch/README/LICENSE/package.json（`tests/packaging.test.mjs` 也钉住这条）。
2. 建 profile：`dsh --profile <name> --from-default-profile web --dump-config`；目标名必须不存在。
3. 安装：`dsh plugin --profile <name> add ./dsh-external-dsh-cowork-0.1.0.tgz`。
4. 核对层：`dsh --profile <name> --dump-config | grep -A2 '@dsh-external/dsh-cowork'`，应出现 `# == @dsh-external/dsh-cowork` 与 `- id: dsh-cowork`。
5. 重启该 profile（新进程），打开启动日志里的带 token URL，新建会话选 `cowork-master`。
6. 默认面（产品默认）：`curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:<port>/dsh-cowork/probe/health` 应为 **404**；`/dsh-cowork/e2e/m3/status?runId=x` 为 **404**；`/api/cowork.overview` 无浏览器信任时为 **401**（不是 404）。
7. dev 面（维护者）：给该 profile 的 `cordis.patch.yml` 追加下面这段并重启，然后 `POST /dsh-cowork/e2e/m3/run`（loopback only），轮询 `GET /dsh-cowork/e2e/m3/status?runId=…` 到 `state=done`；证据落 `<repoPath>/.dsh-cowork/e2e/M3_E2E.json`。

   ```yaml
   - id: dsh-cowork
     config:
       enableDevRoutes: true
       repoPath: /private/tmp/m4-e2e
   ```

8. 面板：真实 Chrome 打开同一宿主，确认底栏「打开 Cowork 面板」、tab 与面板来自已安装包；旧进程不算数。
9. 卸载：`dsh plugin --profile <name> remove @dsh-external/dsh-cowork`，确认 bundles 回到 base + web-app、`.dsh-cowork` 数据保留。
10. 收尾：删除自己创建的 profile（`~/.dsh/profiles/<name>`）；测试会话已由 runner 归档，不要再写进用户会话列表。仓库内不提交运行证据（`.dsh-cowork/` 已 gitignore）。

## 陷阱

- **P0-F1 已修**：`canonicalRepoPath` 会把 dev 的 `repoPath` 规范成真实路径（`/tmp` → `/private/tmp`）。不要把 E2E `repoPath` 写回 `/tmp` 来「绕开」——测试会再次红；用真实路径或让插件规范化。
- **KI-11 只在 dev 注入器路径**：安装 + 重启路径不复现 client 缓存问题；dev `dev_reload_package` 换同名包仍可能加载不到 client（KI-11 更新后仍成立）。验证 client 一律重启 + 新进程。
- **共享 home**：所有 profile 共用 `~/.dsh`；测试会读到用户会话列表。不要把测试包装进 `web`，不要在用户 profile 里跑 E2E；收尾删自己建的 profile。
- **不要把测试装进用户正在用的 profile**：`dsh plugin add` 改依赖与 bundles，必须重启才生效，也难回滚。
- **npm 发布与合并 `main` 都需要用户明确授权**；`private: true` 是当前承诺，tarball 安装是唯一验证过的路径；git 安装拿不到预构建 `lib/`。
- **旧会话卸载后失效**：preset 定义随包消失，恢复旧会话会失败；卸载前归档/导出（README 已写）。
- **不要让 M4 的 dev 面默认打开**：`enableDevRoutes=false` 是产品默认；只有维护者用 profile patch 覆盖。
- **交付物不含运行证据**：`.dsh-cowork/e2e/` 与截图都是 gitignored；文档只写路径，不提交原始数据。

## M5 起点

- 范围与验收见 [PLAN](../PLAN.md) §6 M5：记忆去重/合并/更新/删除、按相关性装填预算、可选语义检索适配器与可复现评测集。
- 起点事实：M2 的追加式 `memory/*.md`、`cowork_memory_write/search`、`src/memory.ts` 与 `src/memory-prompt.ts` 是迁移基线；KI-2 记录当前限制与重估触发。
- 先写 `.agents/notes/proposed/` 决策记录（方案、替代方案、评测口径），再动实现；M5 不改变 M4 的安装面，除非有新的决策记录。

## 回滚

- 代码：按提交 revert M4 的 bundle 层、dev 门、README 与本文档提交；`main` 未动。
- 安装：`dsh plugin --profile <name> remove @dsh-external/dsh-cowork`，再删 profile；不动 `web`/`desktop`。
- 数据：`.dsh-cowork` 不随包删除；索引 version 仍为 1，回滚代码不清数据。
- 运行时回退：`dev_inject_plugin /Users/ray/Workspace/dsh-cowork` 只作为开发期回退，不是验收路径。
