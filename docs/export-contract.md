# resource-gallery.export/v1 契约

> 媒体升级后的 `resource-gallery.export/v2` 契约、导入边界和验收记录见 [媒体产物导出/导入升级方案](./2026-08-05-media-export-import-upgrade-plan.md)。v1 继续只承载核心文档与图片资源。

实施源。与 [PRD §10](./2026-07-19-resource-gallery-prd.md) 对齐。

## 原则

1. 交换物是 **不可变任务级聚合包**（`.zip`），不是 DB 直连或共享磁盘。  
2. 契约名：`resource-gallery.export/v1`。  
3. 一个 zip = 一个 `task_id` → 一个 Listing 候选；`run_id` 仅作为 v1 技术锚点和隐藏 provenance。  
4. Video2PPT 产包；Resource Gallery 校验入库。  
5. 破坏性变更必须升 `v2`。

任务包可合并同一来源范围下连续 `resume` 批次的安全产物；普通 `rerun` 不跨界合并。聚合后必须同时包含 PPT 与信息图。Resource Gallery 按 `task_id` 幂等更新 Listing，不在公开标题、摘要、搜索或展示中呈现批次序号。

## 包结构

```text
manifest.json
task_meta.json
run_meta.json
files/<artifacts...>
preview/cover.png   # 可选
```

## 校验规则（实现：`@resource-gallery/export-schema`）

| 检查 | 失败码 |
|------|--------|
| schema_version ≠ v1 | SCHEMA / SCHEMA_VERSION |
| 缺 manifest/task_meta/run_meta | MISSING_* |
| 路径 `..` / 绝对路径 | PATH_ESCAPE / PATH_ABSOLUTE |
| files 不在 `files/` 下 | FILE_PATH_PREFIX |
| sha256 / size 不匹配 | SHA256_MISMATCH / SIZE_MISMATCH |
| 剥离 video/subtitle/auth 后 0 文件 | NO_USABLE_FILES |
| 超 `MAX_PACKAGE_BYTES` | PACKAGE_TOO_LARGE |

**默认剥离 kind**：`video`、`subtitle`、`auth`，以及文件名命中 cookie/token/`.env` 等。

## CLI

```bash
pnpm --filter @resource-gallery/validate-export-package start -- ./packages/export-schema/fixtures/valid-basic.zip
```

## JSON Schema

`packages/export-schema/schema/resource-gallery.export.v1.json`

v2 schema：`packages/export-schema/schema/resource-gallery.export.v2.json`
