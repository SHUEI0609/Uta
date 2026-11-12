import { resolve } from 'node:path';

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export interface AppConfig {
  discordToken?: string;
  discordClientId?: string;
  discordGuildId?: string;
  dataDir: string;
  databasePath: string;
  databaseBackend: 'sqlite' | 'd1';
  d1ProxyUrl?: string;
  d1ProxyToken?: string;
  port: number;
  aiDailyRequestLimit: number;
  aiTimeoutMs: number;
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  cloudflareModel: string;
  cloudflareVisionModel: string;
  githubClientId?: string;
  githubEncryptionKey?: string;
  dshPatchPath: string;
  dshHome: string;
}

export function loadConfig(): AppConfig {
  const dataDir = resolve(optional('DATA_DIR') ?? './data');
  const databaseBackend = optional('DATABASE_BACKEND') ?? 'sqlite';
  if (databaseBackend !== 'sqlite' && databaseBackend !== 'd1') {
    throw new Error('DATABASE_BACKEND must be sqlite or d1');
  }
  return {
    discordToken: optional('DISCORD_TOKEN'), discordClientId: optional('DISCORD_CLIENT_ID'),
    discordGuildId: optional('DISCORD_GUILD_ID'), dataDir,
    databasePath: resolve(dataDir, 'jarvis.sqlite'), databaseBackend,
    d1ProxyUrl: optional('D1_PROXY_URL'), d1ProxyToken: optional('D1_PROXY_TOKEN'),
    port: integer('PORT', 7860),
    aiDailyRequestLimit: integer('AI_DAILY_REQUEST_LIMIT', 100),
    aiTimeoutMs: integer('AI_TIMEOUT_MS', 120_000),
    cloudflareAccountId: optional('CLOUDFLARE_ACCOUNT_ID'),
    cloudflareApiToken: optional('CLOUDFLARE_API_TOKEN'),
    cloudflareModel: optional('CLOUDFLARE_AI_MODEL') ?? '@cf/meta/llama-4-scout-17b-16e-instruct',
    cloudflareVisionModel: optional('CLOUDFLARE_VISION_MODEL') ?? '@cf/meta/llama-4-scout-17b-16e-instruct',
    githubClientId: optional('GITHUB_CLIENT_ID'), githubEncryptionKey: optional('GITHUB_TOKEN_ENCRYPTION_KEY'),
    dshPatchPath: resolve('./config/dsh.cordis.patch.yml'), dshHome: resolve(dataDir, '.dsh'),
  };
}
