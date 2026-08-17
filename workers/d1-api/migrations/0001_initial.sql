CREATE TABLE IF NOT EXISTS users (
  discord_user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL,
  github_token_ciphertext TEXT, github_login TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_messages (
  message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_expiry ON channel_messages(expires_at);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  owner_user_id TEXT, owner_display_name TEXT, title TEXT NOT NULL, description TEXT,
  deadline INTEGER, status TEXT NOT NULL DEFAULT 'open', confidence REAL NOT NULL,
  source_message_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS personal_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, discord_user_id TEXT NOT NULL, summary TEXT NOT NULL,
  source_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(discord_user_id, summary)
);

CREATE TABLE IF NOT EXISTS server_personality (
  guild_id TEXT PRIMARY KEY, summary TEXT NOT NULL, sample_count INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interruption_state (
  channel_id TEXT PRIMARY KEY, messages_since INTEGER NOT NULL DEFAULT 0,
  last_interruption_at INTEGER, recent_times_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS quota_usage (
  day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, exhausted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT NOT NULL, action TEXT NOT NULL,
  target TEXT NOT NULL, happened_at INTEGER NOT NULL, result TEXT NOT NULL
);
