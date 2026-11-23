# Cowork 工作项视觉与像素验收基线

Status: design baseline（2026-11-23）

本文是工作项相关设计文档的共享视觉验收基线。页面结构、交互和状态归属各自的 feature 设计文档；本文只拥有尺寸、间距、颜色、状态样式和截图验收规则。具体页面只在各自文档写增量项，不复制本文。

## 1. 验收画板与测量口径

- 参考画板：`1280 × 900`，其中 App 内容盒 `1208 × 828`，居中。
- 产品实际宽度：`300–1200px`；右侧栏最小 300px，工作项文档纸面最大 920px，批注栏默认 336px。
- 截图：Chromium headless，`deviceScaleFactor=2`，亮/暗各一套；单状态交付图逻辑尺寸 1280×900。多状态拼接板允许更大，但每个状态板必须保持 1280×900 的内容比例，并在 100% 缩放下读清关键文案。
- 关键布局盒（tab strip、header、toolbar、paper、rail、composer、footer）位置容差 `±2px`；内部文字基线、图标中心和边框宽度容差 `±1px`。
- 间距、圆角、边框宽度只用整数 px；字号优先宿主 token，不照搬设计稿的 8.5–11px 小字。
- 125% / 150% 浏览器缩放下不得出现重叠、裁切或非预期横向滚动。
- 任何“看起来差不多”但无法在截图中稳定复现的差异，不作为验收项。

## 2. 颜色与主题

### 2.1 亮色

| token | 值 | 用途 |
|---|---|---|
| `--cwi-ink` | `#101828` | 主文字、标题、图标 active |
| `--cwi-muted` | `#475467` | 次要正文、hover 文字 |
| `--cwi-soft` | `#98a2b3` | 时间、占位、辅助说明 |
| `--cwi-border` | `#e4e7ec` | 卡片/输入框边框 |
| `--cwi-border-soft` | `#eef0f3` | 分隔线、纸面内边 |
| `--cwi-surface` | `#ffffff` | 纸面、卡片、输入框 |
| `--cwi-surface-muted` | `#f9fafb` | 次级底、选中行底 |
| `--cwi-accent` | `#175cd3` | active tab、pin、选中边 |
| `--cwi-accent-soft` | `#eff8ff` | 选中环、active 背景 |
| `--cwi-success` | `#067647` | 已完成、已回复 |
| `--cwi-success-soft` | `#ecfdf3` | 成功底、diff 新增底 |
| `--cwi-warn` | `#b54708` | 待确认、活动、stale |
| `--cwi-warn-soft` | `#fffaeb` | 警告底、stale 行底 |
| `--cwi-danger` | `#b42318` | 失败、冲突、diff 删除 |
| `--cwi-danger-soft` | `#fef3f2` | 错误底、diff 删除底 |
| `--cwi-model` | `#6941c6` | 模型回复 |
| `--cwi-model-soft` | `#f4f3ff` | 模型回复底 |

### 2.2 暗色

暗色不使用本文亮色硬值；使用宿主 alias token：

- 主文字：`--dsw-alias-label-primary`
- 次要文字：`--dsw-alias-label-secondary`
- 辅助文字：`--dsw-alias-label-tertiary`
- 边框：`--dsw-alias-border-l2` / `l3`
- 纸面：`--dsw-alias-bg-layer-1`
- 次级底：`--dsw-alias-bg-layer-2`
- 品牌：`--dsw-alias-brand-primary`
- 成功/警告/错误：`--dsw-alias-state-success-primary` / `warn` / `error`

亮/暗两套都必须通过 WCAG AA：正文对比度 ≥ 4.5:1，大字 ≥ 3:1，focus ring 与背景 ≥ 3:1。

## 3. 主区标签与 View 容器

| 元素 | 规格 |
|---|---|
| 会话 header 高度 | 至少 76px；有 tab 行时 76px，无 tab 行时按宿主规则收缩 |
| tab 行高度 | 25px；与 header 底线距离 0 |
| tab 间距 | 14px；首 tab 左对齐内容列 |
| tab 字号/字重 | 13px / 500；active 600 |
| tab active 指示线 | 高 2px，圆角 2px；left/right 0；颜色 accent |
| tab hover | 文字变 `label-primary`；背景不铺满整行 |
| tab focus-visible | 2px accent outline，offset 2px |
| viewArea 与 composer | composer 覆盖时 View 自持滚动，底部预留 `--dsh-composer-height`，不得被 composer 永久遮挡 |
| 窄屏 | < 900px 时批注栏改为底部抽屉；tab 行允许换行，不出现横向滚动 |

