# Resource Gallery

独立的分类资源站点：把 Video2PPT 的 **单次 run 导出包** 变成可发现、可预览、可用 Credits 交换的知识资产画廊。

> **边界**：本仓只做画廊 / 检索 / 账本 / 运营导入。  
> **不** 反向写入 Video2PPT 的 `task.json` 或任务状态。  
> **不** 在本站重跑 Pipeline。  
> 一期 **仅运营导入**，C 端无自助发布入口。

## 文档

| 文档 | 说明 |
|------|------|
| [docs/2026-07-19-resource-gallery-prd.md](./docs/2026-07-19-resource-gallery-prd.md) | 产品需求 |
| [docs/2026-07-19-resource-gallery-iteration-plan.md](./docs/2026-07-19-resource-gallery-iteration-plan.md) | 迭代开发计划 M0–M4 |
| [docs/DESIGN.md](./docs/DESIGN.md) | Editorial Gallery 设计系统 |
| [docs/export-contract.md](./docs/export-contract.md) | `resource-gallery.export/v1` 契约 |
| [docs/ops-runbook.md](./docs/ops-runbook.md) | 运营导入上架手册 |
| [docs/deployment.md](./docs/deployment.md) | Docker + Caddy 单实例生产部署说明 |
| [prototype/](./prototype/) | 高保真交互原型（设计评审） |

## 技术栈（一期锁定）

- **Monorepo**: pnpm workspaces + TypeScript
- **API**: Hono + Node.js + `node:sqlite`
- **Web**: Vite（C 端 Gallery + Admin Utility 同应用分路由、双皮肤）
- **契约**: `packages/export-schema` + 校验 CLI

## 目录

```text
apps/web                 # 画廊 + 运营台
services/api             # 账户 / Listing / 导入 / 账本 / 签名下载
packages/export-schema   # export v1 JSON Schema / 类型 / fixtures
tools/validate_export_package
docs/
prototype/               # 静态高保真原型
```

## 快速开始

```bash
pnpm install
pnpm validate:fixtures
cp .env.example .env
# 填写 .env 中的签名密钥和本地账号密码
chmod 600 .env
./dev.sh start
```

- Web: http://127.0.0.1:5173  
- API: http://127.0.0.1:8787/health  

本地账号邮箱和密码由根目录 `.env` 管理；该文件已被 Git 忽略，不应提交。

## 本地启动器

`./dev.sh` 负责 API 与 Web 的启动、健康检查、状态、日志和安全停止；它只管理能够确认属于本仓的进程，不会按端口误杀其他项目。

```bash
./dev.sh start
./dev.sh status
./dev.sh logs
./dev.sh stop
```

默认 `start` 在终端直出日志。后台运行使用：

```bash
RESOURCE_GALLERY_LOG_MODE=file ./dev.sh start
```

## 验证

```bash
pnpm test   # export v1 契约 + M0–M4 API 集成 + Web 类型检查
pnpm build  # 全工作区生产构建
```

API 集成测试会把三个独立的 v1 fixture 包完整走通导入、发布、检索、互动、交易与治理链路。

## 生产配置

- `NODE_ENV=production` 时必须显式设置 `SESSION_SECRET` 与 `DOWNLOAD_SIGNING_SECRET`。
- 生产默认不创建本地种子用户；一次性初始化时显式设置 `SEED_USERS=true`。`SEED_TEST_USER=true` 只用于需要演示账号的本地环境。
- Web 需将 `/api/*`、`/health` 与 `/s/*` 反向代理到 API；开发环境已由 Vite 代理。
- 生产对象存储/CDN 可替换本地 blob 目录，但不得绕过权益与签名下载检查。

## Docker 部署

仓库提供 API、静态 Web 与 Caddy 反向代理的单实例部署编排；生产不会创建默认账号，也不会暴露 API/blob 目录。

```bash
cp deploy/.env.production.example deploy/.env
# 编辑 deploy/.env 后
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

完整的域名、TLS、首个管理员初始化、验收与备份要求见 [docs/deployment.md](./docs/deployment.md)。

## 校验导出包

```bash
pnpm --filter @resource-gallery/validate-export-package start -- path/to/package.zip
# 或
node tools/validate_export_package/dist/cli.js path/to/package.zip
```

## 一期明确不做

- C 端自助发布 / 用户上传
- 法币充值、提现、KYC
- 源视频公开市场
- 挂载本机 Video2PPT `tasks/` 路径

## 许可

MIT
