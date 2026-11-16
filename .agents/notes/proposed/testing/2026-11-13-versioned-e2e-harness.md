# Proposal: 版本化、可移植、覆盖可查的 E2E harness

Status: proposed
Date: 2026-11-13
Revised: 2026-11-16
Class: testing

## Problem

当前唯一跑过真实宿主的链是 `src/dev/m12-e2e*`。它由 `enableDevRoutes` 打开的 dev route 启动，必须配置真实模型，断言的是 0.2.0 的 topic / review / merge 流程；它的 fixture、安装补丁、截图和证据放在被 gitignore 的 `.dsh-cowork/e2e/` 里。换一台机器，这些材料不在仓库中，只能重做。

写提案之后 main 已经变了几轮，缺口没有缩小：

- 源码按层迁移，M2/M3 的老驱动已经退役，M12 驱动仍留在 `src/dev/`；公开面已经是 22 个工具、10 条面板路由、3 个 preset，但 `npm run check` 看不到任何一项是否被 E2E 场景覆盖。
- 已有 browser lane、host smoke 和 layered coverage，分别证明 UI、加载与单元覆盖；它们都不证明“真实宿主里 session 被唤醒 → 工具执行 → store 写入 → 面板路由读到”这一条跨进程链。
- `docs/testing.md` 仍把 M12 dev route 当作唯一的真实主机 lane。新工具、新路由、新 preset 或新生命周期分支可以合并而没有任何场景；M12 自己也只能人工运行。
- `.dsh-cowork/e2e/` 没有可复现的版本身份，也没有去敏摘要；发布时无法回答“这个版本跑过哪些公开能力”。

## Proposal

**1. 场景、fixture 和 manifest 进 git，`.dsh-cowork/e2e/` 只存本次运行输出。** `tests/e2e/` 是唯一入口：`manifest.json` 声明场景，`scenarios/` 放可执行场景，`support/` 放宿主、fixture、脚本化 provider 和断言辅助。启动/清理复用 `scripts/evidence/dsh-host-session.mjs`；`.dsh-cowork/e2e/` 保存原始运行证据，可以随时删除，不是任何测试逻辑的唯一副本。迁移时逐文件审查旧目录，只搬可复现的代码，不搬机器路径、token 和旧截图。

**2. keyless 模型走公开 provider 配置，不新增产品测试钩子。** 每次运行先 `npm pack` 当前 `lib/`，在临时 `DSH_HOME` 里安装并启动一个 `dsh web`，再用 `llm-deepseek.baseURL` 指向本机脚本化 Anthropic Messages 服务。真实 adapter、重试、SSE 翻译和 agent loop 原样运行，只有 provider 字节是脚本。场景通过宿主 Remote API（`session/create`、`session/prompt`）创建和唤醒真实会话，通过带会话 cookie 的 HTTP 调面板路由，用状态轮询和 bounded deadline 等待，不用固定 sleep；每个场景使用独立 git fixture，运行结束删除 fixture、profile、缓存和进程。

**3. 覆盖矩阵从公开面自动推导。** 工具和路由取 `tests/support/public-surface.mjs`，preset 取 `src/platform/presets.ts`，生命周期状态取 `src/store/schema.ts`；`tools/e2e-coverage.mjs` 生成键并与 manifest 比较。矩阵只列有公开写路径的状态：`abandoned` 是 store/panel 可读但没有公开 abandon 动作的保留值，排除它的理由写在检查模块里，新增状态仍会自动进入矩阵。每个公开键必须被至少一个 keyless 场景覆盖，或在 `tests/e2e/coverage-debt.json` 记录原因和退出条件；live-model 场景不计入 keyless 覆盖。新增公开键没有场景或债务条目时 `npm run check` 变红；债务条目被覆盖或指向已删除的键时同样变红。这条检查不把单元行覆盖率当行为覆盖率。

**4. 版本和宿主范围是 manifest 的一部分。** `pluginVersion` 必须等于 `package.json.version`；`host.tested` 记录实际验证过的 DSH 版本，`host.compatibleMajorMinor` 给出同一 minor 的兼容范围。runner 启动前执行 `dsh --version`，超出范围明确失败，同 minor 未测版本给出警告并记入证据。版本变更但不更新 manifest 时检查变红。

**5. 证据可移植，且有版本身份。** runner 在 `.dsh-cowork/e2e/<run>/` 写原始证据（场景、检查、模型调用）和 `summary.json`；成功运行可 `--record` 写出 `tests/e2e/evidence/<pluginVersion>.json`。摘要只含脱敏字段：插件版本、DSH 和 Node 版本、HEAD、worktree diff SHA-256、tarball SHA-256、场景与检查结果；不含 hostname、token、cookie 或绝对用户路径。`npm run check` 要求当前版本存在摘要、摘要为绿色、干净 worktree、且包含 manifest 的全部 keyless 场景，所以版本升级或新增 keyless 场景必须重新记录。live-model 运行只写本地证据，`--record` 拒绝它。

