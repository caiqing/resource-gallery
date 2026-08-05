#!/usr/bin/env node
import { readV1PackageMetadata, readV2PackageMetadata, validateExportPackage } from "@resource-gallery/export-schema";

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(`Usage: validate-export-package [--metadata-only] <package.zip>

Validates a resource-gallery.export/v1 or v2 zip package. --metadata-only validates
the ZIP directory, metadata and manifest relationships without reading every asset body.
Exit code 0 on success, 1 on failure.
`);
    process.exit(args.length === 0 ? 1 : 0);
  }
  const metadataOnly = args.includes("--metadata-only");
  const file = args.find((arg) => arg !== "--metadata-only");
  if (!file) {
    console.error("package.zip required");
    process.exit(1);
  }
  const result = metadataOnly
    ? await readV2PackageMetadata(file).then((v2) =>
        v2.manifest?.schema_version === "resource-gallery.export/v1" ? readV1PackageMetadata(file) : v2
      )
    : await validateExportPackage(file);
  const out = {
    ok: result.ok,
    schema_version: result.manifest?.schema_version,
    metadata_only: metadataOnly,
    kept: "keptFiles" in result ? result.keptFiles.map((f) => f.path) : undefined,
    stripped: "strippedFiles" in result ? result.strippedFiles.map((f) => ({ path: f.path, reason: f.strip_reason })) : undefined,
    issues: result.issues
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
