# 生产部署说明

本部署包面向一期的**单实例**运行方式：一个 API 容器、一个 Caddy 容器，以及持久化 SQLite 卷。它不把 Video2PPT 本机目录暴露给公网；生产导入支持 `resource-gallery.export/v1` 和受媒体策略约束的 v2 ZIP。

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

填写配置后，先运行不回显 Secret 的前置检查：

```bash
node deploy/preflight.mjs --env-file deploy/.env --mode production
```

启用机器同步前，使用 `production-review` 模式检查金丝雀配置；它要求同步令牌、审计 Actor 和 `RESOURCE_GALLERY_SYNC_MAX_REMOVED_FILES=0`：

```bash
node deploy/preflight.mjs --env-file deploy/.env --mode production-review
```

前置检查只验证配置形状和本地安全门槛，不替代 DNS、TLS、S3 连通性、IAM 权限或 24 小时灰度验收。

编辑 `deploy/.env`，至少替换以下值：

- `PUBLIC_ORIGIN`：对外唯一访问地址，例如 `https://gallery.example.com`
- `SITE_ADDRESS`：同一域名，不带协议和路径
- `SESSION_SECRET` 与 `DOWNLOAD_SIGNING_SECRET`：分别随机生成且不可复用
- `INITIAL_ADMIN_EMAIL` 与 `INITIAL_ADMIN_PASSWORD`：首个运营账号
- `BLOB_STORAGE_BACKEND=s3` 及私有 Bucket 的区域、endpoint、prefix；`compose.yaml` 会将这些变量和媒体限额注入 API 容器。凭据通过部署平台的 workload identity、实例角色或运行时 Secret 注入，不写入仓库；静态或短期凭据仅可通过部署平台 Secret 注入 `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` 和可选的 `AWS_SESSION_TOKEN`。

S3 运行身份应只访问 `BLOB_S3_PREFIX` 下的对象。以下为 AWS S3 的最小权限基线；将 `BUCKET` 与 `PREFIX` 替换为生产值。S3-compatible 服务应配置等价权限：列举该前缀、读写复制删除该前缀对象，以及完成或中止 multipart 上传。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::BUCKET",
      "Condition": {"StringLike": {"s3:prefix": ["PREFIX/*"]}}
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::BUCKET/PREFIX/*"
    }
  ]
}
```

对 Bucket 启用 Block Public Access，禁止公开 Bucket/Object ACL 与公开策略。不要为 Blob 配置 CDN 公共源站、静态网站托管或预签名公开下载；所有读取仍由 API 的权益校验和 Range 代理控制。

使用以下命令构建并启动：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

### 本机 Docker

本机演示不需要域名、TLS 或 S3。以下命令生成被 Git 忽略且权限为 `0600` 的本机配置：它使用 `filesystem` Blob 后端、禁用机器同步，并随机生成本机管理员密码和签名密钥。为了支持 `http://127.0.0.1` 登录，该配置将 `NODE_ENV=development`；生产配置仍默认使用 `production` 与 Secure Cookie。

```bash
node deploy/create-local-env.mjs
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

站点地址为 `http://127.0.0.1`。管理员邮箱固定为 `admin@resource-gallery.local`；密码仅保存在本机 `deploy/.env`，不会输出到终端。先执行下节的初始化命令创建该账号。

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

`gallery-data` 是 SQLite 数据库和导入临时文件的持久化卷。filesystem 后端还会保存 blob；S3 后端把版本化 blob 写入私有 Bucket。上线前应按宿主机或云平台能力为数据库与 Bucket 配置备份；不要用 `down -v` 清理生产环境，也不要将其目录公开映射为静态下载路径。

## 当前边界

- 此方案适用于单实例 SQLite。对象存储已支持 S3-compatible multipart；多实例或高可用前仍须迁移到共享数据库和分布式频控。
- CDN/对象存储接入时，不能让 blob 获得绕过 `/api/downloads` 权益校验的公开 URL。
- 邮箱验证、找回密码和真实 Video2PPT 导出器联调仍是正式公开运营前的独立验收项。
