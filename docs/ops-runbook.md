# 运营导入与上架手册

## 流程

```text
Video2PPT 完成 run
  → 核心资料导出 v1；含 AI 播客/视频概览时导出 v2
  → 手工 Admin 上传，或受限机器同步（默认关闭）
  → 系统校验 / 剥离危险文件 → Listing draft
  → 策展：标题 / 摘要 / 标签 / 价格档 / 勾选文件
  → 发布 published
  → C 端画廊可见
```

## 本地开发账号

账号邮箱和密码存放在仓库根目录 `.env`，不要写入源码、文档或提交记录。首次配置：

```bash
cp .env.example .env
# 填写所有空白的签名密钥和密码字段
chmod 600 .env
```

如数据库中已有本地管理员和测试用户，修改 `.env` 后执行以下命令同步密码哈希。该操作不会重建数据库，也不会修改 Listing、订单或 Credits：

```bash
pnpm --filter @resource-gallery/api sync:seed-credentials
```

## 导入检查清单

1. zip 扩展名与体积未超限  
2. Job 状态 `succeeded`，有 `listing_id`  
3. v2 资产中 `audio_overview` / `video_overview` 默认未纳入，确认正确主版本后再勾选
4. `preview_audio` / `preview_video` / `poster` 仅作为公开衍生预览，不加入下载集合
5. 策展页无 video/auth 可勾选（已锁定剥离）
6. 至少 1 个 included 文件
7. 发布后 C 端搜索/首页可见
8. 审计：Admin 导入与发布写入 `audit_logs`

## 摘要模型配置

管理员可在“模型配置”页面维护 Resource Gallery 自己的 OpenAI 兼容模型配置。系统按“主模型 → 备用模型 → 本地正文摘要”降级，不依赖 Video2PPT 进程或其本地配置文件。

- API Key 只写入根目录 `.env`，接口仅返回 `api_key_configured`，不会回显明文。
- 留空 API Key 表示保留现有值；更新配置后立即对新请求生效。
- 启用且已配置密钥时，保存操作会在后台补偿未锁定的 `fallback/failed` 摘要。
- 运营手工修改并锁定的摘要不会被补偿或重新导入覆盖。
- 模型配置、连接测试和补偿接口均要求管理员会话；配置更新写入审计日志。

## 失败处理

| 现象 | 处理 |
|------|------|
| Job failed：schema | 核对导出器版本 |
| MEDIA_METADATA_MISMATCH / MEDIA_PROBE_FAILED | 在 Video2PPT 端重新生成并用 `ffprobe` 检查媒体；不要手工修改 manifest |
| PREVIEW_FILE_TOO_LARGE | 降低预览时长/码率；完整媒体仍保持未公开，不能把完整媒体改标为 preview |
| NO_USABLE_FILES | 包内仅有源视频/认证材料 |
| `REMOVED_ASSETS_EXCEED_LIMIT` / `CORE_ASSETS_DECREASED` | 自动发布已降级为 review；核对资产删除和核心资料数量后手工发布 |
| 已发布资源更新 | 导入会生成 draft version，旧公开版本和封面保持可用；审核后才原子切换 |
| 用户 403 导入 | 预期：仅 admin |

## Video2PPT 定时同步

机器同步默认关闭。开启前必须满足：资源站已有指定的 admin 作为审计 actor；同步令牌以独立 Secret 管理；先完成至少三个真实任务（金丝雀音频、视频、混合包）的 `dry-run`。

资源站配置：

```dotenv
RESOURCE_GALLERY_SYNC_ENABLED=true
RESOURCE_GALLERY_SYNC_ACTOR_EMAIL=admin@example.com
RESOURCE_GALLERY_SYNC_TOKEN=<独立随机令牌>
RESOURCE_GALLERY_SYNC_MAX_REMOVED_FILES=0
RESOURCE_GALLERY_SYNC_MAX_ATTEMPTS=3
```

Video2PPT 使用既有 SecretProvider 的 `resource_gallery_sync_token`，不要把令牌写入命令行、`.env`、JSONL 报告或日志。先运行只读预检：

```bash
cd "<video2ppt-root>/backend"
export RESOURCE_GALLERY_URL="https://gallery.example.com"
export RESOURCE_GALLERY_ROOT="<resource-gallery-root>"
uv run python tools/sync_resource_gallery.py --dry-run
```

确认后，先以 `review` 同步；同步器会使用不读取完整媒体内容的消费者元数据预检、进程锁、服务端指纹、短退避重试和逐任务 JSONL 报告。`X-Resource-Gallery-Task-Id` 必须等于 ZIP 内 `manifest.task_id`，不匹配会以 `SYNC_TASK_ID_MISMATCH` 拒绝，且不会创建 ListingVersion 或 blob；`X-Resource-Gallery-Track-State: false` 只关闭状态落库，不会放宽此身份校验。资产 SHA-256 仍由资源站导入时逐条目流式复核：

```bash
uv run python tools/sync_resource_gallery.py \
  --mode scheduled \
  --publish-policy review
```

只有金丝雀稳定后才可使用 `auto_publish`。门禁要求有效导入、至少一个已纳入的安全资产、核心资产数量不下降，以及删除数量不超过阈值；不满足时停留在 `review`，当前公开版本不变。

