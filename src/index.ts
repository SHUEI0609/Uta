import 'dotenv/config';
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { AppDatabase } from './storage/database.js';
import { AuthService } from './services/auth.js';
import { MemoryService } from './services/memory.js';
import { TaskService } from './services/tasks.js';
import { InterruptionService } from './services/interruption.js';
import { QuotaService } from './services/quota.js';
import { AttachmentService } from './services/attachments.js';
import { WebService } from './services/web.js';
import { GithubService } from './services/github.js';
import { HarnessProvider } from './harness/provider.js';
import { HarnessRouter } from './harness/router.js';
import { createDiscordClient } from './discord/client.js';

const config = loadConfig();
const db = new AppDatabase({ localPath: config.databasePath, backend: config.databaseBackend,
  d1ProxyUrl: config.d1ProxyUrl, d1ProxyToken: config.d1ProxyToken });
await db.initialize();
const auth = new AuthService(db);
const memory = new MemoryService(db);
const tasks = new TaskService(db);
const interruption = new InterruptionService(db);
const quota = new QuotaService(db, config.aiDailyRequestLimit);
const attachments = new AttachmentService();
const web = new WebService();
const github = new GithubService(db, config);
const provider = new HarnessProvider(config, quota);
const router = new HarnessRouter(db, provider, memory, tasks, attachments, web, github);
const client = createDiscordClient(config, { db, auth, memory, tasks, interruption, github, router });

const health = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: client.isReady(), bot: client.user?.tag ?? null, llm: provider.name }));
  } else { response.writeHead(404); response.end('Not found'); }
});

health.listen(config.port, '0.0.0.0', () => console.log(`Health server listening on :${config.port}`));
const cleanupTimer = setInterval(() => {
  void memory.cleanup()
    .then((deleted) => { if (deleted) console.log(`Retention cleanup removed ${deleted} expired messages.`); })
    .catch((error: unknown) => console.error('Retention cleanup failed:', error));
}, 6 * 60 * 60 * 1000);
cleanupTimer.unref();

async function shutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}; shutting down.`);
  clearInterval(cleanupTimer);
  health.close();
  client.destroy();
  await provider.close?.();
  await db.close();
  process.exit(0);
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

if (!config.discordToken) {
  console.error('DISCORD_TOKEN is required. See .env.example.');
  process.exitCode = 1;
  health.close();
  await db.close();
} else {
  await client.login(config.discordToken);
}
