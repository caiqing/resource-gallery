import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { config } from "../config.js";

export type BlobRead = { stream: Readable; size: number };
export type PromotedDirectory = { rollback(): Promise<void> };

function safeRelativePath(path: string): string {
  const normalized = String(path || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === ".." || !part)) {
    throw new Error("BLOB_PATH_INVALID");
  }
  return normalized;
}

function nodeReadable(value: unknown): Readable {
  if (value instanceof Readable) return value;
  if (value && typeof (value as { getReader?: unknown }).getReader === "function") {
    return Readable.fromWeb(value as any);
  }
  throw new Error("BLOB_STREAM_UNAVAILABLE");
}

function localPath(listingId: string, storagePath: string): string {
  const listingRoot = resolve(config.blobRoot, listingId);
  const target = resolve(listingRoot, safeRelativePath(storagePath));
  const rel = relative(listingRoot, target);
  if (!rel || rel.startsWith("..") || rel.includes("\0")) throw new Error("BLOB_PATH_INVALID");
  return target;
}

function regularFiles(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error("BLOB_STAGING_SYMLINK");
      if (metadata.isDirectory()) walk(path);
      else if (metadata.isFile()) rows.push(path);
      else throw new Error("BLOB_STAGING_ENTRY_INVALID");
    }
  };
  walk(root);
  return rows;
}

class S3BlobStore {
  private readonly client: S3Client;

  constructor() {
    if (!config.blobS3Bucket) throw new Error("BLOB_S3_BUCKET_MISSING");
    this.client = new S3Client({
      region: config.blobS3Region,
      endpoint: config.blobS3Endpoint || undefined,
      forcePathStyle: config.blobS3ForcePathStyle
    });
  }

  private key(...parts: string[]): string {
    return [config.blobS3Prefix, ...parts.map(safeRelativePath)].filter(Boolean).join("/");
  }

  private listingKey(listingId: string, storagePath: string): string {
    return this.key("listings", listingId, storagePath);
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    await Promise.all(keys.map((Key) => this.client.send(new DeleteObjectCommand({ Bucket: config.blobS3Bucket, Key }))));
  }

  async open(listingId: string, storagePath: string, range?: { start: number; end: number }): Promise<BlobRead> {
    const Key = this.listingKey(listingId, storagePath);
    const head = await this.client.send(new HeadObjectCommand({ Bucket: config.blobS3Bucket, Key }));
    const size = Number(head.ContentLength ?? 0);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("BLOB_METADATA_INVALID");
    const response = await this.client.send(new GetObjectCommand({
      Bucket: config.blobS3Bucket,
      Key,
      Range: range ? `bytes=${range.start}-${range.end}` : undefined
    }));
    if (!response.Body) throw new Error("BLOB_STREAM_UNAVAILABLE");
    return { stream: nodeReadable(response.Body), size };
  }

  async promoteDirectory(stagingDir: string, listingId: string, versionPrefix: string, jobId: string): Promise<PromotedDirectory> {
    const files = regularFiles(stagingDir);
    const stagingKeys: string[] = [];
    const finalKeys: string[] = [];
    try {
      for (const source of files) {
        const relativePath = safeRelativePath(relative(stagingDir, source));
        const stagingKey = this.key("staging", jobId, listingId, versionPrefix, relativePath);
        const finalKey = this.listingKey(listingId, `${versionPrefix}/${relativePath}`);
        await new Upload({
          client: this.client,
          params: { Bucket: config.blobS3Bucket, Key: stagingKey, Body: createReadStream(source) },
          queueSize: 4,
          partSize: 8 * 1024 * 1024,
          leavePartsOnError: false
        }).done();
        stagingKeys.push(stagingKey);
        await this.client.send(new CopyObjectCommand({
          Bucket: config.blobS3Bucket,
          Key: finalKey,
          CopySource: `${config.blobS3Bucket}/${encodeURIComponent(stagingKey).replace(/%2F/g, "/")}`
        }));
        finalKeys.push(finalKey);
      }
      await this.deleteKeys(stagingKeys);
      rmSync(stagingDir, { recursive: true, force: true });
      return { rollback: async () => this.deleteKeys(finalKeys) };
    } catch (error) {
      await this.deleteKeys([...stagingKeys, ...finalKeys]).catch(() => undefined);
      throw error;
    }
  }

  async removePrefix(prefix: string): Promise<void> {
    const Prefix = this.key(prefix);
    let ContinuationToken: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: config.blobS3Bucket, Prefix, ContinuationToken }));
      await this.deleteKeys((page.Contents ?? []).flatMap((item) => item.Key ? [item.Key] : []));
      ContinuationToken = page.NextContinuationToken;
    } while (ContinuationToken);
  }
}

class FilesystemBlobStore {
  async open(listingId: string, storagePath: string, range?: { start: number; end: number }): Promise<BlobRead> {
    const path = localPath(listingId, storagePath);
    if (!existsSync(path)) throw new Error("BLOB_NOT_FOUND");
    const size = statSync(path).size;
    return { stream: createReadStream(path, range), size };
  }

  async promoteDirectory(stagingDir: string, listingId: string, versionPrefix: string): Promise<PromotedDirectory> {
    const target = localPath(listingId, versionPrefix);
    mkdirSync(resolve(target, ".."), { recursive: true });
    rmSync(target, { recursive: true, force: true });
    renameSync(stagingDir, target);
    return { rollback: async () => rmSync(target, { recursive: true, force: true }) };
  }

  async removePrefix(prefix: string): Promise<void> {
    rmSync(resolve(config.blobRoot, safeRelativePath(prefix)), { recursive: true, force: true });
  }
}

const filesystem = new FilesystemBlobStore();
let s3: S3BlobStore | undefined;

function activeStore(): FilesystemBlobStore | S3BlobStore {
  if (config.blobStorageBackend === "filesystem") return filesystem;
  return s3 ??= new S3BlobStore();
}

export const blobStore = {
  open: (listingId: string, storagePath: string, range?: { start: number; end: number }) => activeStore().open(listingId, storagePath, range),
  promoteDirectory: (stagingDir: string, listingId: string, versionPrefix: string, jobId: string) => activeStore().promoteDirectory(stagingDir, listingId, versionPrefix, jobId),
  removePrefix: (prefix: string) => activeStore().removePrefix(prefix)
};
