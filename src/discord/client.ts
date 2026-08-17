import {
  ActionRowBuilder, Attachment, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Client,
  Events, GatewayIntentBits, Message, MessageFlags, Partials, type ButtonInteraction,
} from 'discord.js';
import type { AppConfig } from '../config.js';
import type { AppDatabase, SettingKey } from '../storage/database.js';
import type { AuthService } from '../services/auth.js';
import type { MemoryService } from '../services/memory.js';
import type { TaskService } from '../services/tasks.js';
import type { InterruptionService } from '../services/interruption.js';
import type { GithubService } from '../services/github.js';
import type { HarnessRouter } from '../harness/router.js';
import type { AttachmentInput, ChatResult, UserSettings } from '../types/index.js';
import { commandDefinitions } from './commands.js';
import { splitDiscordMessage } from './messages.js';

export interface DiscordServices {
  db: AppDatabase;
  auth: AuthService;
  memory: MemoryService;
  tasks: TaskService;
  interruption: InterruptionService;
  github: GithubService;
  router: HarnessRouter;
}

export function createDiscordClient(config: AppConfig, services: DiscordServices): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, async () => {
    if (!client.user || !client.application) return;
    if (config.discordGuildId) {
      const guild = await client.guilds.fetch(config.discordGuildId);
      await guild.commands.set(commandDefinitions);
      console.log(`Jarvis ready as ${client.user.tag}; guild commands registered.`);
    } else {
      await client.application.commands.set(commandDefinitions);
      console.log(`Jarvis ready as ${client.user.tag}; global commands registered.`);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) await handleCommand(interaction, services);
      else if (interaction.isButton()) await handleButton(interaction, services);
    } catch (error) {
      console.error('Interaction failed:', error);
      const content = `処理に失敗しました: ${safeError(error)}`;
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [] });
        else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    }
  });

  client.on('messageCreate', async (message) => {
    try { await handleMessage(message, client, services); }
    catch (error) { console.error('Message handling failed:', error); }
  });

  return client;
}

async function handleCommand(interaction: ChatInputCommandInteraction, services: DiscordServices): Promise<void> {
  const guildId = interaction.guildId ?? 'dm';
  const channelId = interaction.channelId;
  if (interaction.commandName === 'ai') {
    const prompt = interaction.options.getString('text')?.trim() ?? '';
    const attachments = ['file1', 'file2', 'file3'].flatMap((name) => {
      const file = interaction.options.getAttachment(name);
      return file ? [toAttachmentInput(file)] : [];
    });
    if (!prompt && !attachments.length) {
      await interaction.reply({ content: '質問または添付ファイルを指定してください。', flags: MessageFlags.Ephemeral });
      return;
    }
    const proposal = prompt ? await services.github.prepareWrite(interaction.user.id, prompt) : null;
    if (proposal) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`github:execute:${proposal.id}`).setLabel('実行').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`github:cancel:${proposal.id}`).setLabel('キャンセル').setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({ content: `実行前の確認が必要です。\n${proposal.summary}`, components: [row], flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();
    const result = await services.router.handle({ guildId, channelId, userId: interaction.user.id,
      userName: interaction.user.displayName, sourceId: interaction.id, createdAt: interaction.createdTimestamp,
      prompt: prompt || 'この添付ファイルを解析して', attachments });
    await sendInteractionResult(interaction, result);
    return;
  }
  if (interaction.commandName === 'tasks') {
    const tasks = await services.tasks.list(channelId);
    const content = tasks.length ? tasks.map((task) => {
      const deadline = task.deadline ? new Date(task.deadline).toLocaleString('ja-JP') : '不明';
      return `• **${task.title}**\n  owner: ${task.ownerDisplayName ?? '未割当'} / deadline: ${deadline} / status: ${task.status} / confidence: ${task.confidence.toFixed(2)}`;
    }).join('\n') : 'このチャンネルに進行中のTaskはありません。';
    await interaction.reply({ content });
    return;
  }
  if (interaction.commandName === 'memory') {
    await interaction.reply({ content: await services.memory.summaryForUser(guildId, channelId, interaction.user.id),
      flags: MessageFlags.Ephemeral });
    return;
  }
  if (interaction.commandName === 'auth') await handleAuth(interaction, services);
}

async function handleAuth(interaction: ChatInputCommandInteraction, services: DiscordServices): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const userId = interaction.user.id;
  if (subcommand === 'status') {
    const [settings, githubStatus] = await Promise.all([services.auth.settings(userId), services.github.status(userId)]);
    await interaction.reply({ content: formatSettings(settings, githubStatus),
      flags: MessageFlags.Ephemeral });
    return;
  }
  if (subcommand === 'pc') {
    await interaction.reply({ content: 'PC Connector: 未接続（v2機能）。Bot本体とPC以外の機能は利用できます。', flags: MessageFlags.Ephemeral });
    return;
  }
  if (subcommand === 'delete_my_data') {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`delete-data:confirm:${userId}`).setLabel('削除する').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`delete-data:cancel:${userId}`).setLabel('キャンセル').setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({ content: 'Personal Memory、個人設定、本人所有Task、GitHub接続を削除します。共有チャンネルの一般ログは30日ポリシーで別管理です。',
      components: [row], flags: MessageFlags.Ephemeral });
    return;
  }
  if (subcommand === 'github') {
    const action = interaction.options.getString('action', true);
    if (action === 'status') {
      await interaction.reply({ content: await services.github.status(userId), flags: MessageFlags.Ephemeral });
    } else if (action === 'disconnect') {
      await services.github.disconnect(userId);
      await interaction.reply({ content: 'GitHub接続を解除し、保存済み暗号化tokenを削除しました。', flags: MessageFlags.Ephemeral });
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const flow = await services.github.startConnection(userId);
      await interaction.editReply(`GitHubで [${flow.url}](${flow.url}) を開き、コード \`${flow.code}\` を入力してください。完了後 \`/auth github status\` で確認できます。`);
    }
    return;
  }
  const keyMap: Record<string, SettingKey> = {
    memory: 'memory', personal_memory: 'personalMemory', tasks: 'tasks', interruption: 'interruption',
    web: 'webAccess', development: 'developmentAgent',
  };
  const key = keyMap[subcommand];
  if (!key) throw new Error('不明な設定です。');
  const enabled = interaction.options.getString('state', true) === 'on';
  await services.auth.setOwnSetting(userId, userId, key, enabled);
  await interaction.reply({ content: `${subcommand}: ${enabled ? 'ON' : 'OFF'} に更新しました。`, flags: MessageFlags.Ephemeral });
}

