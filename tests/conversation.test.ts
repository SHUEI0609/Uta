import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collection, type ChatInputCommandInteraction, type Client, type Message } from 'discord.js';
import { loadConfig } from '../src/config.js';
import { createDiscordClient, type DiscordServices } from '../src/discord/client.js';
import { HarnessRouter } from '../src/harness/router.js';
import { AttachmentService } from '../src/services/attachments.js';
import { AuthService } from '../src/services/auth.js';
import { GithubService } from '../src/services/github.js';
import { InterruptionService } from '../src/services/interruption.js';
import { MemoryService } from '../src/services/memory.js';
import { TaskService } from '../src/services/tasks.js';
import { WebService } from '../src/services/web.js';
import { AppDatabase } from '../src/storage/database.js';
import type { LlmRequest } from '../src/types/index.js';

describe('Conversation history', () => {
  let db: AppDatabase;
  let client: Client;
  let services: DiscordServices;
  let prompts: string[];
  let answer: string;
  let sent: Message[];
  let generationError: Error | undefined;
  let sendError: Error | undefined;
  let failFollowUp: boolean;

  beforeEach(async () => {
    db = new AppDatabase(':memory:');
    await db.initialize();
    const config = loadConfig();
    const memory = new MemoryService(db);
    const tasks = new TaskService(db);
    const github = new GithubService(db, config);
    prompts = [];
    sent = [];
    generationError = undefined;
    sendError = undefined;
    failFollowUp = false;
    answer = '1. 復習する\n2. 問題を解く';
    const llm = { name: 'test', complete: async (request: LlmRequest) => {
      prompts.push(request.prompt);
      if (generationError) throw generationError;
      return answer;
    } };
    services = { db, memory, tasks, github, auth: new AuthService(db), interruption: new InterruptionService(db),
      router: new HarnessRouter(db, llm, memory, tasks, new AttachmentService(), new WebService(), github) };
    client = createDiscordClient(config, services);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client.destroy();
    await db.close();
  });

  async function send(content: string): Promise<Message> {
    if (sendError) throw sendError;
    const message = { id: `reply-${sent.length}`, guildId: 'g', channelId: 'c', content,
      author: { id: 'bot', displayName: 'Jarvis', bot: true }, createdTimestamp: Date.now() } as Message;
    sent.push(message);
    return message;
  }

  async function ask(kind: string, text: string, reference?: Message): Promise<void> {
    if (kind === 'slash') {
      let reply: Message | undefined;
      const interaction = { isChatInputCommand: () => true, commandName: 'ai', id: `question-${sent.length}`,
        guildId: 'g', channelId: 'c', createdTimestamp: Date.now(), user: { id: 'u', displayName: '田中' },
        options: { getString: () => text, getAttachment: () => null },
        deferred: false, replied: false,
        deferReply: async () => { interaction.deferred = true; },
        editReply: async (value: string | { content: string }) => {
          let content: string;
          if (typeof value === 'string') content = value;
          else content = value.content;
          if (reply) reply.content = content;
          else reply = await send(content);
          interaction.replied = true;
          return reply;
        },
        followUp: async (value: string | { content: string }) => {
          if (failFollowUp) {
            failFollowUp = false;
            throw new Error('follow-up unavailable');
          }
          if (typeof value !== 'string') return send(value.content);
          return send(value);
        },
        isRepliable: () => !sendError };
      await client.listeners('interactionCreate')[0]?.(interaction as unknown as ChatInputCommandInteraction);
      return;
    }
    const message = { id: `question-${sent.length}`, guildId: 'g', channelId: 'c', createdTimestamp: Date.now(),
      author: { id: 'u', displayName: '田中', bot: false }, content: `!ai ${text}`, attachments: new Collection(),
      mentions: { users: new Collection() }, reply: send,
      reference: { messageId: reference?.id }, fetchReference: async () => reference,
      channel: { sendTyping: async () => {}, isSendable: () => true, send } } as unknown as Message;
    await client.listeners('messageCreate')[0]?.(message);
  }

  it.each(['slash', 'message'])('%sの回答を保存し、次の質問へ渡す', async (kind) => {
    await ask(kind, '勉強の進め方を2つ教えて');
    await ask(kind, '2つ目について詳しく');

    expect(prompts[1]).toContain('Jarvis (Bot): 1. 復習する\n2. 問題を解く');
    expect((await db.recentMessages('c')).filter((message) => message.authorId === 'bot')).toHaveLength(2);
  });

  it.each(['slash', 'message'])('%sの長文回答は送信した全ての部分を保存する', async (kind) => {
    answer = '説明です。'.repeat(500);
    await ask(kind, '説明して');

    const replies = (await db.recentMessages('c')).filter((message) => message.authorId === 'bot');
    expect(sent.length).toBeGreaterThan(1);
    expect(replies.map((message) => message.content).join('')).toBe(answer);
    expect(replies.map((message) => message.messageId)).toEqual(sent.map((message) => message.id));
  });

  it('Memory OFFではBotの回答も履歴へ残さない', async () => {
    await db.setSetting('u', 'memory', false);
    await ask('slash', '説明して');
    expect(await db.recentMessages('c')).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('返信先も24時間以内に限定し、時刻と発言者を渡す', async () => {
    const request = { guildId: 'g', channelId: 'c', userId: 'u', userName: '田中', prompt: '続きを教えて' };
    await services.router.handle({ ...request, sourceId: 'old-reference', replyContext: {
      authorName: 'Jarvis (Bot)', content: '古い返信先', createdAt: Date.now() - 24 * 60 * 60 * 1000 - 1000 } });
    const now = Date.now();
    await services.router.handle({ ...request, sourceId: 'recent-reference', replyContext: {
      authorName: 'Jarvis (Bot)', content: '最近の返信先', createdAt: now } });

    expect(prompts[0]).not.toContain('古い返信先');
    expect(prompts[1]).toContain('Jarvis (Bot): 最近の返信先');
    expect(prompts[1]).toContain('JST] Jarvis (Bot):');
  });

  it('履歴の保存失敗で分割回答の送信を中断しない', async () => {
    answer = '長い説明です。'.repeat(500);
    vi.spyOn(services.memory, 'saveReply').mockRejectedValue(new Error('storage unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ask('slash', '説明して');
    expect(sent.map((message) => message.content).join('')).toBe(answer);
  });

  it.each(['slash', 'message'])('%sの送信に失敗した回答は保存しない', async (kind) => {
    sendError = new Error('Discord unavailable');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ask(kind, '説明して');
    expect(prompts).toHaveLength(1);
    expect(sent).toEqual([]);
    expect((await db.recentMessages('c')).filter((message) => message.authorId === 'bot')).toEqual([]);
  });

  it('AIの障害案内は会話履歴に保存しない', async () => {
    generationError = new Error('AI unavailable');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ask('slash', '説明して');
    expect(sent[0]?.content).toContain('AI生成機能を利用できません');
    expect((await db.recentMessages('c')).filter((message) => message.authorId === 'bot')).toEqual([]);
  });

  it('Discordの返信先から表示名と発言時刻を取得する', async () => {
    const reference = { id: 'reference', content: '前の回答', createdTimestamp: Date.now(),
      author: { id: 'bot', displayName: 'Jarvis', bot: true }, member: { displayName: 'サーバー内のJarvis' } } as Message;
    await ask('message', '続きを教えて', reference);
    expect(prompts[0]).toContain('JST] サーバー内のJarvis (Bot): 前の回答');
  });

  it('分割回答の途中で送信が失敗しても保存済みの最初の回答を上書きしない', async () => {
    answer = '長い説明です。'.repeat(500);
    failFollowUp = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await ask('slash', '説明して');

    const replies = (await db.recentMessages('c')).filter((message) => message.authorId === 'bot');
    expect(sent[0]?.content.startsWith('長い説明です。')).toBe(true);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.content).toBe(sent[0]?.content);
  });

  it.each(['slash', 'message'])('%sの分割境界に秘密情報のラベルがあっても回答全体を保存しない', async (kind) => {
    answer = 'x'.repeat(1892) + 'api_key: secret';
    await ask(kind, '説明して');

    expect(sent.length).toBeGreaterThan(1);
    expect((await db.recentMessages('c')).filter((message) => message.authorId === 'bot')).toEqual([]);
  });
});
