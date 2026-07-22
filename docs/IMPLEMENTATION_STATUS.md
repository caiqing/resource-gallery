# 实现状态（对照迭代计划 M0–M4）

日期：2026-07-21  
依据：[迭代计划](./2026-07-19-resource-gallery-iteration-plan.md)、[PRD](./2026-07-19-resource-gallery-prd.md)、[DESIGN.md](./DESIGN.md)

## 技术栈

| 层 | 选择 |
|----|------|
| Monorepo | pnpm workspaces + TypeScript |
| API | Hono + `node:sqlite` |
| Web | Vite SPA（Gallery + Admin 双皮肤分路由） |
| 契约 | `@resource-gallery/export-schema` + CLI |

## 验收状态

### I0
- [x] 仓骨架、README 边界与 CI
- [x] export v1 schema、3 个正例包与负例 fixture
- [x] 校验 CLI、契约测试、DESIGN 与运维文档

### I1
- [x] 3 个独立 v1 包走通导入 → draft → published
- [x] 搜索、主题、分页、详情与文件清单
- [x] video/auth 剥离、导入幂等、失败审计与原子 blob 替换
- [x] Listing 状态机、普通用户 403、C 端无发布入口

### I2
- [x] 点赞事务与用户×Listing 唯一约束
- [x] 点赞/下载的日、周、总榜
- [x] 短链、匿名摘要与真实 OG HTML
- [x] 登录、点赞、举报基础频控

### I3
- [x] free / standard 获取、重复与并发获取幂等
- [x] Order 分成快照、pending_earnings 与账本对账
- [x] 5 分钟签名下载、过期/伪造拒绝、文件路径约束
- [x] 下架后保留既有 entitlement，自有资源不进入下载榜

### I4
- [x] 邮箱注册登录、资料、已购、点赞与流水
- [x] 用户、举报/下架、调账、分成、定价与审计治理界面
- [x] 登录/点赞/下单/下载/举报频控，列表分页与图片懒加载
- [x] 用户协议、授权与侵权下架入口
- [x] 生产强制签名密钥、Secure Cookie、Session token HMAC 存储

## 验证证据

```bash
pnpm test
# export-schema: 6 passed
# API M0-M4 acceptance smoke: 12 passed
# Web TypeScript: passed

pnpm build
# 全工作区构建通过
```

API 烟测覆盖：匿名/用户/admin 权限矩阵、三包导入发布、检索分页、点赞与周期榜、free/standard、并发双请求、重复不扣费、分成版本快照、作者应收、账本对账、签名过期、下架后已购下载、OG、资料、举报治理与审计。

浏览器走查：Codex in-app Browser，桌面 `1440×1000` 与移动端 `390×844`；首页、搜索、详情、登录、用户中心、榜单、Admin 治理页均完成渲染与交互检查，控制台无 error/warn，修复了全局主题点击误绑定与移动端 Admin 横向溢出。

## 部署边界与剩余风险

- 本地使用文件系统 blob；生产对象存储/CDN 与真实域名反向代理需在部署环境接入并复验签名隔离。
- 本仓以三个可重复 v1 fixture 验证导入；Video2PPT 真实导出器仍属于兄弟仓交付物。
- SQLite 适合一期单实例事务；水平扩展前需迁移共享数据库与分布式频控。
- 邮箱注册已落地，但未接邮件验证/找回通道；正式公开运营前需配置邮件服务。
