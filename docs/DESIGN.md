# Resource Gallery 设计系统

| 项目 | 内容 |
|------|------|
| 产品 | Resource Gallery |
| 文档 | DESIGN.md（实施源） |
| 版本 | v0.1.0 |
| 日期 | 2026-07-19 |
| 气质 | `Editorial · Calm · Gallery · Precise · Warm Paper · Quiet Commerce` |
| 上游 | [PRD §6](./2026-07-19-resource-gallery-prd.md) · [迭代计划](./2026-07-19-resource-gallery-iteration-plan.md) |
| 可交互原型 | [`../prototype/`](../prototype/) |

---

## 1. 定位

资源站首先是 **精选知识资产画廊**，其次才是交易系统。  
第一眼应感到「作品被好好陈列」，而不是「又一个 AI SaaS 后台」。

| 对比 | Video2PPT | Resource Gallery |
|------|-----------|------------------|
| 气质 | 任务工作台 / 工具密度 | Editorial Gallery / 作品优先 |
| 主色 | 工具蓝紫（禁止复用为品牌主识别） | 低饱和墨绿 accent |
| 信息密度 | 高（诊断、run、阶段） | 低（封面、标题、安静元信息） |
| 皮肤 | 单一工具皮肤 | **C 端 Gallery** + **Admin Utility** 双皮肤 |

一期 C 端 **无「发布」入口**。

---

## 2. 设计原则（可验收）

1. **内容即界面**：海报卡片为主，禁止文件名表格列表作为主浏览方式。  
2. **克制密度**：二级元数据折叠；不向 C 端暴露 `run_id`、诊断、账本科目。  
3. **四级排版**：标题 → 摘要 → 元信息 → 动作；禁止同级视觉竞争。  
4. **少彩多质感**：1 主色 + 1 点缀；靠纸感底、细边、柔阴影、字体对比。  
5. **动效有目的**：页面过渡、点赞反馈、封面 hover 微缩放。  
6. **深浅双模式**：默认浅色 Editorial；深色同等完成度。  
7. **信任感交易**：tabular nums；结账像画廊购票，不像游戏充值。  
8. **空状态精致**：编辑式短文案，不用系统默认灰盒。  
9. **无障碍底线**：对比度、可见焦点环、键盘可达；尊重 `prefers-reduced-motion`。  
10. **反模式禁止**：霓虹/粒子、三列同权大 CTA、彩虹标签云、仪表盘侧栏抢戏、复刻三栏任务台。

---

## 3. Design Tokens

### 3.1 色彩

#### C 端 Gallery · Light（默认）

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg` | `#F6F1E8` | 暖纸底 |
| `--bg-elevated` | `#FBF7F0` | 次级底 |
| `--surface` | `#FFFCF7` | 卡片 |
| `--surface-2` | `#F3ECE1` | 嵌入区 |
| `--ink` | `#1C1917` | 正文 |
| `--ink-soft` | `#44403C` | 次级正文 |
| `--muted` | `#78716C` | 说明 |
| `--line` | `#E8DFD2` | 细边 |
| `--accent` | `#2F5D50` | 主行动（墨绿） |
| `--accent-soft` | `#E4EEEA` | accent 浅底 |
| `--credit` | `#57534E` | Credits 数字 |
| `--like` | `#9A3412` | 点赞反馈（克制暖赭） |
| `--success` | `#3F6212` | 状态 |
| `--warn` | `#A16207` | 状态 |
| `--danger` | `#9F1239` | 状态 |
| `--shadow` | `0 1px 2px rgb(28 25 23 / 4%), 0 12px 32px rgb(28 25 23 / 6%)` | 卡片 |

#### C 端 Gallery · Dark

| Token | 值 |
|-------|-----|
| `--bg` | `#12110F` |
| `--bg-elevated` | `#181614` |
| `--surface` | `#1C1917` |
| `--surface-2` | `#292524` |
| `--ink` | `#F5F0E8` |
| `--ink-soft` | `#D6D3D1` |
| `--muted` | `#A8A29E` |
| `--line` | `#292524` |
| `--accent` | `#8FB5A6` |
| `--accent-soft` | `#1F2E29` |
| `--credit` | `#D6D3D1` |
| `--like` | `#E7B4A0` |
| `--shadow` | `0 1px 2px rgb(0 0 0 / 40%), 0 16px 40px rgb(0 0 0 / 35%)` |

