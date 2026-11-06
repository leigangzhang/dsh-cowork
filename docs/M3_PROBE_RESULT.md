# M3 P0 探针结果：review 会话闭环与 review 字段

- 结论：两项 P0 中，**review 会话闭环已由真实宿主 E2E 证明**（15/15 步，pass/needs_revision/复审/合并全部落地）；**面板 review 字段的离线契约已由测试证明，真实宿主的数据往返未能在本轮完成**——宿主在装载大量会话后 `/api/session/list` 持续 >60 s 不返回，面板停留在 loading，无法截取带 review 状态的截图。客户端能力本身已由 M2 面板交付并证明，本轮额外确认了临时改名包能让 client bundle 在真实 Chrome 中加载。
- 适用：M3 交付证据；面板真机限制同时写在 [M3 结果](M3_RESULT.md) 与 [KNOWN_ISSUES](KNOWN_ISSUES.md)。
- 环境：DSH Desktop 2.0.18 / 运行时 0.2.1-rc.2，web profile `http://127.0.0.1:3080`；插件 `@dsh-external/dsh-cowork` 以 `dev_inject_plugin` 注入；真实 Chrome 由 BrowserSkill 驱动。

## P0-1：review 会话闭环（通过）

真实宿主 E2E（`M3_E2E.json`，run `m3-d06cc6a6-3a97-4d3d-8cfc-92a2220ad1f7`）覆盖：

1. master 收到 thread A handoff 后由 **master 自己**调用 `cowork_review_request`（t8 人格更新后的真实行为；E2E 用 `planReviewRequest` 幂等 adopt，而不是重复请求）。
2. reviewer 会话由 `session-create` 创建、preset `cowork-reviewer` 挂载、收到 review brief；reviewer 实际运行 `test -f e2e-a.txt` 并调用 `cowork_review_verdict` verdict=pass。
3. 索引 `reviewStatus=pass`、thread `done`，review 文件先写入 `<repo>/.dsh-cowork/reviews/`，再写索引指针；master 随后 `cowork_checkout_merge` 成功，主仓出现 `e2e-a.txt`，merge commit `2aa02856…`。
4. thread B 首轮 review 返回 `needs_revision`（finding `M3-E2E-1`），索引回到 `active`，findings 由 host 投递给原 thread；thread 修复后重新 handoff，第二轮 review pass，合并 commit `6981bb94…`，主仓 `e2e-b.txt=M3-E2E-FIXED`。
5. cleanup 记录 3 个 reviewer session、review 文件原文、最终索引与两个合并 commit，`tempRepoRemoved=true`。

结论：独立会话、verdict 写入、状态路由、findings 投递、复审与合并门禁在真实宿主上成立；不是同进程 mock。

## P0-2：面板 review 字段（部分通过）

- **离线契约（通过）**：`tests/api-contract.test.mjs`、`tests/api.test.mjs`、`tests/panel-model.test.mjs` 覆盖 `/api/cowork.overview` 的 `reviewStatus/reviewedAt/reviewerSessionId`、`/api/cowork.handoff` 的 `review:{record,filePath}|null`、缺字段/坏指针/文件删除的降级，以及徽章标签与 tone。
- **真实客户端（部分通过）**：本仓库的 client bundle 在真实 Chrome 中加载后，底栏出现「打开 Cowork 面板」，右侧栏 `Cowork` tab 能打开并渲染 header / loading 骨架；但使用**同名包**时宿主 `client-modules` 的 pkgMeta 缓存不失效，boot 列表里没有本插件（`__DSH_BOOT__.entries` 81 项、无 cowork）。临时改名包 `@dsh-external/dsh-cowork-m3panel`（同一份源码、只改包名与 client loader id）重新构建后可以加载——与 [PANEL_RESULT](PANEL_RESULT.md) 记录的缓存限制一致。
- **真实数据往返（未通过）**：改名包加载后，面板发出 `/api/cowork.overview`，但宿主 `/api/session/list` 自 20:04 起单次 >60 s 不返回（此前一次约 40 s、响应 1.2 MB），同一时刻 `/api/cowork.overview` 与 `/api/cowork.handoff` 均超时，面板停留在「正在读取 Cowork 项目…」。这不是面板代码错误，而是宿主会话列表解析在大量会话/高负载下失去可用性；本轮无法据此截图或宣称面板数据往返已验证。

## 失败与经验（写进 M3 结果与 KNOWN_ISSUES）

1. **同名包 client 不生效**：同进程内 `client-modules` 按 loader name + baseUrl 缓存 pkgMeta，同名重注入不会重解析 `dsh.client`；临时改名包是已验证的绕过方式。
2. **profile patch disabled 会再次压制注入 entry**：`dev_uninject_plugin` 写的 `- id: dsh-cowork disabled: true` 会让 client-modules 跳过该 entry；本轮临时移除该条目后才重新注册 client。交付路径（正式安装/重启）不受此 runtime 注入路径影响。
3. **失败 E2E 会留下 Markdown 夹具**：`.dsh-cowork/e2e/m3-repo` 的 README 会让 `npm run check`/publish 测试变红；重跑仓库检查前先清理。
4. **宿主 API 在大量会话下不可用**：`sessionController.list()` 是面板定位项目的唯一入口；当前实现没有超时/降级，面板会无限 loading。

## 证据

- E2E 证据：`.dsh-cowork/e2e/M3_E2E.json`（run `m3-d06cc6a6-3a97-4d3d-8cfc-92a2220ad1f7`，state=done，15/15 passed）。
- 面板离线契约：`npm test`（309/309）；`tests/api-contract.test.mjs`、`tests/api.test.mjs`、`tests/panel-model.test.mjs`。
- 真机部分证据：Chrome 控制台出现 `@dsh-external/dsh-cowork-m3panel/client.js&rev=…`；页面出现底栏「打开 Cowork 面板」与 `Cowork` tab；`__DSH_BOOT__.entries` 无同名包、有改名包；`/api/session/list` 与 `/api/cowork.*` 超时的 performance/计时记录未落盘（浏览器会话已关闭），如实标为未核实。
