# Known issues

当前阶段不修、但必须被后续阶段看见的遗留问题与已转计划事项的**唯一清单**。修复中的缺陷**不写在这里**：它们在对应阶段的修复提案与交接文档里；产品范围在 [PLAN](PLAN.md)，本文件只引用不复制。

## 怎么用

- 新遗留问题出现时，在清单加一行，写清影响、因果、归属与重估触发条件；不要把它复制进结果文档。
- 问题进入修复或计划时，状态改为「已转计划」并给出指针，本行只保留原因；细节移到提案或 PLAN。
- 问题解决后从本表删除，由对应交付的结果文档记录证据。
- 「因果」列是这一行的核心：**一个后果不被单独当成决策**；如果它是某条已定需求的直接结果，就写在那一行里。

## 清单

| id | 问题 | 影响 | 因果 / 背景 | 归属与状态 | 首次出现 | 重估触发条件 |
|---|---|---|---|---|---|---|
| KI-1 | thread 隔离的读边界与 clone 成本 | 每个隔离 thread 付一次完整 checkout（本仓库约 101 ms，磁盘约等于已提交文件树）；clone 只含已提交内容，thread 要在 clone 内自装依赖、看不到主仓未提交改动与本地配置；master 审查要先 fetch 或 `git -C` 看分支 | [PLAN](PLAN.md) 把 thread 定成用户可直接打开、可交互的普通会话（§1、§2；必办项），用户会在 thread 里做小改动并期望主仓上下文；隔离用「每 thread 一个本地 clone」，clone 成本与读不到主仓是这条需求的**因果后果**，不是两个独立决策 | 隔离方案的后续评估（M3 之后，与 M5 无关）；M2 已按 opt-in 实现，读/小改动 thread 不必开隔离 | M2 | 大仓库多 thread 并发；交互式小改动成为常态；thread 频繁需要主仓未提交内容或本地依赖；thread 需要跨模块全局重构 |
| KI-2 | 记忆只追加、关键词检索、按文件顺序装填 | 重复、过时或互相矛盾的约束会累积并进入 system prompt；同义改写漏召回；旧条目可能挤占 3000 token 预算 | M2 的显式非目标；去重与语义检索已定为 M5 目标（[PLAN](PLAN.md) §6 M5） | M5；已转计划 | M2 | —（已入计划） |
| KI-3 | preset 运行时注册，重启即消失 | 正式安装路径下重启后 cowork preset 不可用；dev injector 重启是否自动恢复未核实 | M1 遗留；PLAN 把打包与持久化放在 M4 | M4；已转计划 | M1 | 若 dev injector 重启后 preset 不能自动恢复，则这条超出 M4 打包范围，需要单独评估 |
| KI-4 | merge 冲突必须人工或 thread 解决 | 冲突时 thread 阻塞、master 不能强推；冲突频繁会拖慢推进 | 设计取舍：不自动解决冲突（[PLAN](PLAN.md) §5.6） | 保持；M3 review 流程需覆盖 | M0/M2 | 冲突频率高或成为常态时，评估辅助解决（人工确认后自动合并等） |
| KI-5 | 全部结论以 workspace-write 为策略前提 | 部署改成 `read-only` 时 clone 写不了；改成 `danger-full-access` 时被否决的 worktree 等方案重新变得可行 | P0 实测环境前提（[M2-P0 结果](M2_PROBE_RESULT.md)） | 部署/兼容性；保持 | M2 | 部署策略变化时重跑关键 E2E，并重评隔离机制 |
| KI-6 | 面板 API thread 字段 `worktreePath` → `checkoutPath` 的破坏性改名 | 按旧字段读取 `/api/cowork.overview` 的外部调用方拿不到隔离路径；仓库内 host/client 已同步，面板未发布故暂无实际外部消费方 | 合并 M2 与面板分支时的字段统一：M2 已把 `ThreadRecord` 定为 `checkoutPath`（store 读兼容旧索引的 `worktreePath`），面板 wire 跟随 M2（[PANEL_RESULT](PANEL_RESULT.md)）；这是跨分支合并的直接结果，不是独立决策 | 面板发布前评估；保持 | M2（面板合并） | 面板随插件对外发布、出现仓库外 API 消费方，或需要兼容旧调用方时，评估字段别名与主版本（破坏性变更） |
| KI-7 | E2E `memory-visible` 只匹配 assistantText 的 1000 字前缀 | 约束文本若在回复 1000 字之后才出现会假阴性；证据只保留前缀，后半段无法复核 | `assistantTextSince` 先 `clip(MAX_ASSISTANT_TEXT)` 再 `includes`；nonce 不可猜，因此不会假阳性，但证明强度依赖输出顺序 | M2 收口后最终复审发现；保持（当前证据已通过） | M2（2026-11-05 closeout review） | 真实宿主出现 false negative，或需要按完整回复审计时，改为原始文本匹配/尾段截取 |
| KI-8 | isolated thread 创建在 sessionId 不一致后可能留下孤儿会话 | 宿主 workspace 删除是否级联 session 未核实；重复 mismatch 可能积累无用会话 | `createCheckoutThread` 在 session 创建后校验，抛错后工具层只清理索引/clone/workspace，没有可靠的宿主 session id 可归档 | M2 收口后最终复审发现；保持（mismatch 属宿主违约，尚未观测） | M2（2026-11-05 closeout review） | 观测到孤儿会话，或确认 workspace delete 不级联 session 时，让错误携带返回 id 并在补偿路径 archive |
| KI-9 | `renderMemoryEntry` 的 clock 注释举了不存在的生产调用方 | 维护者可能误以为 tools 层已使用该函数注入时钟 | 注释称“such as the tools layer”，但 tools 实际走 `appendMemoryEntry` 的 clock；`renderMemoryEntry` 目前仅测试调用 | M2 收口后最终复审发现；保持（注释级） | M2（2026-11-05 closeout review） | 下次修改 `src/memory.ts` 时顺带修正注释示例 |
| KI-10 | cowork 会话能看到 profile 全局 dev_*/host/插件管理工具 | master 在真实 E2E 的自主 handoff 回合里调用过 `dev_plugin_status` / `dev_reload_package`，可能改变宿主环境；工具面没有硬限制 | M1 S0 已证：preset 只追加自己的行，profile 级全局工具始终可见；角色边界只靠工具内校验与 persona。M3 已把「禁止 dev_*/host 工具」写进 master persona 并让 E2E 通过 | M3；保持（persona 缓解，非硬限制） | M3（t4 真实 E2E） | 模型再次在 cowork 会话里调用宿主管理工具，或需要硬隔离时，评估 per-session 工具白名单/sandbox |
| KI-11 | 同进程同名包 client 不生效（client-modules pkgMeta 缓存） | 把 `@dsh-external/dsh-cowork` 从无 client 换成有 client 后，注入/重载都不会进入浏览器 boot 列表；面板 UI 在交付包里可能不出现 | 宿主 `client-modules` 按 loader name + baseUrl 缓存包元数据且不失效；M2 面板验证用临时改名包绕过（[PANEL_RESULT](PANEL_RESULT.md)），M3 复查时再次复现 | M3；保持（M4 正式安装/重启路径应正常） | M3 | 宿主提供可失效的扫描，或正式安装路径也复现时，做包名/装配层修复 |
| KI-12 | 面板 API 在大会话列表下会无限 loading | `/api/cowork.overview` / `/api/cowork.handoff` 先 `sessionController.list()` 解析项目；宿主会话列表 1.2 MB、单次 >60 s 时请求悬挂，面板没有超时/降级，用户看不到任何状态 | 面板 API 的 sessionId→cwd 解析是唯一入口；宿主 `list()` 在大量会话/高负载下变慢甚至不返回（[M3_PROBE_RESULT](M3_PROBE_RESULT.md)）。这是宿主事实，不是 M3 引入 | M3；保持，未在 M3 修 | M3 | 面板再次出现无限 loading，或需要把面板作为可用产品交付时，给 `listSessions` 加超时与只读降级（例如 `sessionController.get`） |
| KI-13 | 失败的 M3 E2E 会把带 Markdown 的夹具留在 `.dsh-cowork/e2e/m3-repo` | 该目录的 `README.md` 会让 `npm run check` / publish 测试变红；重跑四条命令前必须先清理 | E2E 失败时不执行 cleanup 步；`tools/check-invariants.mjs` 扫描工作区 Markdown，不按 gitignore 过滤。M2 驱动同样行为，M3 未复制 cleanup 的 finally 兜底 | M3；保持（结果与限制已写明） | M3 | 需要把 E2E 失败清理做成 finally，或让 check 只扫 tracked 文件时 |
| KI-14 | `src/tools.ts` 贴近 DSH 单文件 50 KiB 读上限 | 当前 51,184 B，仅比 51,200 B 少 16 B；下一次修改该文件会超限，读工具将无法一次读完 | M3 在 `tools.ts` 追加两个 review 工具与 merge 门禁，未拆模块（新文件不在任务 inScope）；`src/m3-e2e.ts` 已按同样风险拆成 runner+support | M3；保持（当前仍可读） | M3 | 下次修改 `src/tools.ts` 前先拆出 review/merge 工具注册，或宿主提高读上限 |
