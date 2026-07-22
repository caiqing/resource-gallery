export const SCHEMA_VERSION = "resource-gallery.export/v1" as const;

export type ArtifactKind =
  | "slide_pdf"
  | "slide_deck"
  | "infographic"
  | "content"
  | "blueprint"
  | "prompt"
  | "source_context"
  | "video"
  | "subtitle"
  | "auth"
  | "other";

export interface ManifestFile {
  path: string;
  name: string;
  kind: ArtifactKind;
  sha256: string;
  size_bytes: number;
  default_include?: boolean;
  source_run_id?: string;
}

export interface ExportManifest {
  schema_version: typeof SCHEMA_VERSION;
  exported_at: string;
  generated_by?: {
    product?: string;
    product_version?: string;
  };
  task_id: string;
  run_id: string;
  run_index: number;
  title: string;
  files: ManifestFile[];
  excluded_by_default_kinds?: string[];
  package_sha256?: string;
  export_scope?: "run" | "task";
  source_run_ids?: string[];
}

export interface TaskMeta {
  task_id: string;
  title: string;
  source_platform_types?: string[];
  language?: string;
}

export interface RunMeta {
  run_id: string;
  run_index: number;
  selected_source_count?: number;
  artifact_names?: string[];
  completed_phases?: string[];
  export_scope?: "run" | "task";
  source_run_ids?: string[];
  composition_policy?: string;
}

export const DEFAULT_INCLUDE_KINDS: ArtifactKind[] = [
  "slide_pdf",
  "slide_deck",
  "infographic",
  "content",
  "blueprint",
  "prompt",
  "source_context"
];

export const DEFAULT_STRIP_KINDS: ArtifactKind[] = [
  "video",
  "subtitle",
  "auth"
];

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidatedFile {
  path: string;
  name: string;
  kind: ArtifactKind;
  sha256: string;
  size_bytes: number;
  default_include: boolean;
  stripped: boolean;
  strip_reason?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  manifest?: ExportManifest;
  taskMeta?: TaskMeta;
  runMeta?: RunMeta;
  keptFiles: ValidatedFile[];
  strippedFiles: ValidatedFile[];
}