#### Admin Utility（与 C 端分离）

| Token | Light | 说明 |
|-------|-------|------|
| `--admin-bg` | `#F4F4F5` | 中性灰底，非暖纸 |
| `--admin-surface` | `#FFFFFF` | 表格/表单 |
| `--admin-ink` | `#18181B` | |
| `--admin-accent` | `#334155` | 石板色行动，避免与 C 端墨绿抢品牌 |
| `--admin-line` | `#E4E4E7` | |
| 密度 | 更高 | 允许表格、筛选条、状态徽章 |

### 3.2 字体

| 角色 | 栈 | 规格 |
|------|-----|------|
| Display / 标题 | `"Noto Serif SC"`, `"Source Han Serif SC"`, `Songti SC`, `serif` | 首页英雄句 40–48 / 36–40；卡片标题 17–18 |
| Body | `Inter`, `"PingFang SC"`, `system-ui`, `sans-serif` | 14–16，行高 1.55–1.7 |
| Numeric | 继承 Body + `font-variant-numeric: tabular-nums` | 价格、余额、榜单序号 |
| 上限 | **≤ 3 字族** | 禁止再引入展示体/手写体 |

字重：标题 500–600；正文 400；元信息 400–500。避免全大写英文作为主要标题。

### 3.3 间距与布局

| Token | 值 |
|-------|-----|
| `--space-1` … `--space-8` | 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px |
| `--radius-sm` | 6px（芯片、小控件） |
| `--radius-md` | 12px（卡片） |
| `--radius-lg` | 20px（大面板、结账层） |
| `--nav-h` | 64px |
| `--content-max` | 1280px（桌面内容最大宽 1200–1440 区间取 1280） |
| `--buy-col` | 320px（详情购买栏） |

**网格**

- 作品网格：移动 1 列 → ≥720 2 列 → ≥1024 3 列 → ≥1280 4 列  
- 卡片比例：信息图竖向约 `3/4`；PPT 封面约 `16/10`（数据字段 `coverRatio`）  
- 详情：桌面左预览 / 右购买；移动预览上、购买下  

**顶栏（C 端）**

`字标 | 探索 · 排行 · 搜索 | 主题切换 · 账户`  
**禁止**：发布、上传、仪表盘入口。

### 3.4 动效

| 场景 | 规格 |
|------|------|
| 封面 hover | `transform: scale(1.02)`，`200ms ease` |
| 页面切换 | 内容区 `opacity` 短过渡 160ms |
| 点赞 | 图标填充 + 轻位移，无粒子 |
| 结账层 | 自下/自右滑入 220ms |
| `prefers-reduced-motion: reduce` | 全部过渡降为 0 或瞬时 |

---

## 4. 组件规格

### 4.1 按钮

| 变体 | 用途 | 规则 |
|------|------|------|
| **Primary** | 全站唯一实心主行动 | 墨绿底 + 浅字；每屏主 CTA **最多 1 个** |
| Ghost | 次级（点赞、分享） | 细边或无边 |
| Quiet | 第三级文字按钮 | 无边、muted |
| Danger quiet | 下架等 | 仅 Admin |

禁止：同一购买区并排 3 个同权大按钮。

### 4.2 资源卡片 `WorkCard`

```
┌─────────────────────┐
│                     │
│     Cover (主)      │
│                     │
├─────────────────────┤
│ 标题（最多 2 行）    │
│ 摘要 1 行 muted      │
│ 主题芯片 · 价格      │
└─────────────────────┘
```

- 封面占卡片视觉 **≥ 70%** 高度感知  
- 不展示 `run_id`、文件名列表  
- 价格：`免费` 或 `12 credits`（tabular）  
- 键盘：整卡可聚焦，Enter 进详情  

