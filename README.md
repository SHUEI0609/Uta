# Discord Bot — 雪村ウタ

旧Hugging Face Space + llama.cpp/Ollama構成を置き換えたDiscord Botです。Bot本体は常時稼働するNode.jsプロセス、推論にはGemini 4 HydrogenのAPI無料枠を使用できます。Geminiのキーが未設定の場合は、従来の公式DeepSeek HarnessとCloudflare Workers AIを使用します。RenderではHarnessを起動せずWorkers AIの互換APIを直接呼びます。永続データはローカル開発時のSQLiteと、Render配備時のCloudflare D1を切り替えられます。

## 実装済み機能

- `/ai`、`/auth`、`/tasks`、`/memory`、`/url`（英数字5〜15文字の `.com` URLをランダム生成し、HTTPSで2xxが返るまで探索。固定候補・試行回数の上限なし。IPv4の公開アドレスだけを確認し、転送先はたどりません）
- Mention、BotへのReply、移行期間用の既存`!ai`
- Discordの上限に合わせた、コードフェンスを保つ長文分割
- 同一チャンネルに限定した30日Memory、過去24時間の会話参照、Personal Memory、長期Server Personality要約
- 会話からのTask自動抽出、owner/deadline推定、訂正・完了反映
- 約20メッセージに1回を基準とした文脈スコア付き乱入、10分cooldown、時間上限
- PDF、画像、テキスト、コード、制限付きZIPの解析
- 必要時だけ使う無料Web検索。外部コンテンツは未信頼データとして隔離
- GitHub Device Flow接続、本人権限でのrepo/Issue読み取り
- GitHubファイル作成・更新・削除、Issue更新、PR作成のDiscord確認ボタン。承認者を再検証し、結果を監査
- アプリ側の日次上限と、API利用上限に達した場合の生成停止・案内
- `/health`、Docker healthcheck、SIGTERM graceful shutdown

## 構成

```text
Discord Gateway (Node.js, 常時接続)
  ├─ Auth / Memory / Task / Interruption / Attachment / GitHub services
  ├─ Local: SQLite / Render: authenticated Worker API → Cloudflare D1
  └─ Main Router
       ├─ GEMINI_API_KEYあり → Gemini 4 Hydrogen API（テキスト・画像を1回で送信）
       └─ GEMINI_API_KEYなし → DeepSeek Harness / Cloudflare Workers AI
```

Gatewayコンテナは常時稼働可能なNode 22.19+ホストに置きます。Gemini利用時はHarnessのプロセスを起動しません。

## 1. Discord App設定

