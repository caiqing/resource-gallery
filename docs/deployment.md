# 生产部署说明

本部署包面向一期的**单实例**运行方式：一个 API 容器、一个 Caddy 容器，以及持久化的 SQLite/blob 卷。它不把 Video2PPT 本机目录暴露给公网；生产导入仍只接收 `resource-gallery.export/v1` zip。

## 前置条件

1. Docker Engine 与 Docker Compose Plugin 可用。
2. 域名已配置 A/AAAA 记录到服务器，并允许入站 TCP `80`、TCP/UDP `443`。
3. 未有其他反向代理占用 `80`/`443`。
4. 使用 HTTPS 域名。生产会设置 `Secure` session cookie，不能以纯 HTTP 作为正式运行方式。

## 首次部署

在仓库根目录执行：

```bash
cp deploy/.env.production.example deploy/.env
```

编辑 `deploy/.env`，至少替换以下值：

- `PUBLIC_ORIGIN`：对外唯一访问地址，例如 `https://gallery.example.com`
- `SITE_ADDRESS`：同一域名，不带协议和路径
- `SESSION_SECRET` 与 `DOWNLOAD_SIGNING_SECRET`：分别随机生成且不可复用
- `INITIAL_ADMIN_EMAIL` 与 `INITIAL_ADMIN_PASSWORD`：首个运营账号

使用以下命令构建并启动：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

Caddy 在域名 DNS 可达后自动申请和续期证书。API 没有暴露宿主机端口；Web 只会将 `/api/*`、`/health` 和 `/s/*` 反向代理到 API，其余路径由 SPA 静态站点处理。

## 初始化运营账号

生产环境默认不创建任何演示账号。服务首次正常启动后，执行一次下列命令创建 `deploy/.env` 中的管理员：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml run --rm \
  -e SEED_USERS=true api node dist/seed-cli.js
```

该命令是幂等的。生产部署不设置 `SEED_TEST_USER=true`，因此不会创建演示用户。完成后不要将 `SEED_USERS=true` 写入 `deploy/.env` 或 Compose 配置；常驻 API 始终保持 `SEED_USERS=false`。

## 上线验收

```bash
curl -fsS https://gallery.example.com/health
curl -I https://gallery.example.com/
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=100 api web
```

再按 [运营导入与上架手册](./ops-runbook.md) 完整验证：管理员登录、导入 zip、发布、匿名浏览、注册、获取资源、短时签名下载和举报。下载文件必须只能通过权益校验后的 `/api/downloads/:listingId?token=...` 获取。

## 运维

```bash
# 查看状态与日志
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs -f api web

# 升级镜像
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build

# 停止（保留数据库、blob 与 TLS 证书卷）
docker compose --env-file deploy/.env -f deploy/compose.yaml down
```

`gallery-data` 是 SQLite 数据库、导入临时文件和 blob 的唯一持久化卷。上线前应按宿主机或云平台能力为该卷配置定期快照；不要用 `down -v` 清理生产环境，也不要将其目录公开映射为静态下载路径。

## 当前边界

- 此方案适用于单实例 SQLite。多实例或高可用前，须迁移到共享数据库、对象存储和分布式频控。
- CDN/对象存储接入时，不能让 blob 获得绕过 `/api/downloads` 权益校验的公开 URL。
- 邮箱验证、找回密码和真实 Video2PPT 导出器联调仍是正式公开运营前的独立验收项。
