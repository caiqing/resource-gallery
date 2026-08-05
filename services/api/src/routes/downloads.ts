import { Hono } from "hono";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { getDb } from "../db/client.js";
import { blobStore } from "../lib/blob-store.js";
import { verifyDownloadToken } from "../lib/crypto.js";
import { clientKey, rateLimit } from "../middleware/rateLimit.js";
import { isPreviewableArtifact } from "../lib/import.js";
import { parseByteRange } from "../lib/http-range.js";

export const downloadRoutes = new Hono();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makeDefaultCover(): Buffer {
  const width = 1200;
  const height = 630;
  const stride = width + 1;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const offset = row * stride;
    pixels[offset] = 0;
    pixels.fill(235, offset + 1, offset + stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

const defaultCover = makeDefaultCover();

function u16(n: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n);
  return buf;
}

function u32(n: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0);
  return buf;
}

function crc32Update(crc: number, buffer: Buffer): number {
  let next = crc;
  for (const byte of buffer) {
    next ^= byte;
    for (let bit = 0; bit < 8; bit++) next = (next >>> 1) ^ (next & 1 ? 0xedb88320 : 0);
  }
  return next >>> 0;
}

async function* streamStoredZip(entries: { name: string; listingId: string; storagePath: string }[]): AsyncGenerator<Buffer> {
  const records: { name: Buffer; crc: number; size: number; offset: number }[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0808), u16(0), u16(0), u16(0),
      u32(0), u32(0), u32(0), u16(name.length), u16(0), name
    ]);
    const localOffset = offset;
    offset += localHeader.length;
    yield localHeader;
    let crc = 0xffffffff;
    let size = 0;
    const source = await blobStore.open(entry.listingId, entry.storagePath);
    for await (const chunk of source.stream) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      crc = crc32Update(crc, data);
      size += data.length;
      offset += data.length;
      yield data;
    }
    const finalCrc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = Buffer.concat([u32(0x08074b50), u32(finalCrc), u32(size), u32(size)]);
    offset += descriptor.length;
    yield descriptor;
    records.push({ name, crc: finalCrc, size, offset: localOffset });
  }
  const centralOffset = offset;
  let centralSize = 0;
  for (const record of records) {
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(0), u16(0), u16(0),
      u32(record.crc), u32(record.size), u32(record.size), u16(record.name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(record.offset), record.name
    ]);
    centralSize += central.length;
    yield central;
  }
  yield Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(records.length), u16(records.length),
    u32(centralSize), u32(centralOffset), u16(0)
  ]);
}

