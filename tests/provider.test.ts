import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config.js';
import { HarnessProvider } from '../src/harness/provider.js';
import { QuotaService } from '../src/services/quota.js';
import { AppDatabase } from '../src/storage/database.js';

describe('Gemini Hydrogen', () => {
  let dataDir: string;
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'jarvis-gemini-'));
    vi.stubEnv('RENDER', 'true');
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('Geminiのキーがあれば画像と本文を1回で送り、思考を除いた回答を返す', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [
      { thought: true, text: '内部の思考' }, { text: '画像には' }, { text: '猫がいるよ。' },
    ] } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new HarnessProvider(settings, quota.service);
    const answer = await provider.complete({ prompt: '画像を説明して', route: 'light',
      imageDataUrls: ['data:image/png;base64,dGVzdA=='] });

    expect(answer).toBe('画像には猫がいるよ。');
    expect(provider.name).toBe('gemini-4-hydrogen');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent');
    expect(options.headers['x-goog-api-key']).toBe('gemini-secret');
    const body = JSON.parse(options.body);
    expect(body.systemInstruction.parts[0].text).toContain('雪村ウタ');
    expect(body.contents).toEqual([{ role: 'user', parts: [
      { text: '画像を説明して' }, { inlineData: { mimeType: 'image/png', data: 'dGVzdA==' } },
    ] }]);
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe('low');
    expect(quota.consume).toHaveBeenCalledOnce();
  });

  it('GeminiでもBotの日次上限に達したらAPIを呼ばない', async () => {
    const db = new AppDatabase(':memory:');
    await db.initialize();
    const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: '回答' }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HarnessProvider(settings, new QuotaService(db, 1));

    try {
      expect(await provider.complete({ prompt: '質問', route: 'light' })).toBe('回答');
      await expect(provider.complete({ prompt: '次の質問', route: 'light' })).rejects.toThrow(/安全上限/u);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      await db.close();
    }
  });

  it('Geminiの所要時間とトークン数を本文やAPIキーなしで記録する', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
    const infoLog = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      modelVersion: 'gemini-4-hydrogen',
      usageMetadata: { promptTokenCount: 2500, candidatesTokenCount: 50, thoughtsTokenCount: 120 },
      candidates: [{ content: { parts: [{ text: '秘密の返答' }] } }],
    })));

    await new HarnessProvider(settings, quota.service).complete({ prompt: '秘密の質問', route: 'light' });

    expect(infoLog).toHaveBeenCalledWith('Gemini timing:', {
      model: 'gemini-4-hydrogen', apiMs: expect.any(Number), inputTokens: 2500, outputTokens: 50, thinkingTokens: 120,
    });
    const logged = JSON.stringify(infoLog.mock.calls);
    expect(logged).not.toMatch(/秘密|gemini-secret/u);
  });

  it('分単位の429では終日停止せず、次の依頼で再度生成できる', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
          { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' },
        ] },
      ] } }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ candidates: [{ content: { parts: [{ text: '再開したよ' }] } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HarnessProvider(settings, quota.service);

    await expect(provider.complete({ prompt: '質問', route: 'light' })).rejects.toThrow(/一時的/u);
    expect(await provider.complete({ prompt: '再度質問', route: 'light' })).toBe('再開したよ');
    expect(quota.markProviderExhausted).not.toHaveBeenCalled();
  });

  it('日次の429はGoogle側のリセット待ちとして案内する', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code: 429, details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
        { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' },
      ] },
    ] } }, { status: 429 })));

    await expect(new HarnessProvider(settings, quota.service).complete({ prompt: '質問', route: 'light' }))
      .rejects.toThrow(/1日.*Google側/u);
    expect(quota.markProviderExhausted).not.toHaveBeenCalled();
  });

  it('HTTPエラーを秘密情報を伏せて記録し、Cloudflareには切り替えない', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
    const fetchMock = vi.fn().mockResolvedValue(new Response('invalid gemini-secret api-token', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HarnessProvider(settings, quota.service).complete({ prompt: '質問', route: 'light' }))
      .rejects.toThrow(/^Gemini APIへの接続に失敗しました \(403\)。$/u);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errorLog).toHaveBeenCalledWith('Gemini API request failed:', expect.objectContaining({
      status: 403, model: 'gemini-4-hydrogen', body: 'invalid [REDACTED] [REDACTED]',
    }));
  });

  it('不正な画像データはAPIを呼ばずに拒否する', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new HarnessProvider(settings, quota.service).complete({ prompt: '画像', route: 'light',
      imageDataUrls: ['https://example.com/private.png'] })).rejects.toThrow('画像データの形式が不正です。');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(quota.consume).not.toHaveBeenCalled();
  });

  it('複数画像を合わせて20MBを超える場合はAPIを呼ばずに案内する', async () => {
    const quota = fakeQuota();
    const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const image = 'data:image/png;base64,' + 'A'.repeat(10_000_000);

    await expect(new HarnessProvider(settings, quota.service).complete({ prompt: '画像を説明して', route: 'light',
      imageDataUrls: [image, image] })).rejects.toThrow(/20MB.*画像.*減らして/u);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(quota.consume).not.toHaveBeenCalled();
  });

  it.each([{ candidates: [] }, { candidates: [{ content: { parts: [{ thought: true, text: '思考のみ' }] } }] }])(
    '回答がない場合は思考を代わりに表示しない', async (response) => {
      const quota = fakeQuota();
      const settings = { ...config(dataDir), geminiApiKey: 'gemini-secret' };
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response)));

      await expect(new HarnessProvider(settings, quota.service).complete({ prompt: '質問', route: 'light' }))
        .rejects.toThrow('Gemini APIから空の応答が返りました。');
    },
  );
});

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
    expect(body.model).toBe('@cf/meta/llama-4-scout-17b-16e-instruct');
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