async function handleButton(interaction: ButtonInteraction, services: DiscordServices): Promise<void> {
  const [scope, action, id] = interaction.customId.split(':');
  if (!id) return;
  if (scope === 'delete-data') {
    if (id !== interaction.user.id) throw new Error('この確認を操作できるのは本人だけです。');
    if (action === 'confirm') {
      await services.auth.deleteOwnData(interaction.user.id, id);
      await interaction.update({ content: '本人に紐づくデータを削除しました。', components: [] });
    } else await interaction.update({ content: '削除をキャンセルしました。', components: [] });
    return;
  }
  if (scope === 'github') {
    await interaction.deferUpdate();
    if (action === 'execute') {
      const result = await services.github.executePending(interaction.user.id, id);
      await interaction.editReply({ content: result, components: [] });
    } else {
      await services.github.cancelPending(interaction.user.id, id);
      await interaction.editReply({ content: 'GitHub書き込みをキャンセルしました。変更はありません。', components: [] });
    }
  }
}

async function handleMessage(message: Message, client: Client, services: DiscordServices): Promise<void> {
  if (message.author.bot || !message.content) return;
  const guildId = message.guildId ?? 'dm';
  const authorName = message.member?.displayName ?? message.author.displayName;
  await services.memory.observe({ guildId, channelId: message.channelId, messageId: message.id,
    authorId: message.author.id, authorName, content: message.content, createdAt: message.createdTimestamp });
  if ((await services.db.getSettings(message.author.id)).tasks) {
    await services.tasks.observe({ guildId, channelId: message.channelId, messageId: message.id,
      authorId: message.author.id, authorName, content: message.content, createdAt: message.createdTimestamp,
      mentionedUsers: message.mentions.users.map((user) => ({ id: user.id, name: user.displayName })) });
  }

  const botId = client.user?.id;
  const legacy = message.content.startsWith('!ai ');
  const mentioned = botId ? message.mentions.users.has(botId) : false;
  let repliedToBot = false;
  let replyContext: string | undefined;
  if (message.reference?.messageId) {
    const referenced = await message.fetchReference().catch(() => null);
    repliedToBot = referenced?.author.id === botId;
    replyContext = referenced ? `${referenced.author.displayName}: ${referenced.content}` : undefined;
  }
  if (!legacy && !mentioned && !repliedToBot) {
    const decision = await services.interruption.evaluate(message.channelId, message.author.id, message.content);
    if (!decision.shouldInterrupt) return;
    if ('sendTyping' in message.channel) await message.channel.sendTyping();
    const result = await services.router.handle({ guildId, channelId: message.channelId, userId: message.author.id,
      userName: authorName, sourceId: message.id, createdAt: message.createdTimestamp,
      prompt: message.content, spontaneous: true });
    await sendMessageResult(message, result);
    return;
  }
  const prompt = legacy ? message.content.slice(4).trim()
    : botId ? message.content.replace(new RegExp(`<@!?${botId}>`, 'gu'), '').trim() : message.content.trim();
  if (!prompt && !message.attachments.size) return;
  if ('sendTyping' in message.channel) await message.channel.sendTyping();
  const result = await services.router.handle({ guildId, channelId: message.channelId, userId: message.author.id,
    userName: authorName, sourceId: message.id, createdAt: message.createdTimestamp,
    prompt: prompt || 'この添付ファイルを解析して', replyContext,
    attachments: message.attachments.map(toAttachmentInput) });
  await sendMessageResult(message, result);
}

async function sendInteractionResult(interaction: ChatInputCommandInteraction, result: ChatResult): Promise<void> {
  const chunks = splitDiscordMessage(result.content);
  await interaction.editReply(chunks[0] ?? '応答が空でした。');
  for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
}

async function sendMessageResult(message: Message, result: ChatResult): Promise<void> {
  const chunks = splitDiscordMessage(result.content);
  if (chunks[0]) await message.reply(chunks[0]);
  if (!message.channel.isSendable()) return;
  for (const chunk of chunks.slice(1)) await message.channel.send(chunk);
}

function toAttachmentInput(file: Attachment): AttachmentInput {
  return { name: file.name, url: file.url, size: file.size, contentType: file.contentType };
}

function formatSettings(settings: UserSettings, githubStatus: string): string {
  return [
    `memory: ${onOff(settings.memory)}`, `personal_memory: ${onOff(settings.personalMemory)}`,
    `tasks: ${onOff(settings.tasks)}`, `interruption: ${onOff(settings.interruption)}`,
    `web: ${onOff(settings.webAccess)}`, `development: ${onOff(settings.developmentAgent)}`,
    `github: ${githubStatus}`, 'pc: 未接続（v2）',
  ].join('\n');
}

function onOff(value: boolean): string { return value ? 'ON' : 'OFF'; }
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/giu, 'Bearer [REDACTED]').slice(0, 500);
}
