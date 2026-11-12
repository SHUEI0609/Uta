# 会話履歴と回答方針の改善

ユーザー指定の3点を既存のMemoryとDiscord送信処理へ組み込む。新しい依存関係やDB列は追加しない。

1. `AppDatabase.recentMessages`に開始時刻を追加し、Memoryの会話参照を過去24時間に絞る。
   保存期間30日、直近50件、12,000文字の上限は維持する。時刻は日本時間と明記し、古い発言から省く。
2. Discordへの送信成功後に各回答を保存する。Slash Command、Mention/Reply、旧`!ai`、乱入を同じ経路で扱う。
   `MemoryService.saveReply`は依頼者のMemory設定と秘密情報フィルターを尊重し、Botから個人Memoryや口調を学習しない。
   分割回答と保存失敗も確認し、保存失敗で残りの送信を止めない。
3. 返信先にも発言者・時刻を渡し、24時間を超えた返信先を除外する。
   システム指示と通常回答の指示を更新し、簡潔さと必要な説明を両立する。
4. 先に失敗するテストを追加し、実装後に全テスト・型チェック・Worker dry runを実行する。

対象: `src/storage/database.ts`, `src/services/memory.ts`, `src/discord/client.ts`,
`src/types/index.ts`, `src/harness/router.ts`, `src/harness/provider.ts`,
`config/dsh.cordis.patch.yml`, `README.md`, 関連テスト。

重点確認: 24時間の境界、別チャンネル混入、Memory OFF、Botの個人Memory化、
送信失敗・分割回答、文字数制限での発言者・時刻欠落、古い返信先による時間制限の迂回。

既存の未コミット変更を維持し、同じ作業ディレクトリで作業する。本番配備・Discordへのテスト投稿は行わない。

完了: 38テスト、型チェック、Worker dry run、`git diff --check`が成功。
独立レビューの指摘2件（途中送信失敗による最初の回答の上書き、分割境界での秘密情報検出漏れ）は、失敗を再現するテストを追加して修正済み。