downloadRoutes.get("/:listingId", async (c) => {
  const token = c.req.query("token") ?? "";
  const parsed = verifyDownloadToken(token);
  if (!parsed || parsed.listingId !== c.req.param("listingId")) {
    return c.json({ error: "invalid or expired token" }, 403);
  }
  if (!rateLimit(clientKey(c, `download:${parsed.userId}`), 60, 60_000)) {
    return c.json({ error: "too many requests" }, 429);
  }
  const db = getDb();
  const listing = db
    .prepare(`SELECT id, title, status, active_version_id FROM listings WHERE id = ?`)
    .get(parsed.listingId) as any;
  if (!listing) return c.json({ error: "not found" }, 404);

  const ent = db
    .prepare(`SELECT id FROM download_entitlements WHERE user_id = ? AND listing_id = ?`)
    .get(parsed.userId, parsed.listingId);
  const account = db
    .prepare(`SELECT role FROM users WHERE id = ?`)
    .get(parsed.userId) as { role?: string } | undefined;
  if (!ent && account?.role !== "admin") return c.json({ error: "no entitlement" }, 403);

  const fileName = c.req.query("file");
  const files = listing.active_version_id
    ? db.prepare(
        `SELECT filename, storage_path, mime_type FROM listing_assets
         WHERE version_id = ? AND stripped = 0 AND included = 1
           AND kind NOT IN ('poster', 'preview_audio', 'preview_video')
         ORDER BY filename`
      ).all(listing.active_version_id) as { filename: string; storage_path: string; mime_type?: string | null }[]
    : db.prepare(
        `SELECT filename, storage_path, NULL AS mime_type FROM listing_files
         WHERE listing_id = ? AND stripped = 0 AND included = 1
         ORDER BY filename`
      ).all(parsed.listingId) as { filename: string; storage_path: string; mime_type?: string | null }[];

  if (!files.length) return c.json({ error: "no files" }, 404);

  const sendFile = async (target: { filename: string; storage_path: string; mime_type?: string | null }) => {
    try {
      const source = await blobStore.open(parsed.listingId, target.storage_path);
      return new Response(Readable.toWeb(source.stream) as any, {
      headers: {
        "content-type": target.mime_type || contentType(target.filename),
        "content-length": String(source.size),
        "content-disposition": contentDisposition("attachment", target.filename),
        "cache-control": "no-store"
      }
    });
    } catch {
      return c.json({ error: "blob missing or invalid" }, 404);
    }
  };


  if (fileName) {
    const target = files.find((f) => f.filename === fileName);
    if (!target) return c.json({ error: "file not found" }, 404);
    return await sendFile(target);
  }

  if (files.length === 1) {
    return await sendFile(files[0]);
  }

  const usedNames = new Map<string, number>();
  const zipEntries: { name: string; listingId: string; storagePath: string }[] = [];
  for (const file of files) {
    let name = basename(file.filename) || "file";
    const count = usedNames.get(name) || 0;
    usedNames.set(name, count + 1);
    if (count > 0) {
      const ext = extname(name);
      const stem = ext ? name.slice(0, -ext.length) : name;
      name = `${stem}-${count + 1}${ext}`;
    }
    zipEntries.push({ name, listingId: parsed.listingId, storagePath: file.storage_path });
  }
  const displayName = `${String(listing.title || listing.id).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || listing.id}.zip`;
  const asciiName = `${String(listing.id)}.zip`;
  return new Response(Readable.toWeb(Readable.from(streamStoredZip(zipEntries))) as any, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`,
      "cache-control": "no-store"
    }
  });
});


downloadRoutes.get("/:listingId/preview", async (c) => {
  if (!rateLimit(clientKey(c, "preview"), 120, 60_000)) {
    return c.json({ error: "too many requests" }, 429);
  }
  const listingId = c.req.param("listingId");
  const fileName = c.req.query("file") ?? "";
  if (!fileName) return c.json({ error: "file required" }, 400);

  const db = getDb();
  const listing = db
    .prepare(
      `SELECT id, status, active_version_id FROM listings WHERE id = ? AND status IN ('published','unlisted')`
    )
    .get(listingId) as { id: string; status: string; active_version_id: string | null } | undefined;
  if (!listing) return c.json({ error: "not found" }, 404);

  const file = db
    .prepare(
      listing.active_version_id
        ? `SELECT kind, filename, storage_path, preview_policy, mime_type, included, stripped
           FROM listing_assets WHERE version_id = ? AND filename = ?`
        : `SELECT kind, filename, storage_path, is_previewable, NULL AS preview_policy, NULL AS mime_type, included, stripped
           FROM listing_files WHERE listing_id = ? AND filename = ?`
    )
    .get(listing.active_version_id ?? listingId, fileName) as
    | {
        kind: string;
        filename: string;
        storage_path: string;
        is_previewable?: number;
        preview_policy?: string | null;
        mime_type?: string | null;
        included: number;
        stripped: number;
      }
    | undefined;

  let publicPreview = false;
  let entitlementPreview = false;
  if (file && !file.stripped) {
    if (listing.active_version_id) {
      // Derived media previews are deliberately not part of the download set.
      // Full audio/video overview kinds are deliberately excluded here.
      const isDerivedMediaPreview = ["poster", "preview_audio", "preview_video"].includes(file.kind);
      const isFullMedia = ["audio_overview", "video_overview"].includes(file.kind);
      publicPreview = file.preview_policy === "public" && (
        isDerivedMediaPreview ||
        (!isFullMedia && isPreviewableArtifact(file.kind, file.filename))
      );
      if (!publicPreview && Boolean(file.included)) {
        const user = c.get("user") as { id?: string; role?: string } | undefined;
        entitlementPreview = Boolean(user?.id && db.prepare(
          `SELECT id FROM download_entitlements WHERE user_id = ? AND listing_id = ?`
        ).get(user.id, listingId)) || user?.role === "admin";
      }
    } else {
      publicPreview = Boolean(file.included) && (
        file.is_previewable === 1 || isPreviewableArtifact(file.kind, file.filename)
      );
    }
  }
  const canPreview = publicPreview || entitlementPreview;
  if (!file || !canPreview) {
    return c.json({ error: "preview unavailable" }, 403);
  }

  // Entitlement responses must never be stored by shared caches under the
  // same URL that anonymous visitors can request.
  const cacheHeaders: Record<string, string> = entitlementPreview
    ? { "cache-control": "private, no-store", vary: "Cookie, Authorization" }
    : { "cache-control": "public, max-age=300" };

  let source;
  try {
    source = await blobStore.open(listingId, file.storage_path);
  } catch {
    return c.json({ error: "blob missing" }, 404);
  }
  const size = source.size;
  const range = c.req.header("range");
  if (range) {
    const parsedRange = parseByteRange(range, size);
    if (!parsedRange) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}` }
      });
    }
    const { start, end } = parsedRange;
    try {
      const ranged = await blobStore.open(listingId, file.storage_path, { start, end });
      return new Response(Readable.toWeb(ranged.stream) as any, {
      status: 206,
      headers: {
        "content-type": file.mime_type || contentType(file.filename),
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
        "accept-ranges": "bytes",
        "content-disposition": contentDisposition("inline", file.filename),
        ...cacheHeaders
      }
    });
    } catch {
      return c.json({ error: "blob missing" }, 404);
    }
  }
  return new Response(Readable.toWeb(source.stream) as any, {
    headers: {
      "content-type": file.mime_type || contentType(file.filename),
      "content-length": String(size),
      "accept-ranges": "bytes",
      "content-disposition": contentDisposition("inline", file.filename),
      ...cacheHeaders
    }
  });
});

