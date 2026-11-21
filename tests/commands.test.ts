import { EventEmitter } from 'node:events';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction, Client } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { createDiscordClient, type DiscordServices } from '../src/discord/client.js';
import { commandDefinitions } from '../src/discord/commands.js';

const { resolve4, request, randomInt } = vi.hoisted(() => ({
  resolve4: vi.fn(), request: vi.fn(), randomInt: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({ Resolver: class { resolve4 = resolve4; } }));
vi.mock('node:https', () => ({ request }));
vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(), randomInt,
}));

describe('/url', () => {
  let client: Client;
  let statuses: number[];

  beforeEach(() => {
    let number = -1;
    let character = 0;
    randomInt.mockReset().mockImplementation((_min: number, max?: number) => {
      if (max) {
        number++;
        character = 0;
        return 5;
      }
      if (character++ === 0) return number % 36;
      return 0;
    });
    resolve4.mockReset().mockResolvedValue(['93.184.216.34']);
    statuses = [200];
    request.mockReset().mockImplementation((_options, callback) => {
      const outgoing = new EventEmitter();
      return Object.assign(outgoing, { end: () => {
        const response = new IncomingMessage(new Socket());
        response.statusCode = statuses.shift() ?? 200;
        callback(response);
      } });
    });
  });

  afterEach(async () => {
    await client?.destroy();
  });

  it('スラッシュコマンドとして登録する', () => {
    expect(commandDefinitions.some((command) => command.name === 'url')).toBe(true);
  });

  async function runCommand(): Promise<string[]> {
    client = createDiscordClient(loadConfig(), {} as DiscordServices);
    const replies: string[] = [];
    const edit = async (content: string) => { replies.push(content); };
    const interaction = {
      isChatInputCommand: () => true, commandName: 'url',
      reply: async (value: { content: string }) => { replies.push(value.content); },
      fetchReply: async () => ({ edit }),
      editReply: async () => { throw new Error('Interaction token expired'); },
    } as unknown as ChatInputCommandInteraction;

    await client.listeners('interactionCreate')[0]!(interaction);
    return replies;
  }

  it('ランダム生成したドメインのHTTPS応答を確認して表示する', async () => {
    expect(await runCommand()).toEqual(['ランダムなURLを生成しています...', 'https://00000.com/']);
    expect(resolve4).toHaveBeenCalledWith('00000.com');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      hostname: '93.184.216.34', servername: '00000.com', headers: { Host: '00000.com' },
      method: 'HEAD', signal: expect.any(AbortSignal),
    }), expect.any(Function));
  });

  it('20回失敗しても新しいURLを生成し続け、成功したものだけを表示する', async () => {
    statuses = [...Array(20).fill(404), 200];
    expect(await runCommand()).toEqual(['ランダムなURLを生成しています...', 'https://k0000.com/']);
    expect(resolve4).toHaveBeenCalledTimes(21);
    expect(new Set(resolve4.mock.calls.map(([host]) => host)).size).toBe(21);
  });

  it.each([5, 15])('%i文字のドメインを生成できる', async (length) => {
    randomInt.mockReturnValueOnce(length).mockReturnValue(35);
    expect((await runCommand())[1]).toBe(`https://${'z'.repeat(length)}.com/`);
    expect(randomInt).toHaveBeenCalledWith(5, 16);
    expect(randomInt).toHaveBeenCalledTimes(length + 1);
  });

  it.each([301, 403, 404, 500])('HTTP %i のURLは表示しない', async (status) => {
    statuses = [status, 200];
    expect((await runCommand())[1]).toBe('https://10000.com/');
  });

  it('DNSで見つからないドメインは飛ばす', async () => {
    resolve4.mockRejectedValueOnce(new Error('ENOTFOUND'));
    expect((await runCommand())[1]).toBe('https://10000.com/');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('HTTPS接続に失敗しても次のURLを試す', async () => {
    request.mockImplementationOnce(() => {
      const outgoing = new EventEmitter();
      return Object.assign(outgoing, { end: () => outgoing.emit('error', new Error('TLS failed')) });
    });
    expect((await runCommand())[1]).toBe('https://10000.com/');
  });

  it.each(['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.168.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255'])
  ('内部・特殊アドレス %s には接続しない', async (address) => {
    resolve4.mockResolvedValueOnce([address]);
    expect((await runCommand())[1]).toBe('https://10000.com/');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0].hostname).toBe('93.184.216.34');
  });
});
