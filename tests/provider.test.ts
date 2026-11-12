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
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'jarvis-provider-'));
    previousRender = process.env.RENDER;
    process.env.RENDER = 'true';
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string);
    expect(body.model).toBe('@cf/zai-org/glm-4.7-flash');
  });

  it('429では無料枠を停止状態にする', async () => {
    const quota = fakeQuota();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));

    await expect(new HarnessProvider(config(dataDir), quota.service).complete({ prompt: 'テスト質問', route: 'light' }))
      .rejects.toThrow(/429/u);
    expect(quota.markProviderExhausted).toHaveBeenCalledOnce();
  });

  it.each([
    [500, '{"errors":[{"code":1000,"message":"Inference failed"}]}'],
    [502, '<html>Bad Gateway</html>'],
  ])('%iのエラー本文と追跡情報をログへ残す', async (status, body) => {
    const quota = fakeQuota();
    const settings = config(dataDir);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, {
      status, headers: { 'cf-ray': 'test-ray-KIX' },
    })));

    await expect(new HarnessProvider(settings, quota.service).complete({ prompt: 'テスト質問', route: 'light' }))
      .rejects.toThrow(`Cloudflare Workers AIへの接続に失敗しました (${status})。`);

    expect(errorLog).toHaveBeenCalledWith('Workers AI request failed:', {
      status, model: settings.cloudflareModel, cfRay: 'test-ray-KIX', body,
    });
    expect(quota.markProviderExhausted).not.toHaveBeenCalled();
  });

  it('ログの秘密情報を伏せてDiscord向けエラーには本文を含めない', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), discordToken: 'discord-secret', d1ProxyToken: 'd1-secret',
      githubEncryptionKey: 'encryption-secret' };
    const body = 'api-token account-id discord-secret d1-secret encryption-secret Bearer other-secret sk-test-secret';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 500 })));

    await expect(new HarnessProvider(settings, quota.service).complete({ prompt: 'テスト質問', route: 'light' }))
      .rejects.toThrow(/^Cloudflare Workers AIへの接続に失敗しました \(500\)。$/u);

    expect(errorLog).toHaveBeenCalledWith('Workers AI request failed:', expect.objectContaining({
      body: '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] Bearer [REDACTED] [REDACTED]',
    }));
  });

  it('長いエラー本文は秘密情報を伏せてから切り詰める', async () => {
    const quota = fakeQuota();
    const body = 'x'.repeat(1_995) + 'api-token' + 'x'.repeat(1_000);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 502 })));

    await expect(new HarnessProvider(config(dataDir), quota.service).complete({ prompt: 'テスト質問', route: 'light' }))
      .rejects.toThrow(/502/u);

    expect(errorLog).toHaveBeenCalledWith('Workers AI request failed:', expect.objectContaining({
      body: 'x'.repeat(1_995) + '[REDA',
    }));
  });

  it('エラー本文を読めなくてもHTTPステータスを保持する', async () => {
    const quota = fakeQuota();
    const response = new Response('', { status: 429 });
    vi.spyOn(response, 'text').mockRejectedValue(new Error('stream interrupted'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));

    await expect(new HarnessProvider(config(dataDir), quota.service).complete({ prompt: 'テスト質問', route: 'light' }))
      .rejects.toThrow(/429/u);

    expect(errorLog).toHaveBeenCalledWith('Workers AI request failed:', expect.objectContaining({
      status: 429, body: '[response body unavailable]',
    }));
    expect(quota.markProviderExhausted).toHaveBeenCalledOnce();
  });

  it('画像解析の失敗も画像モデルとともに記録する', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), cloudflareVisionModel: 'vision-model' };
    const fetchMock = vi.fn().mockResolvedValue(new Response('Vision inference failed', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HarnessProvider(settings, quota.service).complete({
      prompt: '画像を説明して', route: 'light', imageDataUrls: ['data:image/png;base64,dGVzdA=='],
    })).rejects.toThrow(/^画像解析に失敗しました \(500\)$/u);

    expect(errorLog).toHaveBeenCalledWith('Workers AI request failed:', {
      status: 500, model: 'vision-model', cfRay: null, body: 'Vision inference failed',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
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
    cloudflareModel: '@cf/zai-org/glm-4.7-flash',
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