验收：1280/1024/768/390 四档，点击 tab 后 `aria-selected` 与 active 下划线同时切换；composer 覆盖层不会盖住最后一行正文或 footer。

## 4. 工作项纸面与工具栏

| 元素 | 规格 |
|---|---|
| 纸面最大宽度 | 920px；左右自动居中 |
| 纸面圆角 | 12px；边框 1px `border` |
| 纸面头部高度 | 42px；左右 padding 14px；底边 1px `border-soft` |
| 文件图标 | 22×22px；圆角 6px；字号 9px / 800 |
| 文件名 | 12px mono；最大宽度 240px；省略号 |
| 工具栏高度 | 38px；左右 padding 20px；底边 1px `border-soft` |
| 视图 tab 字号 | 12.5px / 600；active accent + 2px 底线 |
| 阅读/源码 segmented | 总高 24px；内边距 2px；选项 padding 1px 8px；圆角 7/5px |
| 保存状态 | 11.5px；圆点 7px；gap 5px |
| 批注开关 | 高 26px；padding 3px 10px；圆角 7px |
| 正文行高 | 阅读态 1.65；源码态 20px |
| 正文左右 padding | 纸面内 24px；行号 gutter 60px；pin 右留 40px |

## 5. 必须逐项固定的细节

### 5.1 编号 pin

- 容器：`min-width:17px; height:17px; padding:0 4px`；圆角 999px；2px 纸面底色描边。
- 字号 8px / 800；白字；accent 底；`box-shadow: 0 1px 3px #1018282e`。
- 位置：行内右侧，距纸面右内边 6px；top 2px；不得覆盖正文最后 24px。
- 状态：open=accent；resolved=success；stale=warn。
- 同线多线程：只显示最早线程的序号；其余线程通过批注栏/悬浮摘要访问；pin 的 `aria-label` 为“第 N 条批注”。
- hover：亮度不变，cursor pointer；focus-visible：2px `ink` outline，offset 1px。
- 点击 pin：打开对应批注会话详情，文档滚动到 anchor 行，线程选中环出现。

### 5.2 线程选中环

- 选中：`border-color: selected-border`；`box-shadow: 0 0 0 2px accent-soft`；不改变卡片尺寸。
- hover 只改边框色，不出现外环；selected + hover 仍只保留一层 2px 外环。
- 圆角保持 9px；外环不裁切内部内容；深色主题使用 `--dsw-alias-brand-primary` 的 24% 混色。
- 键盘选中与鼠标选中视觉一致。

### 5.3 anchor 序号

- `#N` chip：字号 9px / 700；padding 1px 5px；圆角 4px；背景 accent-soft；文字 accent。
- 位置：线程卡头部最右侧；与标题/作者同一基线；不换行。
- stale：warn-soft / warn；resolved：success-soft / success。
- 序号与文档 pin 使用同一排序：按 anchor 行号、再按创建时间稳定排序。

### 5.4 文档头附件 chip

- 最多展示 2 个；溢出显示 `+N`；每个最大宽度 120px，省略号。
- 高 18px；padding 1px 6px；圆角 5px；字号 9.5px；边框 1px。
- 图片 chip 左侧 8×8 圆角方块；文本 chip 用文件色块；不显示真实绝对路径。
- 点击 chip：打开附件预览弹层；键盘 Enter/Space 等价；不得触发纸面行选中。
- 附件页和线程消息复用同一 chip 规格；模型生成附件加“模型生成”文字或图标，不改变 chip 尺寸。

### 5.5 评论筛选

- 控件：原生/自绘 select 高 24px；字号 10.5px；圆角 6px；左侧“只看待处理”开关宽 20px、高 11px。
- “全部评论 / 待处理 / 已解决”三项；空态文案固定，不显示假卡片。
- 筛选变更后列表不闪烁；选中态写入 URL/组件状态；刷新后保持。
- 筛选结果数量与列表可见项一致；计数为当前 thread 集合，不是 comment 行数。
- 键盘：Tab 进入 select，方向键切换；开关 Space 切换；焦点环 2px accent。

### 5.6 活动时长

- 文案：`< 60s` → `N 秒`；`< 60m` → `N 分钟`；`< 24h` → `N 小时`；否则 `N 天`；不显示小数。
- 字号 9.5px；颜色 warn；终态后停止计时并保留最后值；不因页面刷新重置。
- 活动条：高 28px；左右 margin 8/10px；padding 6px 8px；圆角 7px；warn-soft 底；error/done 切换对应底。
- `now` 每 30s 更新一次；进入终态后不再触发重渲染。

### 5.7 行级 diff 底色

