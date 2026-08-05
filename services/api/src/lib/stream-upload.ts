import busboy from "busboy";
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { dirname, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export class MultipartUploadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415 = 400
  ) {
    super(message);
    this.name = "MultipartUploadError";
  }
}

export type StreamedUpload = {
  filename: string;
  sizeBytes: number;
};

/**
 * Writes the only accepted multipart file directly to a temporary ZIP path.
 * The request body is never materialized as a File, ArrayBuffer, or Buffer.
 */
export async function streamZipMultipartUpload(
  request: Request,
  destination: string,
  maxBytes: number
): Promise<StreamedUpload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data(?:;|$)/i.test(contentType)) {
    throw new MultipartUploadError("请求必须是 multipart/form-data", 415);
  }
  if (!request.body) throw new MultipartUploadError("请求体为空");

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  // Multipart framing has a small overhead; actual file size is always checked below.
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes + 1024 * 1024) {
    throw new MultipartUploadError("包体积超限", 413);
  }

  mkdirSync(dirname(destination), { recursive: true });
  let uploaded: StreamedUpload | undefined;
  let fileWrite: Promise<void> | undefined;
  let failure: MultipartUploadError | undefined;

  const reject = (message: string, status: 400 | 413 | 415 = 400) => {
    failure ??= new MultipartUploadError(message, status);
  };
  const parser = busboy({
    headers: { "content-type": contentType },
    preservePath: false,
    limits: {
      // Busboy emits the corresponding *Limit event when a limit is reached,
      // not only after a second part arrives. Keep one spare slot and enforce
      // the single-file policy in the event handlers below.
      files: 2,
      fields: 1,
      parts: 2,
      fileSize: maxBytes,
      headerPairs: 64
    }
  });

  parser.on("file", (fieldName, file, info) => {
    if (fieldName !== "file") {
      reject("仅接受 zip 文件字段 file");
      file.resume();
      return;
    }
    if (!info.filename || extname(info.filename).toLowerCase() !== ".zip") {
      reject("仅接受 .zip");
      file.resume();
      return;
    }
    if (uploaded || fileWrite) {
      reject("仅允许上传一个 zip 文件");
      file.resume();
      return;
    }

    let sizeBytes = 0;
    uploaded = { filename: info.filename, sizeBytes: 0 };
    file.on("data", (chunk: Buffer) => {
      sizeBytes += chunk.byteLength;
    });
    file.on("limit", () => reject("包体积超限", 413));
    fileWrite = pipeline(file, createWriteStream(destination, { flags: "wx", mode: 0o600 })).then(() => {
      if (file.truncated || sizeBytes > maxBytes) reject("包体积超限", 413);
      if (uploaded) uploaded.sizeBytes = sizeBytes;
    });
  });
  parser.on("filesLimit", () => reject("仅允许上传一个 zip 文件"));
  parser.on("fieldsLimit", () => reject("不接受额外表单字段"));
  parser.on("partsLimit", () => reject("仅允许上传一个 zip 文件"));

  try {
    await pipeline(Readable.fromWeb(request.body as never), parser);
    await fileWrite;
    if (failure) throw failure;
    if (!uploaded) throw new MultipartUploadError("需要上传 zip 文件字段 file");
    return uploaded;
  } catch (error) {
    rmSync(destination, { force: true });
    if (error instanceof MultipartUploadError) throw error;
    throw new MultipartUploadError("上传流读取失败");
  }
}