**6. 分阶段替换 M12。** keyless lane 先覆盖 master / topic / panel / review / merge 的公开行为，连续稳定后再把 keyless 场景提升为发布阻塞；live-model 场景独立标记、无模型 self-skip，只做质量观测。覆盖 M12 现有断言后，删除 `src/dev/m12-e2e*` 和 M12 的 dev 路由，只保留 host smoke 需要的 health route；旧 `.dsh-cowork/e2e` 摘要只作历史证据，不再作为验收入口。

## Alternatives considered

**把 `.dsh-cowork/e2e/` 整个提交。** 否决：里面混着机器路径、临时 profile、截图、失败运行和重复证据，无法区分测试代码与运行产物；只提交可复现的场景和去敏摘要。

**继续维护 M12，在文件里加版本注释。** 否决：它绑定 dev route 和 0.2.0 的业务链，要真实模型，且没有任何机制阻止“新能力没有场景也算绿”。

**只做单元/契约测试。** 否决：session 唤醒、工具执行的 store 写入、面板路由和 merge 都是跨进程事实；同进程 mock 不能证明。

**只做真实模型 E2E。** 否决：成本、速度和模型非确定性会让主门禁不稳定，也无法在 PR 环境固定复现。

**写一个 DSH 假 LLM provider 插件装进临时 profile。** 否决：这要跟宿主内部的 `ctx.llm.registerAdapter` 契约走，测试会随宿主内部结构漂移；`baseURL` 是 provider 的公开配置，脚本化 Messages 服务走同一条真实 adapter 路径，耦合更小。

**只在测试里维护覆盖清单，不进 `npm run check`。** 否决：PR 只保证检查命令运行；不进检查就等于靠人记得。

## Acceptance criteria

- [A1] `npm run test:e2e` 从当前 `lib/` 的 tarball 在临时 `DSH_HOME` 启动真实宿主和本机脚本化 Messages 服务，运行 manifest 中的 keyless 场景；成功与失败路径都删除进程、profile、fixture 和缓存，且不读写用户 profile — `e2e`
- [A2] `tests/e2e/manifest.json` 的 `pluginVersion` 与 `package.json` 一致；未知/重复场景、缺失场景文件、未知公开键、未覆盖且无债务的公开键、已覆盖或已消失的债务条目都让 `npm run check` 变红，且 self-test 证明每一类能失败 — `workflow`
- [A3] 覆盖矩阵从公开面源码推导，逐项列出 22 个工具、10 条面板路由、3 个 preset、topic / review 状态和有公开写路径的 work-item 状态；每项至少绑定一个 keyless 场景或有带原因和退出条件的债务条目；缺口能定位到键名 — `e2e`
- [A4] `npm run test:e2e:live` 以独立 mode 声明，只有显式调用且 `DEEPSEEK_API_KEY` 存在时运行，缺 key 时 self-skip；结果只进本地证据，不计入 keyless 覆盖，也不冒充确定性结果 — `e2e`
- [A5] 绿色 keyless 运行可写出 `tests/e2e/evidence/<pluginVersion>.json`，包含场景/检查结果与 artifact identity（HEAD、worktree diff SHA-256、tarball SHA-256、插件与 DSH 版本），去敏且可从同一版本重新生成；红色或脏工作区运行拒绝记录，`npm run check` 验证该摘要 — `e2e`

## Risks

- 脚本化 provider 与真实模型行为不同；keyless lane 证明宿主、工具、store 和路由链路，不证明模型质量或真实工具的语义正确性。
- 宿主 Remote API 和 prompt/preset 行为会随 DSH 版本变化；manifest 声明 tested 版本，runner 在范围外明确失败，升级要显式改 manifest。
- 每个场景启动真实宿主可能很慢；当前一次运行共享一个宿主、每个场景独立 fixture，失败重试不能掩盖状态依赖。
- 覆盖矩阵只证明“被场景点名”，不证明组合、边界值和负面路径；这些仍由 unit/contract 测试承担。
- 债务条目会腐烂；`npm run check` 已让“被覆盖后仍留债”和“指向已删除键”变红，但原因是否诚实仍要 review。
- 在 M12 parity 之前删除 dev route 会失去真实模型路径；因此退役必须作为显式阶段，不能随本提案一起做。

## Delivery stages

1. 建立 `tests/e2e/` 场景与 manifest、脚本化 Messages provider、临时宿主 runner、覆盖矩阵检查和债务文件；先覆盖 master chain、topic/panel 链和 review/merge 链，跑通绿色证据。
2. 补齐剩余可写公开状态（needs_revision、reject）并记录 store-only `abandoned` 与 `inbox.open` 的排除理由；实现 `test:e2e:live` 的 self-skip 与本地证据标记。
3. 把 keyless lane 提升为发布阻塞：`npm run check` 要求当前版本的绿色证据覆盖全部 keyless 场景，版本升级或场景变更必须重新记录；同步 `docs/testing.md` 和发布证据。
4. 覆盖 M12 现有断言后删除 `src/dev/m12-e2e*` 与 M12 dev 路由，保留 health route；把旧 `.dsh-cowork/e2e` 只作为历史摘要归档。前置是先在具有可用 bash sandbox 的宿主上重跑 M12 的「topic 会话用 bash 提交」断言；当前本机的 bash sandbox 后端不可用，这条断言在 M12 和 keyless lane 都无法执行，因此退役不得早于该环境验证。
