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
  cover_path TEXT,
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
