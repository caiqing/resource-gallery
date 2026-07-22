import { Hono } from "hono";
import { createReadStream, existsSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { deflateSync } from "node:zlib";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { verifyDownloadToken } from "../lib/crypto.js";
import { clientKey, rateLimit } from "../middleware/rateLimit.js";

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
    .prepare(`SELECT id, title, status FROM listings WHERE id = ?`)
    .get(parsed.listingId) as any;
  if (!listing) return c.json({ error: "not found" }, 404);

  const ent = db
    .prepare(`SELECT id FROM download_entitlements WHERE user_id = ? AND listing_id = ?`)
    .get(parsed.userId, parsed.listingId);
  if (!ent) return c.json({ error: "no entitlement" }, 403);

  const fileName = c.req.query("file");
  const files = db
    .prepare(
      `SELECT filename, storage_path FROM listing_files
       WHERE listing_id = ? AND stripped = 0 AND included = 1`
    )
    .all(parsed.listingId) as { filename: string; storage_path: string }[];

  if (!files.length) return c.json({ error: "no files" }, 404);

  const target = fileName
    ? files.find((f) => f.filename === fileName)
    : files[0];
  if (!target) return c.json({ error: "file not found" }, 404);

  const listingRoot = resolve(config.blobRoot, parsed.listingId);
  const abs = resolve(listingRoot, target.storage_path);
  if (!abs.startsWith(`${listingRoot}/`)) return c.json({ error: "invalid blob path" }, 500);
  if (!existsSync(abs)) return c.json({ error: "blob missing" }, 404);
  const st = statSync(abs);
  const stream = createReadStream(abs);
  return new Response(Readable.toWeb(stream) as any, {
    headers: {
      "content-type": contentType(target.filename),
      "content-length": String(st.size),
      "content-disposition": `attachment; filename="${basename(target.filename).replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(basename(target.filename))}`,
      "cache-control": "no-store"
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
  const listingRoot = resolve(config.blobRoot, listing.id);
  const abs = resolve(listingRoot, listing.cover_path);
  if (!abs.startsWith(`${listingRoot}/`)) return c.json({ error: "invalid cover path" }, 500);
  if (!existsSync(abs)) return c.json({ error: "missing" }, 404);
  const stream = createReadStream(abs);
  const st = statSync(abs);
  return new Response(Readable.toWeb(stream) as any, {
    headers: {
      "content-type": contentType(listing.cover_path),
      "content-length": String(st.size),
      "cache-control": "public, max-age=3600"
    }
  });
});

function contentType(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".md":
    case ".txt":
      return "text/plain; charset=utf-8";
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
