# Decision: 版本化 E2E harness 与发布证据门禁

Status: implemented
Date: 2026-11-13
Class: testing

## Problem

仓库里唯一跑过真实宿主的链是 `src/dev/m12-e2e*`：它由 `enableDevRoutes` 的 dev route 启动，必须配置真实模型，断言绑在 0.2.0 的 topic / review / merge 流程上；fixture、安装补丁和运行证据放在被 gitignore 的 `.dsh-cowork/e2e/` 里。换机器后这些材料不在仓库中，只能重做。

已有的 lane 各自只证明一部分：browser lane 证明 UI，host smoke 证明加载与健康路由，layered coverage 证明单元覆盖；它们都不证明“真实宿主里 session 被唤醒 → 工具执行 → store 写入 → 面板路由读到”这一条跨进程链。公开面已经是 22 个工具、10 条面板路由、3 个 preset，但没有任何门禁检查这些能力是否被 E2E 场景点名；新增工具、路由或 preset 可以合并而没有任何场景。

## Decision

**`tests/e2e/` 是场景的唯一入口。** `manifest.json` 声明场景 id、mode、summary 和覆盖键，`coverage-debt.json` 记录未覆盖项的排除理由，`scenarios/index.mjs` 是静态 registry（manifest 的 id 必须解析到同名模块），`support/` 提供宿主客户端、脚本化 provider、fixture、catalog 和版本判断。runner 是 `scripts/evidence/e2e.mjs`；`npm run test:e2e` 跑 keyless 场景，`npm run test:e2e:live` 跑观测性真实模型场景；heavy lane 的手动 workflow 也执行 `npm run test:e2e`。`.dsh-cowork/e2e/<run>/` 只保存本次运行输出。

**keyless 运行走真实宿主和公开 provider 配置。** runner 打包当前 `lib/`，用 `scripts/evidence/dsh-host-session.mjs` 在临时 `DSH_HOME` 安装并启动 `dsh web`，通过 `llm-deepseek.baseURL` 把真实 adapter 指向本机脚本化 Anthropic Messages 服务；场景通过宿主 Remote API 创建/唤醒真实会话，用带会话 cookie 的 HTTP 调面板路由。每个场景使用独立 git fixture；等待是状态轮询加 bounded deadline；场景超时会停止整轮，fixture 和宿主不会交给下一场景；临时宿主、profile、fixture 和 npm 缓存都在 `finally` 删除。

**覆盖矩阵从公开面源码推导。** `tools/e2e-coverage.mjs` 从 `tests/support/public-surface.mjs` 取工具和路由、从 `src/platform/presets.ts` 取 preset、从 `src/store/schema.ts` 取生命周期状态。矩阵只列有公开写路径的 work-item 状态；`abandoned` 是 store/panel 可读但没有公开写入口的保留值，排除理由写在检查模块。每个键必须由 keyless 场景覆盖，或在 `coverage-debt.json` 里带 reason 与 exitCondition；live-model 覆盖不计入 keyless 覆盖。

**版本和宿主范围进入 manifest。** `pluginVersion` 必须等于 `package.json.version`；`host.tested` 记录验证过的 DSH 版本，`host.compatibleMajorMinor` 给出兼容的 minor。runner 启动前执行 `dsh --version`：不同 major.minor 直接失败，未测补丁需要显式 `--allow-untested-host`，且 `--record` 拒绝未测宿主。

**发布证据是门禁。** `scripts/evidence/e2e.mjs --record` 在干净 worktree 上写出 `tests/e2e/evidence/<pluginVersion>.json`，只接受完整 keyless manifest；摘要包含插件/DSH/Node 版本、HEAD、worktree diff SHA-256、tarball SHA-256、`tests/e2e/` 内容 SHA-256（不含 `evidence/`）、场景与检查结果。`npm run check` 要求当前版本的摘要存在、绿色、覆盖全部 keyless 场景、目录哈希匹配、DSH 版本在 `host.tested` 中，并且 `artifact.head` 是 HEAD 或其后只有 `tests/e2e/evidence/` 变更的祖先。live-model 结果只写本地证据，不能记录为发布证据。

**当前覆盖范围。** 4 个 keyless 场景共 104 项检查：`master-chain`（初始化、memory、topic 创建/别名、route、status/notices、会话可见性），`topic-panel`（work item、report、decision、authorization、question、plan、user review、overview/activity/topic/resolve/reopen/route.move/authorization.resolve/inbox.resolve、resolved 目标的 follow-up），`review-merge`（work item、review 请求、reviewer 的只读 grep 与 pass verdict、handoff、merge-needed 投递、handoff 文件、merge 与 activity），`review-revision`（needs_revision、修复、二次请求、reject、block 与 review-reject inbox）。`inbox.open` 仍在债务文件：宿主 opener 直接绑定 session controller，没有注入点，headless lane 不应触发原生桌面动作。

## Alternatives considered

**把 `.dsh-cowork/e2e/` 整个提交。** 否决：里面混着机器路径、临时 profile、截图、失败运行和重复证据，无法区分测试代码与运行产物；只提交可复现的场景和去敏摘要。

