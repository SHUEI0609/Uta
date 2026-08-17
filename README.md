# Discord AI Friend — Jarvis

`Detail.yaml` v1仕様に合わせて、旧Hugging Face Space + llama.cpp/Ollama構成を全面的に置き換えたDiscord Botです。Bot本体は常時稼働するNode.jsプロセス、推論は公式DeepSeek Harnessを経由したCloudflare Workers AI無料枠を使用します。永続データはローカル開発時のSQLiteと、Koyeb配備時のCloudflare D1を切り替えられます。Hugging Faceや所有者PC上のモデルには依存しません。

## 実装済み機能

- `/ai`、`/auth`、`/tasks`、`/memory`
- Mention、BotへのReply、移行期間用の既存`!ai`
- Discordの上限に合わせた、コードフェンスを保つ長文分割
- 同一チャンネルに限定した30日Memory、Personal Memory、長期Server Personality要約
- 会話からのTask自動抽出、owner/deadline推定、訂正・完了反映
- 約20メッセージに1回を基準とした文脈スコア付き乱入、10分cooldown、時間上限
- PDF、画像、テキスト、コード、制限付きZIPの解析
- 必要時だけ使う無料Web検索。外部コンテンツは未信頼データとして隔離
- GitHub Device Flow接続、本人権限でのrepo/Issue読み取り
- GitHubファイル作成・更新・削除、Issue更新、PR作成のDiscord確認ボタン。承認者を再検証し、結果を監査
- 無料枠のアプリ側日次上限と、provider quota超過時の課金なしdegrade
- `/health`、Docker healthcheck、SIGTERM graceful shutdown

## 構成

```text
Discord Gateway (Node.js, 常時接続)
  ├─ Auth / Memory / Task / Interruption / Attachment / GitHub services
  ├─ Local: SQLite / Koyeb: authenticated Worker API → Cloudflare D1
  └─ Main Router
       └─ Official DeepSeek Harness headless profile
            └─ Cloudflare Workers AI OpenAI-compatible endpoint (Free plan)
```

Cloudflare Workers単体はDiscord Gatewayの長時間接続と公式HarnessのNode runtimeを同時にホストする場所にはしていません。Workers AIだけを無料推論先として使い、Gatewayコンテナは常時稼働可能なNode 22.19+ホストに置きます。

## 1. Discord App設定

