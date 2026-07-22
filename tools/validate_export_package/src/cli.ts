#!/usr/bin/env node
import { validateExportPackage } from "@resource-gallery/export-schema";

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(`Usage: validate-export-package <package.zip>

Validates a resource-gallery.export/v1 zip package.
Exit code 0 on success, 1 on failure.
`);
    process.exit(args.length === 0 ? 1 : 0);
  }
  const file = args[0]!;
  const result = await validateExportPackage(file);
  const out = {
    ok: result.ok,
    kept: result.keptFiles.map((f) => f.path),
    stripped: result.strippedFiles.map((f) => ({ path: f.path, reason: f.strip_reason })),
    issues: result.issues
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
