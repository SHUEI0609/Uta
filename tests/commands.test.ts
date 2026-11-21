import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { createDiscordClient, type DiscordServices } from '../src/discord/client.js';
import { commandDefinitions } from '../src/discord/commands.js';

describe('/url', () => {
  let client: Client;

  afterEach(async () => {
    vi.unstubAllGlobals();
    await client?.destroy();
  });

  it('スラッシュコマンドとして登録する', () => {
    expect(commandDefinitions.some((command) => command.name === 'url')).toBe(true);
  });

  async function runCommand(): Promise<string[]> {
    client = createDiscordClient(loadConfig(), {} as DiscordServices);
    const replies: string[] = [];
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'url',
      reply: async (value: { content: string }) => { replies.push(value.content); },
      editReply: async (content: string) => {
        expect(replies.at(-1)).toBe('ランダムなURLを生成しています...');
        replies.push(content);
      },
    } as unknown as ChatInputCommandInteraction;

    await client.listeners('interactionCreate')[0]!(interaction);
    return replies;
  }

  it('生成中の表示をHTTPSで正常応答したURLに更新する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const replies = await runCommand();

    expect(replies).toHaveLength(2);
    expect(replies[1]).toMatch(/^https:\/\//u);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(replies[1], {
      method: 'HEAD', redirect: 'error', signal: expect.any(AbortSignal),
    });
  });

  it('接続失敗とHTTPエラーのURLを返さず次の候補を確認する', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const replies = await runCommand();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(new Set(urls).size).toBe(3);
    expect(replies[1]).toBe(urls[2]);
  });

  it.each(['network', 'http'])('全候補が失敗した場合はURLを返さず終了する: %s', async (failure) => {
    const fetchMock = vi.fn();
    if (failure === 'network') fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    else fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const replies = await runCommand();

    expect(replies).toEqual([
      'ランダムなURLを生成しています...',
      'アクセスできるURLが見つかりませんでした。しばらくしてから再度お試しください。',
    ]);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10);
  });
});
