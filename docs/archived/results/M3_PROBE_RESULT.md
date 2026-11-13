# M3 P0 探针结果：review 会话闭环与 review 字段

- 结论：两项 P0 都已通过。**review 会话闭环**由真实宿主 E2E 证明（15/15 步，pass/needs_revision/复审/合并全部落地）；**面板 review 字段**在重启宿主并 clean re-inject 后，由真实 Chrome 取得分栏与 ≤480 两档截图，overview/handoff 都来自真实宿主（fixture 只替换项目数据）。早先“面板 API 悬挂”的根因是 reload 留下旧 fiber，不是面板代码或磁盘延迟。
- 适用：M3 交付证据；面板真机限制同时写在 [M3 结果](M3_RESULT.md) 与 [KNOWN_ISSUES](../../KNOWN_ISSUES.md)。
- 环境：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2，web profile `http://127.0.0.1:3080`；插件 `@dsh-external/dsh-cowork` 以 `dev_inject_plugin` 注入；真实 Chrome 由 BrowserSkill 驱动。

## P0-1：review 会话闭环（通过）

真实宿主 E2E（`M3_E2E.json`，run `m3-d06cc6a6-3a97-4d3d-8cfc-92a2220ad1f7`）覆盖：

1. master 收到 thread A handoff 后由 **master 自己**调用 `cowork_review_request`（t8 人格更新后的真实行为；E2E 用 `planReviewRequest` 幂等 adopt，而不是重复请求）。
2. reviewer 会话由 `session-create` 创建、preset `cowork-reviewer` 挂载、收到 review brief；reviewer 实际运行 `test -f e2e-a.txt` 并调用 `cowork_review_verdict` verdict=pass。
3. 索引 `reviewStatus=pass`、thread `done`，review 文件先写入 `<repo>/.dsh-cowork/reviews/`，再写索引指针；master 随后 `cowork_checkout_merge` 成功，主仓出现 `e2e-a.txt`，merge commit `2aa02856…`。
4. thread B 首轮 review 返回 `needs_revision`（finding `M3-E2E-1`），索引回到 `active`，findings 由 host 投递给原 thread；thread 修复后重新 handoff，第二轮 review pass，合并 commit `6981bb94…`，主仓 `e2e-b.txt=M3-E2E-FIXED`。
5. cleanup 记录 3 个 reviewer session、review 文件原文、最终索引与两个合并 commit，`tempRepoRemoved=true`。

结论：独立会话、verdict 写入、状态路由、findings 投递、复审与合并门禁在真实宿主上成立；不是同进程 mock。

## P0-2：面板 review 字段（通过）

- **离线契约（通过）**：`tests/api-contract.test.mjs`、`tests/api.test.mjs`、`tests/panel-model.test.mjs` 覆盖 `/api/cowork.overview` 的 `reviewStatus/reviewedAt/reviewerSessionId`、`/api/cowork.handoff` 的 `review:{record,filePath}|null`、缺字段/坏指针/文件删除的降级，以及徽章标签与 tone。
- **真实客户端（部分通过）**：本仓库的 client bundle 在真实 Chrome 中加载后，底栏出现「打开 Cowork 面板」，右侧栏 `Cowork` tab 能打开并渲染 header / loading 骨架；但使用**同名包**时宿主 `client-modules` 的 pkgMeta 缓存不失效，boot 列表里没有本插件（`__DSH_BOOT__.entries` 81 项、无 cowork）。临时改名包 `@dsh-external/dsh-cowork-m3panel`（同一份源码、只改包名与 client loader id）重新构建后可以加载——与 [PANEL_RESULT](PANEL_RESULT.md) 记录的缓存限制一致。
- **真实数据往返（通过）**：重启宿主、clean uninject/re-inject 之后，原包 client 加载；应用 fixture 后 `/api/cowork.overview` 返回 5 个 thread、chips 与 review 字段，点击 needs_revision thread 后 `/api/cowork.handoff` 返回 handoff + review 记录，面板显示 findings、reviewer 验证与 review 文件路径。此前同一 API 的悬挂是旧 fiber 造成的：`dev_reload_package` 没有换掉服务实例，clean re-inject 后同一进程立即恢复。截图见 [M3 结果](M3_RESULT.md)。

## 失败与经验（写进 M3 结果与 KNOWN_ISSUES）

1. **同名包 client 不生效**：同进程内 `client-modules` 按 loader name + baseUrl 缓存 pkgMeta，同名重注入不会重解析 `dsh.client`；临时改名包是已验证的绕过方式。
2. **profile patch disabled 会再次压制注入 entry**：`dev_uninject_plugin` 写的 `- id: dsh-cowork disabled: true` 会让 client-modules 跳过该 entry；本轮临时移除该条目后才重新注册 client。交付路径（正式安装/重启）不受此 runtime 注入路径影响。
3. **失败 E2E 会留下 Markdown 夹具**：`.dsh-cowork/e2e/m3-repo` 的 README 会让 `npm run check`/publish 测试变红；重跑仓库检查前先清理。
4. **旧 fiber 与大会话列表都会拖慢面板 API**：`sessionController.list()` 是面板定位项目的唯一入口，没有超时/降级；宿主会话列表约 1.2 MB、冷启动约 17 s，reload 留下的旧 fiber 会让请求更久不返回。clean re-inject 是已验证的恢复方式（KI-12）。

## 证据

- E2E 证据：`.dsh-cowork/e2e/M3_E2E.json`（run `m3-d06cc6a6-3a97-4d3d-8cfc-92a2220ad1f7`，state=done，15/15 passed）。
- 面板离线契约：`npm test`（309/309）；`tests/api-contract.test.mjs`、`tests/api.test.mjs`、`tests/panel-model.test.mjs`。
- 真机证据：Chrome 中出现底栏「打开 Cowork 面板」；fixture 下 overview 返回 5 个 thread 与 chips，列表显示「审查中/已拒绝/需修改/审查通过」，needs_revision 详情显示 findings 与 review 文件；截图 `.dsh-cowork/e2e/panel-m3/01-split-review-states.jpg`、`02-drill-list.jpg`、`03-drill-needs-revision.jpg`。
