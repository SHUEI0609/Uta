import type { AppDatabase } from '../storage/database.js';
import type { StoredTask } from '../types/index.js';

export interface TaskMessage {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  mentionedUsers?: Array<{ id: string; name: string }>;
  createdAt?: number;
}

export class TaskService {
  constructor(private readonly db: AppDatabase) {}

  async observe(message: TaskMessage): Promise<{ created?: number; updated?: number }> {
    const text = message.content.trim();
    if (!text) return {};

    const correction = await this.applyCorrection(message);
    if (correction) return { updated: correction };

    const mention = message.mentionedUsers?.[0];
    const selfAssignment = /(俺|僕|私|自分).{0,12}(やっとく|やる|担当する|しておく|仕上げる)/u.test(text);
    const mentionAssignment = Boolean(mention) && /(お願い|頼む|やって|担当|よろしく)/u.test(text);
    const teamAssignment = /(みんな|全員|チーム).{0,20}(やろう|確認|やる|対応)/u.test(text);
    if (!selfAssignment && !mentionAssignment && !teamAssignment) return {};

    const ownerUserId = selfAssignment ? message.authorId : mentionAssignment ? mention?.id ?? null : null;
    const ownerDisplayName = selfAssignment ? message.authorName : mentionAssignment ? mention?.name ?? null : 'みんな';
    const title = cleanTitle(text);
    if (title.length < 2) return {};
    const created = await this.db.createTask({
      guildId: message.guildId, channelId: message.channelId, ownerUserId, ownerDisplayName,
      title, description: text, deadline: inferDeadline(text, message.createdAt ?? Date.now()),
      status: 'open', confidence: selfAssignment ? 0.88 : mentionAssignment ? 0.84 : 0.62,
      sourceMessageId: message.messageId,
    });
    return created ? { created } : {};
  }

  async list(channelId: string): Promise<StoredTask[]> { return this.db.listTasks(channelId); }

  private async applyCorrection(message: TaskMessage): Promise<number | null> {
    const text = message.content;
    if (/(もう)?(終わった|完了した|できた|片付いた)/u.test(text)) {
      const task = await this.db.latestOpenTask(message.channelId, message.authorId)
        ?? await this.db.latestOpenTask(message.channelId);
      if (task) { await this.db.updateTask(task.id, { status: 'completed' }); return task.id; }
    }
    if (/(俺|僕|私)の\s*(Task|タスク|担当)?じゃない/u.test(text)) {
      const task = await this.db.latestOpenTask(message.channelId, message.authorId);
      if (task) { await this.db.updateTask(task.id, { ownerUserId: null, ownerDisplayName: '未割当' }); return task.id; }
    }
    const mention = message.mentionedUsers?.[0];
    if (mention && /(担当|のタスク|がやる)/u.test(text)) {
      const task = await this.db.latestOpenTask(message.channelId);
      if (task) {
        await this.db.updateTask(task.id, { ownerUserId: mention.id, ownerDisplayName: mention.name });
        return task.id;
      }
    }
    const deadline = inferDeadline(text, message.createdAt ?? Date.now());
    if (deadline && /(締切|期限|まで|明日|明後日)/u.test(text)) {
      const task = await this.db.latestOpenTask(message.channelId);
      if (task) { await this.db.updateTask(task.id, { deadline }); return task.id; }
    }
    return null;
  }
}

function cleanTitle(text: string): string {
  return text
    .replace(/<@!?\d+>/gu, '')
    .replace(/^(俺|僕|私|自分|みんな|全員|チーム)(が|は|で)?/u, '')
    .replace(/(お願い|頼む|よろしく)[！!。.]?$/u, '')
    .replace(/(やっとく|やる|担当する|しておく|仕上げる|やろう)[！!。.]?$/u, '')
    .trim().slice(0, 160);
}

export function inferDeadline(text: string, baseMs: number): number | null {
  const base = new Date(baseMs);
  const atEndOfDay = (days: number): number => {
    const value = new Date(base);
    value.setDate(value.getDate() + days);
    value.setHours(23, 59, 59, 999);
    return value.getTime();
  };
  if (/明後日/u.test(text)) return atEndOfDay(2);
  if (/明日/u.test(text)) return atEndOfDay(1);
  if (/今日中|今日まで/u.test(text)) return atEndOfDay(0);
  const match = text.match(/(?:(\d{4})[/-])?(\d{1,2})[/-月](\d{1,2})日?/u);
  if (!match) return null;
  const year = Number(match[1] ?? base.getFullYear());
  const date = new Date(year, Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  if (!match[1] && date.getTime() < baseMs) date.setFullYear(year + 1);
  return date.getTime();
}
