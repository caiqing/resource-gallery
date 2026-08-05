# @resource-gallery/export-schema

`resource-gallery.export/v1` 与 `resource-gallery.export/v2` JSON Schema、类型与校验实现。

v1 只承载核心文档/图片资源并保持兼容；AI 播客、视频概览及其预览衍生物使用 v2。

JSON Schema 可通过包子路径引用：

```text
@resource-gallery/export-schema/schema/resource-gallery.export.v1.json
@resource-gallery/export-schema/schema/resource-gallery.export.v2.json
```

## 使用

```ts
import { validateExportPackage } from "@resource-gallery/export-schema";

const result = await validateExportPackage("./package.zip");
```

## Fixtures

- `valid-basic.zip`：带显式封面的标准合法包。
- `valid-design.zip`：无显式封面，用于验证默认位图回退。
- `valid-product.zip`：合法混合包，包含可导入的视频文件。
- `valid-video-only.zip`：仅含视频的合法资源包。
- `valid-v2-core.zip`：v2 核心资料包。
- `valid-v2-media.zip`：v2 AI 播客与试听衍生物包。
- `invalid-*`：覆盖错误 schema 与不安全路径。

```bash
pnpm test
```