1. [Discord Developer Portal](https://discord.com/developers/applications)でApplicationとBotを作成します。
2. Botの`MESSAGE CONTENT INTENT`を有効にします。通常会話のMemory、Mention/Reply、Task抽出、自然な乱入に必要です。
3. OAuth2 URL Generatorで`bot`と`applications.commands`を選び、必要なサーバーへ追加します。
4. Bot権限は最低限`View Channels`、`Send Messages`、`Read Message History`、`Attach Files`を与えます。

## 2. Gemini無料推論設定

[Google AI Studio](https://aistudio.google.com/api-keys)で、課金アカウントを紐付けていないFree TierプロジェクトのAPIキーを作成します。[Projects](https://aistudio.google.com/projects)でFree Tierであることを確認してください。

APIには無料枠専用の指定がありません。有料Tierのキーを使うと、このBotからの呼び出しにも料金が発生します。Bot側の回数制限は無課金を保証する機能ではありません。詳しくは[公式の課金説明](https://aistudio.google.com/docs/billing)を参照してください。

```bash
cp .env.example .env
```

`.env`へ最低限、次を設定します。

```dotenv
DISCORD_TOKEN=...
GEMINI_API_KEY=...
```

開発中は`DISCORD_GUILD_ID`も指定するとSlash Commandが対象guildへ即時登録されます。未指定時はglobal commandとなり、反映に時間がかかる場合があります。

`GEMINI_API_KEY`を設定するとGemini 4 Hydrogen（`gemini-4-hydrogen`）を使います。画像と本文は同じリクエストに含め、思考レベルは低くして会話の待ち時間を抑えます。障害・上限超過時に別のモデルやCloudflareへ自動で切り替える処理はありません。

Geminiへ送るリクエスト全体が20MBを超える場合は、APIを呼ばず画像のサイズ・枚数を減らすよう案内します。

`AI_DAILY_REQUEST_LIMIT`は既定100回で、Bot全体の上限です。失敗したAPI呼び出しも数え、UTC日付でリセットします。Google側の分単位・日次上限は別に適用され、実際の割当は[AI Studio](https://aistudio.google.com/rate-limit)で確認できます。429では待機を案内し、次の依頼で再度試します。日次枠だと判別できた場合はGoogle側のリセット待ちと案内します。Googleの日次枠は太平洋時間でリセットされるため、Geminiの429でBot独自の終日停止フラグは立てません。

### 従来のCloudflare Workers AIを使う場合

`GEMINI_API_KEY`を未設定にし、Cloudflare DashboardでWorkers AIを有効にして、`CLOUDFLARE_ACCOUNT_ID`と`CLOUDFLARE_API_TOKEN`を設定します。会話生成と画像解析の既定モデルはLlama 4 Scout（`@cf/meta/llama-4-scout-17b-16e-instruct`）です。Workers Freeの割当超過時は、その日のAI生成を停止します。

モデルを変更する場合は`CLOUDFLARE_AI_MODEL`を設定して再起動してください。画像解析は`CLOUDFLARE_VISION_MODEL`で指定できます。Renderの環境変数を設定済みの場合はRender側も更新してください。

### 会話とMemory

Vtuber「雪村ウタ」として会話し、AIや設定・返答方針についてのメタな説明は自分から挟みません。普段は敬語なしの自然なタメ口で返し、文章作成などで文体を指定された場合はその指定に合わせます。
自分への悪口には、その内容に合わせて短く強気に言い返し、履歴にある同じ台詞や書き出しの繰り返しを避けます。「死ね」「しね」などの強い暴言を直接向けられたときは、普段より強い怒りを示して厳しく抗議します。普通の指摘や引用には逆ギレせず、話題が変わったら怒りを引きずりません。

回答には、同じチャンネルの過去24時間から直近50件・最大12,000文字を、日本時間の発言時刻と発言者付きで渡します。Botが送信した回答も含みます。
Memory OFFの依頼者への回答や秘密情報らしい回答は保存せず、Botの回答からPersonal Memoryや口調を学習しません。返信先の文脈も過去24時間以内に限定します。
ログの保存期間は30日のままで、Personal MemoryとServer Personalityの保持期間は変更しません。Bot停止中や変更前のBot回答をDiscordから遡って取得する処理はありません。

## 3. ローカル実行

公式DeepSeek Harnessの要件に合わせ、Node.js 22.19以上（DockerはNode 24）を使用します。

```bash
npm ci
npm run check
npm start
```

SQLiteは既定で`./data/jarvis.sqlite`に作られます。`.env`、DB、GitHub token暗号化鍵をGitへ追加しないでください。

## 4. Cloudflare D1を準備する（Render用）

Render無料枠のローカルファイルは再起動や再配備で失われるため、Memory、Task、設定、監査ログをD1へ保存します。BotからD1の管理APIを直接呼ばず、D1 Bindingを持つ認証付きWorkerだけを公開します。RenderにはD1管理用のCloudflare API Tokenを保存しません。

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

## 5. Render無料枠へ配備する

1. このrepositoryをGitHub repositoryへ移します。`.env`は絶対にcommitしません。
2. Renderで`Web Service`を作り、GitHub repositoryと`Docker` runtimeを選びます。
3. Instanceは`Free`、health check pathは`/health`にします。
4. RenderのEnvironment variablesへ`.env`の各値を登録し、次を追加・変更します。

```dotenv
DATABASE_BACKEND=d1
D1_PROXY_URL=https://jarvis-d1-api.<subdomain>.workers.dev
D1_PROXY_TOKEN=<WorkerのAPI_TOKENと同じ値>
PORT=7860
```

`D1_PROXY_TOKEN`、`DISCORD_TOKEN`、`GEMINI_API_KEY`、`CLOUDFLARE_API_TOKEN`、`GITHUB_TOKEN_ENCRYPTION_KEY`はRenderのSecretとして扱います。Geminiを使う場合はRender側にも`GEMINI_API_KEY`を登録してください。D1利用時、永続diskは不要です。

Renderの配備後、公開health URLを`workers/d1-api/wrangler.jsonc`の`RENDER_HEALTH_URL`へ設定すると、Cloudflare Cronが10分間隔で外形監視します。

Render無料Web Serviceは受信通信が15分ないとsleepするため、この監視はスリープ回避に役立ちますが、無料ホストで常時稼働を保証するものではありません。sleepや再配備後も、MemoryとTaskはD1から復元されます。

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

Hugging Face固有のfront matter、モデルdownload、llama.cpp build、`start.sh`は削除済みです。所有者PCを切って動かす場合はRender等の外部Node/Dockerホストを使います。ただし、第三者の無料ホストが永久に常時稼働することは、このrepositoryだけでは保証できません。

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

- Gemini無料枠へ送った会話履歴・Personal Memory・添付内容はGoogleの製品改善に利用される扱いです。参加者に共有し、秘密情報を送らないでください。[公式の料金・データ利用説明](https://aistudio.google.com/docs/pricing#gemini-4-hydrogen)
- `/auth ... off`はコマンドを実行した本人にだけ適用され、他人の設定は変更できません。
- `/auth delete_my_data`は本人確認ボタンの後、Personal Memory、設定、本人所有Task、GitHub接続を削除します。共有チャンネルの一般ログは30日retentionに従います。
- SecretらしいメッセージはMemoryへ保存せず、GitHub credential値はprompt・監査ログへ含めません。
- ZIPは10MB、50 files、展開後20MBまで。実行ファイルは実行しません。
- HarnessのShell/File/Web toolsは`config/dsh.cordis.patch.yml`で無効です。外部操作はDiscord側の認可済みserviceだけが行います。
- 無料AI停止中も`/auth`、`/tasks`、`/memory`、`/url`、retention cleanupは継続します。

## テスト

```bash
npm run check
```

Task抽出・訂正、Memory分離/retention、auth isolation、乱入制御、長文分割、Geminiの画像送信・利用制限を自動テストしています。実際のDiscord token、Gemini API key、Cloudflare token、GitHub OAuthはsecretを必要とするため、CIの単体テストでは外部呼び出しを行いません。

Workers AIのHTTPエラーは、サーバーログの `Workers AI request failed:` で確認できます。HTTPステータス、モデル名、Cloudflareの `cf-ray`、エラー本文（秘密情報を伏せて最大2,000文字）を記録します。会話生成と画像解析の両方が対象です。RenderではサービスのLogsを開いて確認してください。

GeminiのHTTPエラーは `Gemini API request failed:` で同様に確認できます。APIキーはログへ出さず、エラー本文内のキーも伏せます。

## 現時点の意図的な縮退

- v2 PC Connector、PC write/delete、Shellは無効です。
- Cloudflare Browser Rendering無料枠は1日あたりの時間が小さく、Gateway側から安定して必須依存にできないため、v1 Web Agentは固定検索endpointを使います。
- Gemini・Workers AIの利用上限や障害時に、別のproviderへ自動でfallbackしません。
- 公式DeepSeek HarnessはDeveloper Previewです。`@deepseek-ai/dsh`を固定versionにし、更新時は`npm run check`とHarness smoke testを実施してください。
