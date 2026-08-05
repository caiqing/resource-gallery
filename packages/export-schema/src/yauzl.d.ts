declare module "yauzl" {
  import type { Readable } from "node:stream";
  export interface Entry {
    fileName: string;
    uncompressedSize: number;
  }
  export interface ZipFile {
    readEntry(): void;
    openReadStream(
      entry: Entry,
      cb: (err: Error | null, stream?: Readable) => void
    ): void;
    on(event: "entry", cb: (entry: Entry) => void): void;
    on(event: "end", cb: () => void): void;
    on(event: "error", cb: (err: Error) => void): void;
    close(): void;
  }
  export function open(
    path: string,
    options: { lazyEntries?: boolean; autoClose?: boolean },
    cb: (err: Error | null, zipfile?: ZipFile) => void
  ): void;
}
