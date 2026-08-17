import type { AppDatabase, SettingKey } from '../storage/database.js';
import type { UserSettings } from '../types/index.js';

export class AuthService {
  constructor(private readonly db: AppDatabase) {}

  async settings(userId: string): Promise<UserSettings> { return this.db.getSettings(userId); }

  async setOwnSetting(actorUserId: string, targetUserId: string, key: SettingKey, enabled: boolean): Promise<UserSettings> {
    if (actorUserId !== targetUserId) throw new Error('他人の設定は変更できません。');
    return this.db.setSetting(actorUserId, key, enabled);
  }

  async deleteOwnData(actorUserId: string, targetUserId: string): Promise<void> {
    if (actorUserId !== targetUserId) throw new Error('他人のデータは削除できません。');
    await this.db.deleteUserData(actorUserId);
    await this.db.audit(actorUserId, 'delete_my_data', actorUserId, 'completed');
  }
}