1. [Discord Developer Portal](https://discord.com/developers/applications)でApplicationとBotを作成します。
2. Botの`MESSAGE CONTENT INTENT`を有効にします。通常会話のMemory、Mention/Reply、Task抽出、自然な乱入に必要です。
3. OAuth2 URL Generatorで`bot`と`applications.commands`を選び、必要なサーバーへ追加します。
4. Bot権限は最低限`View Channels`、`Send Messages`、`Read Message History`、`Attach Files`を与えます。

## 2. Cloudflare無料推論設定

Cloudflare DashboardでWorkers AIを有効にし、Account IDとWorkers AI実行権限を持つAPI Tokenを用意します。有料プランへの自動変更処理はありません。Workers Freeの無料割当を超えるとCloudflare側の呼び出しは失敗し、Jarvisはその日AI生成を停止します。

```bash
cp .env.example .env
```

`.env`へ最低限、次を設定します。

```dotenv
DISCORD_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_API_TOKEN=...
```

開発中は`DISCORD_GUILD_ID`も指定するとSlash Commandが対象guildへ即時登録されます。未指定時はglobal commandとなり、反映に時間がかかる場合があります。

## 3. ローカル実行

公式DeepSeek Harnessの要件に合わせ、Node.js 22.19以上（DockerはNode 24）を使用します。

```bash
npm ci
npm run check
npm start
```

SQLiteは既定で`./data/jarvis.sqlite`に作られます。`.env`、DB、GitHub token暗号化鍵をGitへ追加しないでください。

## 4. Cloudflare D1を準備する（Koyeb用）

Koyeb無料枠には永続Volumeがないため、Memory、Task、設定、監査ログをD1へ保存します。BotからD1の管理APIを直接呼ばず、D1 Bindingを持つ認証付きWorkerだけを公開します。KoyebにはCloudflare API Tokenを保存しません。

まずCloudflareへWranglerでログインし、D1を作成します。

```bash
npx wrangler login
npx wrangler d1 create jarvis-discord
```

出力された`database_id`を`workers/d1-api/wrangler.jsonc`の`database_id`へ設定します。次にschemaを適用します。

```bash
npx wrangler d1 migrations apply jarvis-discord --remote --cwd workers/d1-api
```

BotとWorkerの間だけで使うランダムな共有シークレットを作り、Worker Secretとして対話入力します。値をコマンド引数、Git、READMEへ書かないでください。

```bash
openssl rand -hex 32
npx wrangler secret put API_TOKEN --cwd workers/d1-api
npx wrangler deploy --cwd workers/d1-api
```

最後の出力に表示される`https://jarvis-d1-api.<subdomain>.workers.dev`を控えます。ローカルでD1接続を試す場合は`workers/d1-api/.dev.vars.example`を`.dev.vars`へコピーし、実運用とは別の開発用値を設定します。

## 5. Koyeb無料枠へ配備する

1. このrepositoryを非公開GitHub repositoryへ移します。`.env`は絶対にcommitしません。
2. Koyebで`Web Service`を作り、GitHub repositoryと`Dockerfile`を選びます。
3. Instanceは`Free`、公開portは`7860`、health check pathは`/health`にします。
4. KoyebのEnvironment variablesへ`.env`の各値を登録し、次を追加・変更します。

```dotenv
DATABASE_BACKEND=d1
D1_PROXY_URL=https://jarvis-d1-api.<subdomain>.workers.dev
D1_PROXY_TOKEN=<WorkerのAPI_TOKENと同じ値>
PORT=7860
```

`D1_PROXY_TOKEN`、`DISCORD_TOKEN`、`CLOUDFLARE_API_TOKEN`、`GITHUB_TOKEN_ENCRYPTION_KEY`はKoyebのSecretとして扱います。D1利用時、SQLite volumeは不要です。

Koyebの配備後、その公開health URLをWorker Secretへ登録すると、Cloudflare Cronが毎時7分・37分に外形監視します。

```bash
npx wrangler secret put KOYEB_HEALTH_URL --cwd workers/d1-api
```

対話入力する値は`https://<Koyebのドメイン>/health`です。Koyeb無料Instanceは受信通信が1時間ないとsleepする仕様なので、この監視はスリープ回避に役立ちますが、GitHub Actions等と同様に常時稼働を保証しません。sleepや再配備後も、MemoryとTaskはD1から復元されます。

## 6. Dockerによるローカル常時稼働

```bash
docker build -t jarvis-discord .
docker run -d --name jarvis \
  --restart unless-stopped \
  --env-file .env \
  -p 7860:7860 \
  -v jarvis-data:/app/data \
  jarvis-discord
```

同じ構成は`docker compose up -d --build`でも起動できます。

Hugging Face固有のfront matter、モデルdownload、llama.cpp build、`start.sh`は削除済みです。所有者PCを切って動かす場合はKoyeb等の外部Node/Dockerホストを使います。ただし、第三者の無料ホストが永久に常時稼働することは、このrepositoryだけでは保証できません。

## 7. GitHub連携（任意）

GitHub OAuth AppでDevice Flowを有効にし、次を設定します。

```dotenv
GITHUB_CLIENT_ID=...
GITHUB_TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32 の結果>
```

Discordで`/auth github connect`を実行します。tokenはAES-256-GCMで暗号化してDBへ保存し、LLM promptには渡しません。

読み取りは接続した本人のtoken範囲内です。ファイル作成・更新は、次のようにrepo、path、内容を明示した依頼だけを提案化します。

````text
/ai GitHub owner/repo の path: src/example.ts を変更してcommit
```ts
export const value = 1;
```
````

Botは実行前に対象、変更ファイル、危険度を表示します。「実行」を押した本人を再検証した後だけGitHub APIを呼びます。「キャンセル」では何も変更しません。ファイル削除、Issue更新、`head:`を指定したPR作成も同じ確認経路を通ります。任意のShell、PCファイル操作、無確認pushはv1では実行しません。

## Privacy / Safety

- `/auth ... off`はコマンドを実行した本人にだけ適用され、他人の設定は変更できません。
- `/auth delete_my_data`は本人確認ボタンの後、Personal Memory、設定、本人所有Task、GitHub接続を削除します。共有チャンネルの一般ログは30日retentionに従います。
- SecretらしいメッセージはMemoryへ保存せず、GitHub credential値はprompt・監査ログへ含めません。
- ZIPは10MB、50 files、展開後20MBまで。実行ファイルは実行しません。
- HarnessのShell/File/Web toolsは`config/dsh.cordis.patch.yml`で無効です。外部操作はDiscord側の認可済みserviceだけが行います。
- 無料AI停止中も`/auth`、`/tasks`、`/memory`、retention cleanupは継続します。

## テスト

```bash
npm run check
```

Task抽出・訂正、Memory分離/retention、auth isolation、乱入制御、長文分割を自動テストしています。実際のDiscord token、Cloudflare token、GitHub OAuthはsecretを必要とするため、CIの単体テストでは外部呼び出しを行いません。

## 現時点の意図的な縮退

- v2 PC Connector、PC write/delete、Shellは無効です。
- Cloudflare Browser Rendering無料枠は1日あたりの時間が小さく、Gateway側から安定して必須依存にできないため、v1 Web Agentは固定検索endpointを使います。
- Workers AI無料割当を使い切った場合、有料providerへfallbackしません。
- 公式DeepSeek HarnessはDeveloper Previewです。`@deepseek-ai/dsh`を固定versionにし、更新時は`npm run check`とHarness smoke testを実施してください。
