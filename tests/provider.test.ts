import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config.js';
import { HarnessProvider } from '../src/harness/provider.js';
import type { QuotaService } from '../src/services/quota.js';

describe('HarnessProvider on Render', () => {
  let dataDir: string;
  let previousRender: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'jarvis-provider-'));
    previousRender = process.env.RENDER;
    process.env.RENDER = 'true';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousRender === undefined) delete process.env.RENDER;
    else process.env.RENDER = previousRender;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('Harnessを起動せずWorkers AI互換APIから回答する', async () => {
    const quota = fakeQuota();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '正常な回答' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const answer = await new HarnessProvider(config(dataDir), quota.service).complete({ prompt: 'テスト質問', route: 'light' });

    expect(answer).toBe('正常な回答');
    expect(quota.assertAvailable).toHaveBeenCalledOnce();
    expect(quota.consume).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/ai/v1/chat/completions'),
      expect.objectContaining({ method: 'POST' }));
  });

  it('429では無料枠を停止状態にする', async () => {
    const quota = fakeQuota();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));

    await expect(new HarnessProvider(config(dataDir), quota.service).complete({ prompt: 'テスト質問', route: 'light' }))
      .rejects.toThrow(/429/u);
    expect(quota.markProviderExhausted).toHaveBeenCalledOnce();
  });
});

function config(dataDir: string): AppConfig {
  return {
    dataDir,
    databasePath: join(dataDir, 'jarvis.sqlite'),
    databaseBackend: 'sqlite',
    port: 7860,
    aiDailyRequestLimit: 100,
    aiTimeoutMs: 5_000,
    cloudflareAccountId: 'account-id',
    cloudflareApiToken: 'api-token',
    cloudflareModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    cloudflareVisionModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    dshPatchPath: join(dataDir, 'dsh.patch.yml'),
    dshHome: join(dataDir, '.dsh'),
  };
}

function fakeQuota() {
  const assertAvailable = vi.fn().mockResolvedValue(undefined);
  const consume = vi.fn().mockResolvedValue(undefined);
  const markProviderExhausted = vi.fn().mockResolvedValue(undefined);
  return {
    assertAvailable,
    consume,
    markProviderExhausted,
    service: { assertAvailable, consume, markProviderExhausted } as unknown as QuotaService,
  };
}