### 4.3 标签芯片

- 细边、浅底、单行；一行最多约 3 枚 +「+N」  
- 主题色不彩虹化：统一 `--surface-2` + `--ink-soft`  
- Admin 可显示「待确认」角标（warn 色文字，非大色块）  

### 4.4 详情购买栏 `BuyRail`

- 价格大号 tabular  
- 主按钮：**下载** / **使用 credits 获取**（单一）  
- 次级：点赞、分享（ghost）  
- 余额一行冷静展示  
- 结账确认层：价格摘要 + 余额变化 + **一次确认**  

### 4.5 榜单 `RankList`

- 杂志感：大序号（衬线）+ 封面缩略 + 标题 + 计数  
- 非奖牌、非进度条、非战绩红金  

### 4.6 空状态 `EmptyState`

- 短标题 + 一行说明 + 可选一个 ghost 行动  
- 示例：「这座廊暂时还没有这件作品。」  

### 4.7 Admin 组件口味

- 允许 Data table、Filter bar、Status badge  
- 导入区：大虚线投放区 + 任务进度列表  
- 不使用 C 端暖纸大背景；用 Utility 灰白  

---

## 5. 页面蓝图（一期原型覆盖）

| 路由（原型） | 页面 | 保真重点 |
|--------------|------|----------|
| `#/` | 首页 | 英雄句、搜索、精选网格 |
| `#/topics` | 主题墙 | 受控主题入口 |
| `#/topics/:id` | 主题列表 | 网格 + 筛选 |
| `#/search?q=` | 搜索结果 | 结果卡片 / 空状态 |
| `#/rank` | 榜单 | 点赞/下载 · 日周总 |
| `#/work/:id` | 详情 | 大预览 + BuyRail |
| `#/work/:id/checkout` | 结账层 | 安静确认 |
| `#/share/:id` | 分享预览 | OG 卡模拟 |
| `#/me` | 个人中心 | 已购/点赞/流水/余额 |
| `#/admin` | 运营台首页 | Utility |
| `#/admin/import` | 导入 | zip 投放与 Job |
| `#/admin/listings` | 资源列表 | 表格 |
| `#/admin/listings/:id` | 策展 | 勾选文件/标签/发布 |

---

## 6. 文案语气

- 中文为主；短句、编辑感，不喊口号堆 emoji。  
- 交易文案冷静：「确认支付 12 credits」「余额 40 → 28」。  
- 来源弱标注：`Generated with Video2PPT`（小字 muted）。  
- 禁止：游戏化「恭喜获得！」、闪烁促销条。  

---

## 7. 无障碍

- 正文对比 ≥ WCAG AA 目标（浅色 ink on paper、深色 ink on dark）。  
- `:focus-visible` 使用 2px accent 环，偏移 2px。  
- 图标按钮必须有 `aria-label`。  
- 结账层打开时焦点陷阱；Esc 关闭。  
- 减动效媒体查询必遵。  

---

## 8. 与实现的映射

| 产物 | 路径 |
|------|------|
| Token CSS | `prototype/css/tokens.css` |
| Gallery 样式 | `prototype/css/gallery.css` |
| Admin 样式 | `prototype/css/admin.css` |
| 交互原型 | `prototype/index.html` + `prototype/js/*` |
| 本文件 | `docs/DESIGN.md` |

生产应用应自本 token 迁移到 CSS variables / design tokens 包，**不得**回退到 Video2PPT 蓝紫主色。

---

## 9. 设计验收清单（发版前）

- [ ] 首页首屏封面面积显著高于元数据  
- [ ] 详情点赞 / 下载 / 价格不同权并列三颗大按钮  
- [ ] 深浅色均可读、焦点可见  
- [ ] 与 Video2PPT 任务页并排可一眼区分  
- [ ] 反模式清单无违规  
- [ ] C 端无发布入口  
- [ ] Credits 数字为 tabular nums  

---

## 10. 版本记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1.0 | 2026-07-19 | 首版 token + 组件 + 页面蓝图；对齐 PRD v0.1.1-draft |
