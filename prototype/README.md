# Resource Gallery 高保真原型

对齐 [docs/DESIGN.md](../docs/DESIGN.md) 与 PRD §6 的可交互原型系统。

## 本地打开

```bash
# 任选其一
open prototype/index.html
python3 -m http.server 8765 --directory prototype
# 浏览器访问 http://127.0.0.1:8765/
```

建议用本地静态服务器，避免部分浏览器对 `file://` 模块/字体的限制。

## 覆盖页面

| 路由 | 说明 |
|------|------|
| `#/` | 首页：英雄句、搜索、主题、精选网格 |
| `#/topics` · `#/topics/:id` | 主题墙 / 主题列表 |
| `#/search?q=` | 搜索与空状态 |
| `#/rank` | 点赞/下载榜（杂志感） |
| `#/work/:id` | 详情：大预览 + 安静购买栏 |
| `#/work/:id/checkout` | 结账确认层 |
| `#/share/:id` | OG 分享卡模拟 |
| `#/me` | 已购 / 点赞 / 流水 / 余额 |
| `#/admin` | 运营总览（Utility 皮肤） |
| `#/admin/import` | 导入 Job 模拟 |
| `#/admin/listings` · `/:id` | Listing 列表与策展发布 |

## 交互说明（原型级）

- 深浅色切换写入 `localStorage.rg-theme`
- 点赞、支付、导入、发布均为前端模拟状态
- 一期约束体现：C 端导航 **无发布入口**；Admin 与 Gallery 双皮肤
- 封面为程序化 SVG，非真实 Video2PPT 产物

## 结构

```text
prototype/
├── index.html
├── css/   tokens.css · base.css · gallery.css · admin.css
├── js/    data.js · app.js
└── README.md
```

## 设计验收自检

见 `docs/DESIGN.md` §9。本原型用于评审信息架构与气质，不替代生产实现与真实导出包链路。
