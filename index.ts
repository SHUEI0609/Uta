import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { Ollama } from 'ollama'; // インスタンス化のために{ Ollama }を使用

// 1. 自作ビルドした llama-server (11434ポート) に接続する設定
const ollama = new Ollama({ 
    host: 'http://127.0.0.1:11434' 
});

// 2. Botのクライアント初期化
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

// モデル名は llama-server がロードしているものが優先されます
const MODEL_NAME = 'qwen2.5-coder:1.5b';

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user?.tag}!`);
    console.log(`🚀 Connection established with llama-server on port 11434`);
});

client.on('messageCreate', async (message) => {
    // Bot自身の発言や、コマンド (!ai) で始まらない場合は無視
    if (message.author.bot || !message.content.startsWith('!ai ')) return;

    const userPrompt = message.content.slice(4).trim();
    if (!userPrompt) {
        message.reply('質問を入力してください（例：!ai 〇〇について教えて）');
        return;
    }

    // 入力中の「...を打ち込んでいます」を表示
    await message.channel.sendTyping();

    try {
        // 3. AIへのリクエスト
        const response = await ollama.chat({
            model: MODEL_NAME,
            messages: [
                { 
                    role: 'system', 
                    content: 'あなたは親切で優秀なAIアシスタントです。特定の個人に関する情報は持っていません。知能情報やプログラミングに関する質問に客観的に答えてください。'
                },
                { role: 'user', content: userPrompt }
            ],
            stream: false,
        });

        // 4. llama-server と Ollama 公式のレスポンス形式の違いを吸収する
        // response.message.content が空でも (response as any).content を見に行く
        const replyContent = 
            response.message?.content || 
            (response as any).content || 
            (response as any).choices?.[0]?.message?.content || 
            (response as any).response || // llama.cpp の一部のバージョン
            "AIからの返答が空でした。構造を確認してください。";

        // Discordの2000文字制限対策
        if (replyContent.length > 2000) {
            await message.reply(replyContent.substring(0, 1900) + '... (長文のため省略しました)');
        } else {
            await message.reply(replyContent);
        }

    } catch (error) {
        console.error('❌ Error details:', error);
        await message.reply('AIサーバーとの通信に失敗しました。`llama-server` がターミナルで動いているか確認してください。');
    }
});

// Hugging Face Secrets または .env に設定したトークン
client.login(process.env.DISCORD_TOKEN);