- 新增行：`success-soft` 底 + 左侧 2px success 线；删除行：`danger-soft` + 左侧 2px danger 线；修改行：`accent-soft` + 左侧 2px accent 线。
- 底色只铺正文区域，不覆盖 gutter 或 pin 区域；行号保持可读。
- 没有可靠 diff 数据时不得猜测或伪造；显示普通行，并在版本/冲突区域说明数据不可用。
- 同一行同时有 diff 和批注时：diff 作为底色，批注 pin 和选中环保持最上层。

### 5.8 版本计数

- 标签文案：`版本`（0）或 `版本 N`（N>0）；`附件`/`附件 N`；N 为服务端返回的保留快照/附件数量，不把文件 revision 当计数。
- 刷新、SSE 更新、保存成功后计数保持一致；删除/新增附件后即时更新。
- 数字不改变 tab 宽度基准；N > 99 仍显示完整数字，不截断。

## 6. 状态与错误

| 状态 | 视觉 |
|---|---|
| 加载 | 骨架卡片 3 张；不显示假正文；`aria-busy=true` |
| 空 | 单行说明 + 一个主操作；不撑满大块空白 |
| 错误 | 错误底 `danger-soft`；错误码/可读消息 + 重试；不只显示图标 |
| 保存中 | 蓝点脉冲；文案“保存中” |
| 已保存 | 绿点 + `已保存 · rN` |
| 冲突 | `danger` 边框/底；提供查看差异/加载最新/保留我的 |
| 跨会话只读 | 顶部 36px 提示条；文案明确“当前会话不是该工作项所属会话”；提供“在所属会话打开”；编辑/批注 composer 禁用 |
| stale | warn-soft 底；文案“位置待确认”；保留内容，不猜位置 |
| 投递失败/阻塞 | danger/warn 底；原因 + 重试/打开会话；不自动重试 |

## 7. 可访问性与键盘

- 全局焦点环：2px accent outline，offset 2px；暗色用 brand token。
- Tab 顺序：会话 header tabs → 工作项 header 操作 → 工具栏 → 文档内容 → pin/批注栏 → composer → footer。
- 文档内容：Enter 批注当前行；Shift+Enter 扩展；方向键移动活动行；Esc 关闭浮动层并把焦点还给触发元素。
- 批注栏：列表卡可 Enter 打开详情；详情返回按钮 Esc 返回列表；宽度手柄用 ←/→ 调整 8px。
- `prefers-reduced-motion: reduce`：关闭脉冲、旋转和高度过渡；状态仍有文字。
- 颜色不是唯一状态提示；所有 pin/状态 chip 有文字或 `aria-label`。
- 图片有 alt；图标按钮有可读 label；弹层 `role=dialog`/`aria-modal=true` 并锁定背景交互。

## 8. 响应式

| 宽度 | 规则 |
|---|---|
| ≥ 1024 | 文档 + 右侧批注栏并排；批注栏 336px 默认 |
| 900–1023 | 批注栏可缩到 280px；纸面最大 920px |
| 640–899 | 批注栏改为底部抽屉，最大高度 `min(72%, 560px)`；正文不被永久压缩 |
| < 640 | 单列；工具栏允许换行；附件 chip 最多 1 个 + `+N`；pin 仍可在右侧点击 |
| < 390 | 不出现横向滚动；长路径/标题省略；tab 行可换行 |

## 9. 截图验收清单

每个复杂场景至少两张图：亮色 1280×900、窄屏 768×900；暗色至少一张关键状态。

1. 主区“会话 / 工作项”标签 + composer 覆盖；active 下划线和 `aria-selected` 一致。
2. 右栏列表：搜索入口、待确认合并、已完成折叠卡、来源会话名、无路径/无会话 ID。
3. 文档阅读态：标题、列表、表格、图片、链接、代码块、任务列表、引用。
4. 当前块源码态：源码边框/背景、行号、pin、右键批注按钮。
5. 批注栏列表态：只读摘要，无回复输入框；选中环和 `#N` chip。
6. 批注会话态：消息、附件缩略图、预览弹层、投递状态、返回列表。
7. 跨会话只读：提示条、禁用 composer、所属会话入口。
8. 附件页：图片/文本缩略图、模型生成标识、预览和下载。
9. 加载/空/错误/冲突/失败态各一张，文案不得被截断。

## 10. 不可作为验收证据的项

- 只写“样式已对齐”的文字说明。
- 只截局部而看不到 composer/tab/批注栏关系的图。
- 用 8.5–11px 的 mock 字号替代产品可读字号。
- 未实际生成的 demo 截图或复用旧截图。
- 对没有 diff 数据的行伪造绿色/红色底色。
