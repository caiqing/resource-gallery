# @resource-gallery/export-schema

`resource-gallery.export/v1` JSON Schema、类型与校验实现。

## 使用

```ts
import { validateExportPackage } from "@resource-gallery/export-schema";

const result = await validateExportPackage("./package.zip");
```

## Fixtures

- `valid-basic.zip`：带显式封面的标准合法包。
- `valid-design.zip`：无显式封面，用于验证默认位图回退。
- `valid-product.zip`：合法混合包，含一个必须剥离的 `video` 文件。
- `invalid-*`：覆盖全视频、错误 schema 与不安全路径。

```bash
pnpm test
```