**继续维护 M12，在文件里加版本注释。** 否决：它绑定 dev route 和 0.2.0 的业务链，要真实模型，且没有机制阻止“新能力没有场景也算绿”。M12 暂留是因为它还有一条本机无法执行的断言，不是因为它是目标形态。

**只做单元/契约测试。** 否决：session 唤醒、工具执行的 store 写入、面板路由和 merge 都是跨进程事实；同进程 mock 不能证明。

**只做真实模型 E2E。** 否决：成本、速度和模型非确定性让主门禁不稳定；keyless 场景必须确定性，真实模型只做观测。

**写一个 DSH 假 LLM provider 插件装进临时 profile。** 否决：这要跟宿主内部的 `ctx.llm.registerAdapter` 契约走，测试会随宿主内部结构漂移；`baseURL` 是 provider 的公开配置，脚本化 Messages 服务走同一条真实 adapter 路径，耦合更小。

**只在测试里维护覆盖清单，不进 `npm run check`。** 否决：PR 只保证检查命令运行；不进检查就等于靠人记得。

**用动态文件路径装载场景。** 否决：场景模块对静态分析不可见，会被判成未使用文件；改为 `scenarios/index.mjs` 的静态 registry 后，manifest 与模块的对应关系由 guard test 双向校验，缺失 id 在启动宿主前失败。

## Consequences

- `npm run check` 现在是发布阻塞门禁：版本升级、新增 keyless 场景、修改 manifest 或场景代码、或在记录 HEAD 之后提交 `tests/e2e/evidence/` 以外的文件，都会让检查变红，直到重新记录。代价是有意的提交顺序：先提交代码，再在干净树上 `--record`，最后单独提交证据文件；证据文件之后的 evidence-only 提交不失效。
- 目录哈希绑定的是 `tests/e2e/` 的内容，不是运行事实；摘要仍可能被手工复制。它要求 review 信任本地运行，门禁只能保证“这份摘要对应这套场景和这个 HEAD”。
- 脚本化 provider 只证明宿主、工具、store 和路由的链路，不证明模型质量或真实工具的语义；真实模型 quality 由 `test:e2e:live` 观测，本机没有 `DEEPSEEK_API_KEY`，该 lane 只验证了 self-skip，未执行真实调用。
- 矩阵证明“被场景点名”，不证明组合、边界值和负面路径；边界仍由 unit/contract 测试承担。
- `inbox.open` 已确认没有安全的 headless 覆盖方式，保留债务条目；只有宿主提供可注入 opener 或允许带用户确认的桌面 lane 时才重新评估。
- M12 dev route 和 `src/dev/m12-e2e*` 未退役：它的“topic 会话用 bash 提交”断言需要可用的 bash sandbox 后端，本机宿主拒绝执行该命令（[KI-46](../../../../docs/KNOWN_ISSUES.md)）。这是退役的前置条件，不是本决策的遗留实现缺口。
- 一个 run 共享一个宿主；场景之间只靠独立 fixture 隔离。超时场景会终止整轮，避免把残留状态解释成下一场景的证据。

## Testing

- [A1] `npm run test:e2e` 从当前 `lib/` 的 tarball 在临时 `DSH_HOME` 启动真实宿主和本机脚本化 Messages 服务，运行 manifest 中的 keyless 场景；成功与失败路径都删除进程、profile、fixture 和缓存，且不读写用户 profile — `e2e`
- [A2] `tests/e2e/manifest.json` 的 `pluginVersion` 与 `package.json` 一致；重复场景、未知公开键、未覆盖且无债务的键、已覆盖或已消失的债务条目、目录哈希不匹配、未测宿主、失效 HEAD 都让 `npm run check` 变红，且 self-test 证明每一类能失败 — `workflow`
- [A6] manifest 的每个场景 id 与 `tests/e2e/scenarios/index.mjs` 的静态 registry 双向对应，未知 id 在启动宿主前失败；guard test 固定该映射 — `tests`
- [A3] 覆盖矩阵从公开面源码推导，逐项列出工具、面板路由、preset、topic / review 状态和有公开写路径的 work-item 状态；每项至少绑定一个 keyless 场景或有带原因和退出条件的债务条目 — `e2e`
- [A4] `npm run test:e2e:live` 以独立 mode 声明，只有显式调用且 `DEEPSEEK_API_KEY` 存在时运行，缺 key 时 self-skip；结果只进本地证据，不计入 keyless 覆盖；真实 provider 执行本机未跑，只有 self-skip 被验证 — `e2e`
- [A5] 绿色 keyless 运行写出 `tests/e2e/evidence/<pluginVersion>.json`，包含场景/检查结果与 artifact identity（HEAD、worktree diff SHA-256、tarball SHA-256、`tests/e2e/` 目录 SHA-256、插件与 DSH 版本），去敏且可从同一版本重新生成；红色或脏工作区运行拒绝记录，`npm run check` 验证摘要 — `e2e`
