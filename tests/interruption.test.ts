import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/storage/database.js';
import { InterruptionService } from '../src/services/interruption.js';

describe('InterruptionService', () => {
  let db: AppDatabase;
  beforeEach(async () => { db = new AppDatabase(':memory:'); await db.initialize(); });
  afterEach(async () => db.close());

  it('5メッセージ未満では乱入せず、困惑文脈で確率が上がる', async () => {
    const service = new InterruptionService(db, () => 0);
    for (let i = 0; i < 4; i += 1) expect((await service.evaluate('c', 'u', '雑談', 1_000 + i)).shouldInterrupt).toBe(false);
    const result = await service.evaluate('c', 'u', 'エラー出た、わからん？', 10_000);
    expect(result.shouldInterrupt).toBe(true);
    expect(result.probability).toBeGreaterThan(0.5);
    expect((await service.evaluate('c', 'u', 'まだ困った', 10_001)).reason).toBe('minimum_messages');
  });

  it('interruption offを尊重する', async () => {
    await db.setSetting('u', 'interruption', false);
    const result = await new InterruptionService(db, () => 0).evaluate('c', 'u', '誰か知らん？');
    expect(result.reason).toBe('user_opt_out');
  });
});
