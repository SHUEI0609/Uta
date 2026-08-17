import type { AppDatabase } from '../storage/database.js';
import type { StoredMessage } from '../types/index.js';

const SECRET_PATTERN = /(password|passwd|api[_ -]?key|token|秘密鍵|パスワード|住所|電話番号)\s*[:=：]/iu;

export class MemoryService {
  constructor(private readonly db: AppDatabase) {}

  async observe(message: StoredMessage): Promise<void> {
    const settings = await this.db.getSettings(message.authorId);
    if (!settings.memory || SECRET_PATTERN.test(message.content)) return;
    if (!(await this.db.addMessage(message))) return;
    if (settings.personalMemory) await this.extractPersonalMemory(message);
    await this.updatePersonality(message.guildId, message.channelId);
  }

  async context(guildId: string, channelId: string, userId: string): Promise<string> {
    const settings = await this.db.getSettings(userId);
    const recent = settings.memory ? await this.db.recentMessages(channelId, 50) : [];
    const conversation = recent.map((item) => `${item.authorName}: ${item.content}`).join('\n').slice(-12_000);
    const personal = settings.personalMemory ? await this.db.personalMemories(userId, 12) : [];
    const personality = (await this.db.getPersonality(guildId))?.summary ?? 'まだサーバー固有の話し方を十分に学習していない。';
    return [
      `【同じチャンネルの直近文脈】\n${conversation || 'なし'}`,
      `【この本人について利用可能なPersonal Memory】\n${personal.join('\n') || 'なし'}`,
      `【Server Personality（抽象要約）】\n${personality}`,
    ].join('\n\n');
  }

  async summaryForUser(guildId: string, channelId: string, userId: string): Promise<string> {
    const settings = await this.db.getSettings(userId);
    const personal = settings.personalMemory ? await this.db.personalMemories(userId, 20) : [];
    const channelCount = settings.memory ? (await this.db.recentMessages(channelId, 200)).length : 0;
    const personality = (await this.db.getPersonality(guildId))?.summary ?? '未学習';
    return `共有チャンネルMemory: ${settings.memory ? `${channelCount}件（表示は件数のみ）` : 'OFF'}\n`
      + `Personal Memory: ${settings.personalMemory ? (personal.map((v) => `・${v}`).join('\n') || 'まだありません') : 'OFF'}\n`
      + `Server Personality: ${personality}`;
  }

  async cleanup(): Promise<number> { return this.db.cleanupExpiredMessages(); }

  private async extractPersonalMemory(message: StoredMessage): Promise<void> {
    const patterns = [
      /(?:俺|僕|私|自分)は(.{2,50}?)(?:が好き|を勉強中|を勉強してる|を使ってる|が得意)/u,
      /(?:普段|主に)(.{2,50}?)(?:を使う|使ってる|で開発)/u,
    ];
    for (const pattern of patterns) {
      const match = message.content.match(pattern);
      if (match?.[0] && !SECRET_PATTERN.test(match[0])) {
        await this.db.addPersonalMemory(message.authorId, match[0].slice(0, 120), message.messageId);
        break;
      }
    }
  }

  private async updatePersonality(guildId: string, channelId: string): Promise<void> {
    const previous = await this.db.getPersonality(guildId);
    const nextCount = (previous?.sampleCount ?? 0) + 1;
    if (nextCount % 25 !== 0) {
      await this.db.setPersonality(guildId, previous?.summary ?? 'neutral_friendly', nextCount);
      return;
    }
    const text = (await this.db.recentMessages(channelId, 200)).map((m) => m.content).join('\n');
    const traits: string[] = [];
    if ((text.match(/w+/gu) ?? []).length >= 3) traits.push('笑いの表現として「w」をよく使う');
    if ((text.match(/草/gu) ?? []).length >= 2) traits.push('軽いツッコミで「草」を使う');
    if ((text.match(/やで|やん|やろ/gu) ?? []).length >= 3) traits.push('関西寄りのくだけた語尾がある');
    if ((text.match(/[!！]{2,}/gu) ?? []).length >= 2) traits.push('勢いのある短文が多い');
    const summary = traits.length ? `会話テンポは短め。${traits.join('。')}。攻撃的表現や個人情報は模倣しない。`
      : 'neutral_friendly。短めで自然な応答を好み、場を支配しない。';
    await this.db.setPersonality(guildId, summary, nextCount);
  }
}
