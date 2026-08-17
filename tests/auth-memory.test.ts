import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/storage/database.js';
import { AuthService } from '../src/services/auth.js';
import { MemoryService } from '../src/services/memory.js';

describe('Auth and Memory isolation', () => {
  let db: AppDatabase;
  beforeEach(async () => { db = new AppDatabase(':memory:'); await db.initialize(); });
  afterEach(async () => db.close());

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
});
