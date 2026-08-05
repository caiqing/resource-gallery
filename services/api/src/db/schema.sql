PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,
  pending_earnings INTEGER NOT NULL DEFAULT 0,
  lifetime_spent INTEGER NOT NULL DEFAULT 0,
  lifetime_earned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summary_status TEXT NOT NULL DEFAULT 'ready',
  summary_origin TEXT NOT NULL DEFAULT 'fallback',
  summary_source_hash TEXT,
  summary_model TEXT,
  summary_generated_at TEXT,
  summary_locked INTEGER NOT NULL DEFAULT 0,
  tag_status TEXT NOT NULL DEFAULT 'ready',
  tag_origin TEXT NOT NULL DEFAULT 'fallback',
  tag_source_hash TEXT,
  tag_model TEXT,
  tag_generated_at TEXT,
  tag_locked INTEGER NOT NULL DEFAULT 0,
  cover_path TEXT,
  active_version_id TEXT,
  author_user_id TEXT NOT NULL REFERENCES users(id),
  source_task_id TEXT,
  source_run_id TEXT,
  source_run_index INTEGER,
  price_tier TEXT NOT NULL DEFAULT 'standard',
  price_credits INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'unlisted', 'taken_down')),
  like_count INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  published_at TEXT,
  updated_at TEXT NOT NULL
);

DROP INDEX IF EXISTS idx_listings_source;
CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_source_task
  ON listings(source_task_id)
  WHERE source_task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS listing_files (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  is_previewable INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 1,
  stripped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS listing_versions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL CHECK (schema_version IN ('resource-gallery.export/v1', 'resource-gallery.export/v2')),
  package_sha256 TEXT NOT NULL,
  export_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'failed')),
  source_run_id TEXT,
  source_run_index INTEGER,
  cover_path TEXT,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE(listing_id, export_fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_listing_versions_listing_created
  ON listing_versions(listing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS listing_assets (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES listing_versions(id) ON DELETE CASCADE,
  upstream_asset_id TEXT NOT NULL,
  variant_group_id TEXT,
  parent_asset_id TEXT REFERENCES listing_assets(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  mime_type TEXT,
  duration_ms INTEGER,
  width INTEGER,
  height INTEGER,
  audio_codec TEXT,
  video_codec TEXT,
  language TEXT,
  provenance TEXT NOT NULL DEFAULT 'pipeline',
  preview_policy TEXT NOT NULL DEFAULT 'none' CHECK (preview_policy IN ('none', 'public', 'derived_only')),
  entitlement_download INTEGER NOT NULL DEFAULT 0,
  included INTEGER NOT NULL DEFAULT 0,
  stripped INTEGER NOT NULL DEFAULT 0,
  source_run_id TEXT,
  UNIQUE(version_id, upstream_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_listing_assets_version_included
  ON listing_assets(version_id, included, stripped);

CREATE TABLE IF NOT EXISTS listing_tags (
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  topic_id TEXT REFERENCES topics(id),
  PRIMARY KEY (listing_id, tag)
);

CREATE TABLE IF NOT EXISTS likes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  message TEXT NOT NULL DEFAULT '',
  listing_id TEXT REFERENCES listings(id),
  source_task_id TEXT,
  source_run_id TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS resource_sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  publish_policy TEXT NOT NULL CHECK (publish_policy IN ('review', 'auto_publish')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  scanned_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  unchanged_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  review_count INTEGER NOT NULL DEFAULT 0,
  published_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS resource_sync_states (
  source_task_id TEXT PRIMARY KEY,
  listing_id TEXT,
  listing_version_id TEXT,
  export_fingerprint TEXT,
  package_sha256 TEXT,
  publish_policy TEXT NOT NULL CHECK (publish_policy IN ('review', 'auto_publish')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'review', 'published', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT NOT NULL DEFAULT '',
  synced_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resource_sync_states_status
  ON resource_sync_states(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS price_tiers (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  credits INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS revenue_share_configs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  author_share_bps INTEGER NOT NULL,
  platform_share_bps INTEGER NOT NULL,
  effective_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  buyer_user_id TEXT NOT NULL REFERENCES users(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  price_credits INTEGER NOT NULL,
  price_tier TEXT NOT NULL,
  author_share_bps INTEGER NOT NULL,
  platform_share_bps INTEGER NOT NULL,
  author_credits INTEGER NOT NULL,
  platform_credits INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_buyer_listing
  ON orders(buyer_user_id, listing_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  entry_type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS download_entitlements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, listing_id)
);

CREATE TABLE IF NOT EXISTS download_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  entitlement_id TEXT NOT NULL REFERENCES download_entitlements(id),
  source TEXT NOT NULL CHECK (source IN ('free', 'purchase')),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_download_events_listing_created
  ON download_events(listing_id, created_at);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT NOT NULL REFERENCES users(id),
  listing_id TEXT NOT NULL REFERENCES listings(id),
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_status_created
  ON reports(status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open_per_user_listing
  ON reports(reporter_user_id, listing_id)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
