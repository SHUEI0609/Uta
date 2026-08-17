import type { AppDatabase } from '../storage/database.js';

export class QuotaExceededError extends Error {}

export class QuotaService {
  constructor(private readonly db: AppDatabase, private readonly dailyLimit: number) {}

  async assertAvailable(): Promise<void> {
    const usage = await this.db.quota(this.day());
    if (usage.exhausted || usage.requests >= this.dailyLimit) {
      throw new QuotaExceededError('無料AI枠の安全上限に達しました。課金せず、翌日のリセットまでAI生成を停止します。');
    }
  }

  async consume(): Promise<void> { await this.db.incrementQuota(this.day()); }
  async markProviderExhausted(): Promise<void> { await this.db.markQuotaExhausted(this.day()); }
  private day(): string { return new Date().toISOString().slice(0, 10); }
}
