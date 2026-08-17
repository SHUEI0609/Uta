import type { AppDatabase } from '../storage/database.js';

export interface InterruptionDecision { shouldInterrupt: boolean; probability: number; reason: string; }

export class InterruptionService {
  constructor(private readonly db: AppDatabase, private readonly random: () => number = Math.random) {}

  async evaluate(channelId: string, userId: string, content: string, now = Date.now()): Promise<InterruptionDecision> {
    const state = await this.db.getInterruptionState(channelId);
    const recent = state.recent.filter((time) => now - time < 60 * 60 * 1000);
    const messagesSince = state.messagesSince + 1;
    await this.db.saveInterruptionState(channelId, messagesSince, state.lastAt, recent);
    if (!(await this.db.getSettings(userId)).interruption) return decision(false, 0, 'user_opt_out');
    if (messagesSince < 5) return decision(false, 0, 'minimum_messages');
    if (state.lastAt && now - state.lastAt < 10 * 60 * 1000) return decision(false, 0, 'cooldown');
    if (recent.length >= 4) return decision(false, 0, 'hourly_limit');
    if (/(住所|パスワード|秘密|病気|家庭|恋愛相談)/u.test(content)) return decision(false, 0, 'sensitive');
    if (/^(おは|おやすみ|ただいま|こんにちは)[！!。.]?$/u.test(content.trim())) return decision(false, 0.01, 'greeting_only');

    let probability = 0.05;
    const reasons: string[] = ['baseline'];
    if (/(わからん|分からない|どうする|詰んだ|エラー|誰か知らん|助けて)/u.test(content)) {
      probability += 0.45; reasons.push('confusion');
    }
    if (/[?？]$/u.test(content.trim())) { probability += 0.30; reasons.push('question'); }
    if (/(どこ行く|何買えば|今日.*試合|最新|ニュース)/u.test(content)) {
      probability += 0.18; reasons.push('search_need');
    }
    if (/(TypeError|Exception|error:|エラー|バグ|コンパイル)/iu.test(content)) {
      probability += 0.35; reasons.push('code_problem');
    }
    probability = Math.min(probability, 0.85);
    if (this.random() >= probability) return decision(false, probability, reasons.join(','));
    const nextRecent = [...recent, now];
    await this.db.saveInterruptionState(channelId, 0, now, nextRecent);
    return decision(true, probability, reasons.join(','));
  }
}

function decision(shouldInterrupt: boolean, probability: number, reason: string): InterruptionDecision {
  return { shouldInterrupt, probability, reason };
}