downloadRoutes.get("/:listingId/cover", async (c) => {
  const db = getDb();
  const listing = db
    .prepare(
      `SELECT id, cover_path, status FROM listings WHERE id = ? AND status IN ('published','unlisted')`
    )
    .get(c.req.param("listingId")) as any;
  if (!listing) return c.json({ error: "not found" }, 404);
  if (!listing.cover_path || !isImageFile(listing.cover_path)) {
    return new Response(new Uint8Array(defaultCover), {
      headers: {
        "content-type": "image/png",
        "content-length": String(defaultCover.length),
        "cache-control": "public, max-age=3600"
      }
    });
  }
  try {
    const source = await blobStore.open(listing.id, listing.cover_path);
    return new Response(Readable.toWeb(source.stream) as any, {
      headers: {
        "content-type": contentType(listing.cover_path),
        "content-length": String(source.size),
        "cache-control": "public, max-age=3600"
      }
    });
  } catch {
    return c.json({ error: "missing" }, 404);
  }
});


function asciiFilename(filename: string): string {
  const base = basename(filename || "file");
  const ascii = base.replace(/[^\x20-\x7E]+/g, "_").replace(/["\\]/g, "_");
  return ascii || "file";
}

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = asciiFilename(filename);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(basename(filename || ascii))}`;
}

function contentType(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".md":
    case ".markdown":
    case ".mdx":
      return "text/markdown; charset=utf-8";
    case ".txt":
    case ".srt":
    case ".vtt":
      return "text/plain; charset=utf-8";
    case ".mp4":
      return "video/mp4";
    case ".m4a":
      return "audio/mp4";
    case ".webm":
      return "video/webm";
    case ".mov":
      return "video/quicktime";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

function isImageFile(filename: string): boolean {
  return [".png", ".jpg", ".jpeg", ".webp"].includes(extname(filename).toLowerCase());
}