```bash
uv run python tools/sync_resource_gallery.py \
  --task-id "<task_id>" \
  --publish-policy auto_publish
```

同步状态保存在 `resource_sync_runs` / `resource_sync_states`。元数据和导入拒绝会保留稳定错误码前缀，例如 `PACKAGE_TOO_LARGE`、`PACKAGE_UNCOMPRESSED_TOO_LARGE`、`PREVIEW_FILE_TOO_LARGE` 与 `SYNC_TASK_ID_MISMATCH`；受限指标端点为 `GET /api/sync/metrics`，必须携带同一 Bearer 令牌；告警至少覆盖运行失败、任务 `failed`、持续 `review` 和自动发布门禁失败。

Prometheus 接入可从以下无密钥模板开始：

- [`deploy/observability/prometheus-resource-gallery-scrape.example.yml`](../deploy/observability/prometheus-resource-gallery-scrape.example.yml)：受限 metrics 抓取任务；将目标域名替换为实际域名。
- [`deploy/observability/resource-gallery-sync-alerts.example.yml`](../deploy/observability/resource-gallery-sync-alerts.example.yml)：运行失败、任务失败、超过 24 小时的 review 及自动发布门禁拦截规则。

将同步令牌单独写入 Prometheus 主机的 `/etc/prometheus/secrets/resource-gallery-sync-token`，内容仅为令牌本身并设置为 `0600`；不要将它写入 YAML、镜像层、Git 或告警注释。加载前执行 `promtool check config` 与 `promtool check rules`，再确认 Prometheus 的目标页显示 `resource-gallery-sync` 为 `UP`。`resource_gallery_sync_review_oldest_age_seconds` 为最久 review 的持续秒数，`resource_gallery_sync_gate_reviews_total` 为当前被自动发布门禁拦截的 review 数量。

在三类金丝雀导入完成后，可使用 Canary Watch 记录 24 小时同步健康证据。令牌从权限为 `0600` 的文件读取，不会出现在命令行或输出中；`--once` 用于先做一次连通性检查：

```bash
node deploy/canary-watch.mjs \
  --base-url https://gallery.example.com \
  --token-file /etc/resource-gallery/sync-token \
  --once
```

确认一次检查成功后运行默认 24 小时观察：

```bash
node deploy/canary-watch.mjs \
  --base-url https://gallery.example.com \
  --token-file /etc/resource-gallery/sync-token \
  --canary-report "<video2ppt-root>/backend/exports/sync-reports/<audio-stamp>/sync.jsonl" \
  --canary-report "<video2ppt-root>/backend/exports/sync-reports/<video-stamp>/sync.jsonl" \
  --canary-report "<video2ppt-root>/backend/exports/sync-reports/<mixed-stamp>/sync.jsonl" \
  --interval-seconds 60 \
  --duration-seconds 86400
```

传入一个或多个 `--canary-report` 时，观察器会合并 JSONL 后要求其中存在三个不同 `task_id` 的成功同步画像：`audio`、`video`、`mixed`；同步器会在 JSONL 中写入 `canary_profile` 和安全的 `asset_kinds`，不会写入文件内容或凭据。观察器以首次指标为基线；新增失败运行、失败任务、失败导入、自动发布门禁异常、健康端点非 2xx 或 review 超过 24 小时会返回非零状态。它不替代 Prometheus 对用户端 5xx、对象存储泄漏和下载越权的告警。

## 调账

Admin → 调账赠送：按邮箱增减 credits，写 ledger + audit。

## 治理

1. Admin → 用户与治理：查看用户余额、作者应收、订单数与最近审计。  
2. 登录用户可在资源详情提交版权、危险内容、误导或其他举报。  
3. 运营可驳回，或“下架并结案”；两种处理均写 `report.resolve` 审计。  
4. 下架阻止新用户浏览/购买；已有 entitlement 仍可使用短时签名 URL 下载。

## 交易配置

- 价格档位更新在 Listing 下次保存时生效，不改历史 Order。  
- 分成变更创建新版本；新订单读取最新版，历史 Order 保留 bps 快照。  
- `pending_earnings` 仅表示作者应收，一期不可兑现。

## 生产检查

1. 设置 `NODE_ENV=production`、`SESSION_SECRET`、`DOWNLOAD_SIGNING_SECRET`。  
2. 不设置 `SEED_USERS=true`，确认生产没有默认本地账号。  
3. 反向代理 `/api/*`、`/health`、`/s/*`；验证 `/s/:slug` 返回 OG HTML。  
4. 生产使用 `BLOB_STORAGE_BACKEND=s3` 时，配置私有 Bucket、IAM 最小权限、区域/endpoint/prefix；不得授予匿名读取。运行身份仅限 `BLOB_S3_PREFIX` 下的列举、读写、复制、删除与 multipart 操作，策略模板见 [生产部署说明](./deployment.md)。媒体先 multipart 上传到 staging key，再复制到 Listing version key。
5. 验证对象存储文件无法绕过 `/api/downloads/:listingId?token=...` 直接访问，并用已购账户验证完整媒体 Range。
6. 上线前执行 `pnpm test && pnpm build`，再走一遍注册、点赞、购买、举报和三类媒体金丝雀。
