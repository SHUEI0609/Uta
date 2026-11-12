import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/storage/database.js';
import { AuthService } from '../src/services/auth.js';
import { MemoryService } from '../src/services/memory.js';

describe('Auth and Memory isolation', () => {
  let db: AppDatabase;
  beforeEach(async () => { db = new AppDatabase(':memory:'); await db.initialize(); });
  afterEach(async () => { vi.useRealTimers(); await db.close(); });

  it('他人の設定を変更できない', async () => {
    const auth = new AuthService(db);
    await expect(auth.setOwnSetting('a', 'b', 'memory', false)).rejects.toThrow(/他人/u);
    expect((await auth.setOwnSetting('a', 'a', 'memory', false)).memory).toBe(false);
  });

  it('personal_memory offのユーザーから新規保存しない', async () => {
    const auth = new AuthService(db);
    const memory = new MemoryService(db);
    await auth.setOwnSetting('u', 'u', 'personalMemory', false);
    await memory.observe({ guildId: 'g', channelId: 'a', messageId: 'm', authorId: 'u', authorName: 'U',
      content: '私はTypeScriptを勉強中', createdAt: Date.now() });
    expect(await db.personalMemories('u')).toEqual([]);
  });

  it('別チャンネルの生ログを混ぜず、期限切れだけ削除する', async () => {
    const memory = new MemoryService(db);
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await memory.observe({ guildId: 'g', channelId: 'a', messageId: 'old', authorId: 'u', authorName: 'U', content: '古い秘密でない話', createdAt: old });
    await memory.observe({ guildId: 'g', channelId: 'b', messageId: 'new', authorId: 'u', authorName: 'U', content: 'Bだけの話', createdAt: Date.now() });
    await memory.cleanup();
    expect(await memory.context('g', 'a', 'u')).not.toContain('Bだけの話');
    expect(await db.recentMessages('a')).toHaveLength(0);
    expect(await db.getPersonality('g')).not.toBeNull();
  });

  it('会話の参照は過去24時間以内に絞り、日本時間と発言者を付ける', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T01:00:00Z'));
    const memory = new MemoryService(db);
    const message = { guildId: 'g', channelId: 'a', authorId: 'u', authorName: '田中' };
    await memory.observe({ ...message, messageId: 'old', content: '昨日より前の話',
      createdAt: Date.parse('2026-11-11T00:59:59.999Z') });
    await memory.observe({ ...message, messageId: 'boundary', content: '24時間ちょうどの話',
      createdAt: Date.parse('2026-11-11T01:00:00Z') });
    await memory.observe({ ...message, messageId: 'recent', content: '今の話', createdAt: Date.now() });

    const context = await memory.context('g', 'a', 'u');
    expect(context).not.toContain('昨日より前の話');
    expect(context).toContain('[2026/11/11 10:00:00 JST] 田中: 24時間ちょうどの話');
    expect(context).toContain('[2026/11/12 10:00:00 JST] 田中: 今の話');
    expect(context.indexOf('24時間ちょうどの話')).toBeLessThan(context.indexOf('今の話'));
    expect(await db.recentMessages('a')).toHaveLength(3);
  });

  it('文字数上限では古い発言から省き、最新の発言者と時刻を残す', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T01:00:00Z'));
    const memory = new MemoryService(db);
    const message = { guildId: 'g', channelId: 'a', authorId: 'u' };
    await memory.observe({ ...message, messageId: 'first', authorName: '前の人', content: 'あ'.repeat(7000),
      createdAt: Date.now() - 1000 });
    await memory.observe({ ...message, messageId: 'last', authorName: '最後の人', content: 'い'.repeat(13000),
      createdAt: Date.now() });

    const context = await memory.context('g', 'a', 'u');
    expect(context).not.toContain('前の人');
    expect(context).toContain('[2026/11/12 10:00:00 JST] 最後の人: ');
    expect(context).not.toContain('い'.repeat(12001));
  });

  it('Botの回答は次の会話で参照し、個人Memoryと口調の学習には使わない', async () => {
    const memory = new MemoryService(db);
    await memory.saveReply({ guildId: 'g', channelId: 'a', messageId: 'reply', authorId: 'bot',
      authorName: 'Jarvis (Bot)', content: '私はTypeScriptを勉強中。1. 復習する 2. 問題を解く', createdAt: Date.now() }, 'u');

    expect(await memory.context('g', 'a', 'u')).toContain('Jarvis (Bot): 私はTypeScriptを勉強中。1. 復習する 2. 問題を解く');
    expect(await memory.context('g', 'b', 'u')).not.toContain('問題を解く');
    expect(await db.personalMemories('bot')).toEqual([]);
    expect(await db.personalMemories('u')).toEqual([]);
    expect(await db.getPersonality('g')).toBeNull();
  });

  it('Memory OFFの依頼者への回答と秘密情報を含む回答は保存しない', async () => {
    const memory = new MemoryService(db);
    const reply = { guildId: 'g', channelId: 'a', authorId: 'bot', authorName: 'Jarvis (Bot)', createdAt: Date.now() };
    await db.setSetting('u', 'memory', false);
    await memory.saveReply({ ...reply, messageId: 'disabled', content: '保存しない回答' }, 'u');
    await memory.saveReply({ ...reply, messageId: 'secret', content: 'api_key: secret' }, 'other');
    expect(await db.recentMessages('a')).toEqual([]);
  });

  it('人間の発言から口調を更新する際もBotの回答は学習対象にしない', async () => {
    const memory = new MemoryService(db);
    await memory.saveReply({ guildId: 'g', channelId: 'a', messageId: 'reply', authorId: 'bot',
      authorName: 'Jarvis (Bot)', content: 'www www www 草 草 やで やで やで！！！！', createdAt: Date.now() }, 'u');
    for (let index = 0; index < 25; index += 1) {
      await memory.observe({ guildId: 'g', channelId: 'a', messageId: `human-${index}`, authorId: 'u',
        authorName: '田中', content: '普通の雑談', createdAt: Date.now() });
    }
    expect((await db.getPersonality('g'))?.summary).toBe('neutral_friendly。短めで自然な応答を好み、場を支配しない。');
  });
});
