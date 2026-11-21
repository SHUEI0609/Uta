import { describe, expect, it } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { createDiscordClient, type DiscordServices } from '../src/discord/client.js';
import { commandDefinitions } from '../src/discord/commands.js';

describe('/url', () => {
  it('スラッシュコマンドとして登録する', () => {
    expect(commandDefinitions.some((command) => command.name === 'url')).toBe(true);
  });

  it('生成中の表示をランダムなHTTPS URLに更新する', async () => {
    const client = createDiscordClient(loadConfig(), {} as DiscordServices);
    const replies: string[] = [];
    const urls: string[] = [];
    const interaction = {
      isChatInputCommand: () => true,
      commandName: 'url',
      reply: async (value: { content: string }) => { replies.push(value.content); },
      editReply: async (content: string) => {
        expect(replies.at(-1)).toBe('ランダムなURLを生成しています...');
        urls.push(content);
      },
    } as unknown as ChatInputCommandInteraction;

    try {
      const handler = client.listeners('interactionCreate')[0]!;
      await handler(interaction);
      await handler(interaction);

      expect(replies).toHaveLength(2);
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        expect(url).toMatch(/^https:\/\/[a-z0-9]+\.com$/u);
        expect(new URL(url).protocol).toBe('https:');
      }
      expect(urls[0]).not.toBe(urls[1]);
    } finally {
      await client.destroy();
    }
  });
});
