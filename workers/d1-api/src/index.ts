type SqlValue = string | number | null;

interface StatementInput {
  sql: string;
  params?: SqlValue[];
}

interface BatchRequest {
  statements: StatementInput[];
}

// Standard Worker secrets are intentionally absent from wrangler.jsonc, so Wrangler cannot infer these bindings.
type WorkerEnv = Env & { API_TOKEN: string };

const MAX_BODY_BYTES = 256 * 1024;
const MAX_STATEMENTS = 32;
const MAX_SQL_LENGTH = 16_000;
const MAX_PARAMS = 100;

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/batch') {
      return json({ error: 'Not found' }, 404);
    }
    if (!authorized(request, env.API_TOKEN)) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const contentLength = Number(request.headers.get('content-length'));
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_BODY_BYTES) {
      return json({ error: 'Invalid content length' }, 413);
    }

    try {
      const body: unknown = await request.json();
      if (!isBatchRequest(body)) return json({ error: 'Invalid request body' }, 400);
      const prepared = body.statements.map((statement) =>
        env.DB.prepare(statement.sql).bind(...(statement.params ?? [])));
      const results = await env.DB.batch<Record<string, unknown>>(prepared);
      return json({ results: results.map((result) => ({
        results: result.results,
        changes: result.meta.changes,
        lastRowId: result.meta.last_row_id,
      })) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: 'D1 batch failed', error: message.slice(0, 500) }));
      return json({ error: 'Database operation failed' }, 500);
    }
  },
  scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): void {
    const healthUrl = env.RENDER_HEALTH_URL.trim();
    if (!healthUrl) return;
    ctx.waitUntil(checkRenderHealth(healthUrl));
  },
} satisfies ExportedHandler<WorkerEnv>;

async function checkRenderHealth(value: string): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('RENDER_HEALTH_URL must use HTTPS.');
  const response = await fetch(url, { headers: { 'User-Agent': 'JarvisHealthMonitor/1.0' },
    signal: AbortSignal.timeout(20_000) });
  await response.body?.cancel();
  console.log(JSON.stringify({ message: 'Render health check', status: response.status, ok: response.ok }));
}

function authorized(request: Request, expected: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const actual = header.slice(prefix.length);
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  return actualBytes.byteLength === expectedBytes.byteLength
    && crypto.subtle.timingSafeEqual(actualBytes, expectedBytes);
}

function isBatchRequest(value: unknown): value is BatchRequest {
  if (!value || typeof value !== 'object' || !('statements' in value) || !Array.isArray(value.statements)) return false;
  if (value.statements.length < 1 || value.statements.length > MAX_STATEMENTS) return false;
  return value.statements.every((statement) => {
    if (!statement || typeof statement !== 'object' || !('sql' in statement)
      || typeof statement.sql !== 'string' || statement.sql.length < 1 || statement.sql.length > MAX_SQL_LENGTH) return false;
    if (!('params' in statement) || statement.params === undefined) return true;
    return Array.isArray(statement.params) && statement.params.length <= MAX_PARAMS
      && statement.params.every(isSqlValue);
  });
}

function isSqlValue(value: unknown): value is SqlValue {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
