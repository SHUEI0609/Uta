import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/storage/database.js';
import { TaskService, inferDeadline } from '../src/services/tasks.js';

describe('TaskService', () => {
  let db: AppDatabase;
  let service: TaskService;
  beforeEach(async () => { db = new AppDatabase(':memory:'); await db.initialize(); service = new TaskService(db); });
  afterEach(async () => db.close());

  it('「俺スライドやっとく」から発言者Taskを作る', async () => {
    await service.observe({ guildId: 'g', channelId: 'c', messageId: 'm1', authorId: 'u1', authorName: '田中',
      content: '俺スライドやっとく' });
    const [task] = await service.list('c');
    expect(task?.ownerUserId).toBe('u1');
    expect(task?.title).toContain('スライド');
  });

  it('mentionされた本人をownerにする', async () => {
    await service.observe({ guildId: 'g', channelId: 'c', messageId: 'm2', authorId: 'u1', authorName: '田中',
      content: '<@2> レポートお願い', mentionedUsers: [{ id: '2', name: '佐藤' }] });
    expect((await service.list('c'))[0]?.ownerUserId).toBe('2');
  });

  it('会話からowner訂正と完了を反映する', async () => {
    await service.observe({ guildId: 'g', channelId: 'c', messageId: 'm3', authorId: 'u1', authorName: '田中', content: '俺資料やっとく' });
    await service.observe({ guildId: 'g', channelId: 'c', messageId: 'm4', authorId: 'u1', authorName: '田中', content: 'それ俺のTaskじゃない' });
    expect((await service.list('c'))[0]?.ownerUserId).toBeNull();
    await service.observe({ guildId: 'g', channelId: 'c', messageId: 'm5', authorId: 'u2', authorName: '佐藤', content: 'もう終わった' });
    expect((await db.listTasks('c', true))[0]?.status).toBe('completed');
  });

  it('明後日の締切を日末として推定する', () => {
    const base = new Date(2026, 7, 16, 10).getTime();
    const deadline = new Date(inferDeadline('明後日まで', base) ?? 0);
    expect(deadline.getDate()).toBe(18);
    expect(deadline.getHours()).toBe(23);
  });
});
