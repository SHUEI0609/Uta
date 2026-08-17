import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { StoredMessage, StoredTask, TaskStatus, UserSettings } from '../types/index.js';

const SETTINGS_DEFAULTS: UserSettings = {
  memory: true, personalMemory: true, tasks: true, interruption: true, webAccess: true,
  githubConnected: false, developmentAgent: true, pcConnected: false,
};

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    discord_user_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL,
    github_token_ciphertext TEXT, github_login TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_messages (
    message_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    author_id TEXT NOT NULL, author_name TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_channel_time ON channel_messages(channel_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_expiry ON channel_messages(expires_at)',
  `CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    owner_user_id TEXT, owner_display_name TEXT, title TEXT NOT NULL, description TEXT,
    deadline INTEGER, status TEXT NOT NULL DEFAULT 'open', confidence REAL NOT NULL,
    source_message_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id, status, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS personal_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT, discord_user_id TEXT NOT NULL, summary TEXT NOT NULL,
    source_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(discord_user_id, summary)
  )`,
  `CREATE TABLE IF NOT EXISTS server_personality (
    guild_id TEXT PRIMARY KEY, summary TEXT NOT NULL, sample_count INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS interruption_state (
    channel_id TEXT PRIMARY KEY, messages_since INTEGER NOT NULL DEFAULT 0,
    last_interruption_at INTEGER, recent_times_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS quota_usage (
    day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, exhausted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pending_actions (
    id TEXT PRIMARY KEY, discord_user_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
    status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT NOT NULL, action TEXT NOT NULL,
    target TEXT NOT NULL, happened_at INTEGER NOT NULL, result TEXT NOT NULL
  )`,
] as const;

type SqlValue = string | number | null;
interface Statement { sql: string; params?: SqlValue[]; }
interface QueryResult { results: Array<Record<string, unknown>>; changes: number; lastRowId?: number; }
interface DatabaseBackend {
  batch(statements: Statement[]): Promise<QueryResult[]>;
  close(): Promise<void>;
}

export type SettingKey = keyof Pick<UserSettings,
  'memory' | 'personalMemory' | 'tasks' | 'interruption' | 'webAccess' | 'developmentAgent'>;

export interface AppDatabaseOptions {
  localPath: string;
  backend: 'sqlite' | 'd1';
  d1ProxyUrl?: string;
  d1ProxyToken?: string;
}

export class AppDatabase {
  private readonly backend: DatabaseBackend;

  constructor(input: string | AppDatabaseOptions) {
    const options: AppDatabaseOptions = typeof input === 'string'
      ? { localPath: input, backend: 'sqlite' }
      : input;
    if (options.backend === 'd1') {
      if (!options.d1ProxyUrl || !options.d1ProxyToken) {
        throw new Error('D1 backend requires D1_PROXY_URL and D1_PROXY_TOKEN.');
      }
      this.backend = new D1ProxyBackend(options.d1ProxyUrl, options.d1ProxyToken);
    } else {
      this.backend = new SqliteBackend(options.localPath);
    }
  }

  async initialize(): Promise<void> {
    await this.backend.batch(SCHEMA_STATEMENTS.map((sql) => ({ sql })));
  }

  private async query(sql: string, params: SqlValue[] = []): Promise<QueryResult> {
    const [result] = await this.backend.batch([{ sql, params }]);
    if (!result) throw new Error('Database returned no result.');
    return result;
  }

  private async ensureUser(userId: string): Promise<void> {
    const now = Date.now();
    await this.query(`INSERT INTO users(discord_user_id, settings_json, created_at, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(discord_user_id) DO NOTHING`,
    [userId, JSON.stringify(SETTINGS_DEFAULTS), now, now]);
  }

  async getSettings(userId: string): Promise<UserSettings> {
    await this.ensureUser(userId);
    const result = await this.query(
      'SELECT settings_json, github_token_ciphertext FROM users WHERE discord_user_id = ?', [userId]);
    const row = result.results[0];
    if (!row) throw new Error('User settings could not be loaded.');
    return { ...SETTINGS_DEFAULTS, ...(JSON.parse(String(row.settings_json)) as Partial<UserSettings>),
      githubConnected: Boolean(row.github_token_ciphertext) };
  }

  async setSetting(userId: string, key: SettingKey, value: boolean): Promise<UserSettings> {
    const settings = await this.getSettings(userId);
    settings[key] = value;
    await this.query('UPDATE users SET settings_json = ?, updated_at = ? WHERE discord_user_id = ?',
      [JSON.stringify(settings), Date.now(), userId]);
    return settings;
  }

  async deleteUserData(userId: string): Promise<void> {
    await this.backend.batch([
      { sql: 'DELETE FROM personal_memory WHERE discord_user_id = ?', params: [userId] },
      { sql: 'DELETE FROM tasks WHERE owner_user_id = ?', params: [userId] },
      { sql: 'DELETE FROM pending_actions WHERE discord_user_id = ?', params: [userId] },
      { sql: 'DELETE FROM users WHERE discord_user_id = ?', params: [userId] },
    ]);
  }

  async addMessage(message: StoredMessage): Promise<boolean> {
    const retentionMs = 30 * 24 * 60 * 60 * 1000;
    const result = await this.query(`INSERT OR IGNORE INTO channel_messages
      (message_id, guild_id, channel_id, author_id, author_name, content, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [message.messageId, message.guildId, message.channelId, message.authorId,
      message.authorName, message.content, message.createdAt, message.createdAt + retentionMs]);
    return result.changes > 0;
  }

  async recentMessages(channelId: string, limit = 50): Promise<StoredMessage[]> {
    const result = await this.query(`SELECT guild_id, channel_id, message_id, author_id, author_name, content, created_at
      FROM channel_messages WHERE channel_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT ?`,
    [channelId, Date.now(), limit]);
    return result.results.reverse().map((row) => ({
      guildId: String(row.guild_id), channelId: String(row.channel_id), messageId: String(row.message_id),
      authorId: String(row.author_id), authorName: String(row.author_name), content: String(row.content),
      createdAt: Number(row.created_at),
    }));
  }

  async cleanupExpiredMessages(now = Date.now()): Promise<number> {
    return (await this.query('DELETE FROM channel_messages WHERE expires_at <= ?', [now])).changes;
  }

  async createTask(task: Omit<StoredTask, 'id' | 'createdAt' | 'updatedAt'>): Promise<number | null> {
    const now = Date.now();
    const result = await this.query(`INSERT OR IGNORE INTO tasks
      (guild_id, channel_id, owner_user_id, owner_display_name, title, description, deadline,
       status, confidence, source_message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [task.guildId, task.channelId, task.ownerUserId, task.ownerDisplayName, task.title,
      task.description, task.deadline, task.status, task.confidence, task.sourceMessageId, now, now]);
    return result.changes ? result.lastRowId ?? null : null;
  }

  async listTasks(channelId: string, includeCompleted = false): Promise<StoredTask[]> {
    const statusClause = includeCompleted ? '' : "AND status = 'open'";
    const result = await this.query(`SELECT * FROM tasks WHERE channel_id = ? ${statusClause}
      ORDER BY deadline IS NULL, deadline, updated_at DESC`, [channelId]);
    return result.results.map(mapTask);
  }

  async latestOpenTask(channelId: string, ownerUserId?: string): Promise<StoredTask | null> {
    const result = ownerUserId
      ? await this.query("SELECT * FROM tasks WHERE channel_id = ? AND owner_user_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1", [channelId, ownerUserId])
      : await this.query("SELECT * FROM tasks WHERE channel_id = ? AND status = 'open' ORDER BY updated_at DESC LIMIT 1", [channelId]);
    return result.results[0] ? mapTask(result.results[0]) : null;
  }

  async updateTask(id: number, changes: { ownerUserId?: string | null; ownerDisplayName?: string | null; deadline?: number | null; status?: TaskStatus }): Promise<void> {
    const result = await this.query('SELECT * FROM tasks WHERE id = ?', [id]);
    const current = result.results[0];
    if (!current) return;
    await this.query(`UPDATE tasks SET owner_user_id = ?, owner_display_name = ?, deadline = ?, status = ?, updated_at = ? WHERE id = ?`,
      [changes.ownerUserId !== undefined ? changes.ownerUserId : sqlValue(current.owner_user_id),
        changes.ownerDisplayName !== undefined ? changes.ownerDisplayName : sqlValue(current.owner_display_name),
        changes.deadline !== undefined ? changes.deadline : sqlValue(current.deadline),
        changes.status ?? String(current.status), Date.now(), id]);
  }

  async addPersonalMemory(userId: string, summary: string, sourceMessageId: string): Promise<void> {
    await this.query('INSERT OR IGNORE INTO personal_memory(discord_user_id, summary, source_message_id, created_at) VALUES (?, ?, ?, ?)',
      [userId, summary, sourceMessageId, Date.now()]);
  }

  async personalMemories(userId: string, limit = 20): Promise<string[]> {
    const result = await this.query('SELECT summary FROM personal_memory WHERE discord_user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]);
    return result.results.map((row) => String(row.summary));
  }

  async getPersonality(guildId: string): Promise<{ summary: string; sampleCount: number } | null> {
    const row = (await this.query('SELECT summary, sample_count FROM server_personality WHERE guild_id = ?', [guildId])).results[0];
    return row ? { summary: String(row.summary), sampleCount: Number(row.sample_count) } : null;
  }

  async setPersonality(guildId: string, summary: string, sampleCount: number): Promise<void> {
    await this.query(`INSERT INTO server_personality(guild_id, summary, sample_count, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET summary=excluded.summary,
      sample_count=excluded.sample_count, updated_at=excluded.updated_at`,
    [guildId, summary, sampleCount, Date.now()]);
  }

  async getInterruptionState(channelId: string): Promise<{ messagesSince: number; lastAt: number | null; recent: number[] }> {
    const row = (await this.query('SELECT * FROM interruption_state WHERE channel_id = ?', [channelId])).results[0];
    return row ? { messagesSince: Number(row.messages_since), lastAt: row.last_interruption_at === null ? null : Number(row.last_interruption_at),
      recent: JSON.parse(String(row.recent_times_json)) as number[] } : { messagesSince: 0, lastAt: null, recent: [] };
  }

  async saveInterruptionState(channelId: string, messagesSince: number, lastAt: number | null, recent: number[]): Promise<void> {
    await this.query(`INSERT INTO interruption_state(channel_id, messages_since, last_interruption_at, recent_times_json)
      VALUES (?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET messages_since=excluded.messages_since,
      last_interruption_at=excluded.last_interruption_at, recent_times_json=excluded.recent_times_json`,
    [channelId, messagesSince, lastAt, JSON.stringify(recent)]);
  }

  async quota(day: string): Promise<{ requests: number; exhausted: boolean }> {
    const row = (await this.query('SELECT requests, exhausted FROM quota_usage WHERE day = ?', [day])).results[0];
    return row ? { requests: Number(row.requests), exhausted: Boolean(row.exhausted) } : { requests: 0, exhausted: false };
  }

  async incrementQuota(day: string): Promise<void> {
    await this.query(`INSERT INTO quota_usage(day, requests, exhausted, updated_at) VALUES (?, 1, 0, ?)
      ON CONFLICT(day) DO UPDATE SET requests=requests+1, updated_at=excluded.updated_at`, [day, Date.now()]);
  }

  async markQuotaExhausted(day: string): Promise<void> {
    await this.query(`INSERT INTO quota_usage(day, requests, exhausted, updated_at) VALUES (?, 0, 1, ?)
      ON CONFLICT(day) DO UPDATE SET exhausted=1, updated_at=excluded.updated_at`, [day, Date.now()]);
  }

  async setGithubCredential(userId: string, ciphertext: string | null, login: string | null): Promise<void> {
    await this.ensureUser(userId);
    await this.query('UPDATE users SET github_token_ciphertext = ?, github_login = ?, updated_at = ? WHERE discord_user_id = ?',
      [ciphertext, login, Date.now(), userId]);
  }

  async getGithubCredential(userId: string): Promise<{ ciphertext: string; login: string | null } | null> {
    const row = (await this.query('SELECT github_token_ciphertext, github_login FROM users WHERE discord_user_id = ?', [userId])).results[0];
    return row?.github_token_ciphertext
      ? { ciphertext: String(row.github_token_ciphertext), login: row.github_login === null ? null : String(row.github_login) }
      : null;
  }

  async createPendingAction(id: string, userId: string, kind: string, payload: unknown, expiresAt: number): Promise<void> {
    await this.query(`INSERT INTO pending_actions(id, discord_user_id, kind, payload_json, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)`, [id, userId, kind, JSON.stringify(payload), expiresAt, Date.now()]);
  }

  async pendingAction(id: string): Promise<{ userId: string; kind: string; payload: unknown; status: string; expiresAt: number } | null> {
    const row = (await this.query('SELECT * FROM pending_actions WHERE id = ?', [id])).results[0];
    return row ? { userId: String(row.discord_user_id), kind: String(row.kind),
      payload: JSON.parse(String(row.payload_json)) as unknown, status: String(row.status), expiresAt: Number(row.expires_at) } : null;
  }

  async finishPendingAction(id: string, status: 'executed' | 'cancelled' | 'failed'): Promise<void> {
    await this.query("UPDATE pending_actions SET status = ? WHERE id = ? AND status = 'pending'", [status, id]);
  }

  async audit(actor: string, action: string, target: string, result: string): Promise<void> {
    await this.query('INSERT INTO audit_log(actor_user_id, action, target, happened_at, result) VALUES (?, ?, ?, ?, ?)',
      [actor, action, target, Date.now(), result]);
  }

  async close(): Promise<void> { await this.backend.close(); }
}

class SqliteBackend implements DatabaseBackend {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async batch(statements: Statement[]): Promise<QueryResult[]> {
    return this.db.transaction((items: Statement[]) => items.map(({ sql, params = [] }) => {
      const prepared = this.db.prepare(sql);
      if (prepared.reader) return { results: prepared.all(...params) as Array<Record<string, unknown>>, changes: 0 };
      const result = prepared.run(...params);
      return { results: [], changes: result.changes, lastRowId: Number(result.lastInsertRowid) };
    }))(statements);
  }

  async close(): Promise<void> { this.db.close(); }
}

class D1ProxyBackend implements DatabaseBackend {
  private readonly endpoint: string;

  constructor(url: string, private readonly token: string) {
    this.endpoint = `${url.replace(/\/+$/u, '')}/v1/batch`;
  }

  async batch(statements: Statement[]): Promise<QueryResult[]> {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ statements }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`D1 proxy request failed (${response.status}): ${errorMessage(payload)}`);
    if (!isQueryResponse(payload)) throw new Error('D1 proxy returned an invalid response.');
    return payload.results;
  }

  async close(): Promise<void> {}
}

function isQueryResponse(value: unknown): value is { results: QueryResult[] } {
  if (!value || typeof value !== 'object' || !('results' in value) || !Array.isArray(value.results)) return false;
  return value.results.every((item) => item && typeof item === 'object'
    && 'results' in item && Array.isArray(item.results) && 'changes' in item && typeof item.changes === 'number');
}

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') return value.error.slice(0, 300);
  return 'unknown error';
}

function sqlValue(value: unknown): SqlValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') return value;
  throw new Error('Unexpected SQL value type.');
}

function mapTask(row: Record<string, unknown>): StoredTask {
  return {
    id: Number(row.id), guildId: String(row.guild_id), channelId: String(row.channel_id),
    ownerUserId: row.owner_user_id === null ? null : String(row.owner_user_id),
    ownerDisplayName: row.owner_display_name === null ? null : String(row.owner_display_name),
    title: String(row.title), description: row.description === null ? null : String(row.description),
    deadline: row.deadline === null ? null : Number(row.deadline), status: String(row.status) as TaskStatus,
    confidence: Number(row.confidence), sourceMessageId: String(row.source_message_id),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}
