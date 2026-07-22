# 运营导入与上架手册

## 流程

```text
Video2PPT 完成 run
  → 导出 resource-gallery.export/v1 zip
  → Admin 登录资源站
  → 导入 Job 上传 zip
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
3. 策展页无 video/auth 可勾选（已锁定剥离）  
4. 至少 1 个 included 文件  
5. 发布后 C 端搜索/首页可见  
6. 审计：Admin 导入与发布写入 `audit_logs`

## 失败处理

| 现象 | 处理 |
|------|------|
| Job failed：schema | 核对导出器版本 |
| NO_USABLE_FILES | 包内仅有源视频/认证材料 |
| 已发布重复导入 | 换 run 或先下架；不自动复制 published |
| 用户 403 导入 | 预期：仅 admin |

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
4. 验证对象存储文件无法绕过 `/api/downloads/:listingId?token=...` 直接访问。  
5. 上线前执行 `pnpm test && pnpm build`，再走一遍注册、点赞、购买与举报。
