import { SlashCommandBuilder } from 'discord.js';

const onOff = [
  { name: 'on', value: 'on' },
  { name: 'off', value: 'off' },
] as const;

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('ai').setDescription('AIへ明示的に質問・依頼する')
    .addStringOption((option) => option.setName('text').setDescription('質問または依頼'))
    .addAttachmentOption((option) => option.setName('file1').setDescription('解析する添付ファイル'))
    .addAttachmentOption((option) => option.setName('file2').setDescription('解析する添付ファイル'))
    .addAttachmentOption((option) => option.setName('file3').setDescription('解析する添付ファイル')),
  new SlashCommandBuilder()
    .setName('auth').setDescription('自分自身のAI権限・データ利用設定を管理する')
    .addSubcommand((sub) => sub.setName('status').setDescription('現在の個人設定を表示'))
    .addSubcommand((sub) => sub.setName('memory').setDescription('共有会話Memoryの利用を設定')
      .addStringOption((option) => option.setName('state').setDescription('on/off').setRequired(true).addChoices(...onOff)))
    .addSubcommand((sub) => sub.setName('personal_memory').setDescription('Personal Memoryを設定')
      .addStringOption((option) => option.setName('state').setDescription('on/off').setRequired(true).addChoices(...onOff)))
    .addSubcommand((sub) => sub.setName('tasks').setDescription('Task抽出を設定')
      .addStringOption((option) => option.setName('state').setDescription('on/off').setRequired(true).addChoices(...onOff)))
    .addSubcommand((sub) => sub.setName('interruption').setDescription('自分の発言を理由にした自然な乱入を設定')
      .addStringOption((option) => option.setName('state').setDescription('on/off').setRequired(true).addChoices(...onOff)))
    .addSubcommand((sub) => sub.setName('web').setDescription('Web検索利用を設定')
      .addStringOption((option) => option.setName('state').setDescription('on/off').setRequired(true).addChoices(...onOff)))
    .addSubcommand((sub) => sub.setName('development').setDescription('Development Agentを設定')
      .addStringOption((option) => option.setName('state').setDescription('on/off').setRequired(true).addChoices(...onOff)))
    .addSubcommand((sub) => sub.setName('github').setDescription('自分のGitHub接続を管理')
      .addStringOption((option) => option.setName('action').setDescription('操作').setRequired(true)
        .addChoices({ name: 'connect', value: 'connect' }, { name: 'disconnect', value: 'disconnect' }, { name: 'status', value: 'status' })))
    .addSubcommand((sub) => sub.setName('pc').setDescription('PC Connectorの状態を表示'))
    .addSubcommand((sub) => sub.setName('delete_my_data').setDescription('Personal Memory・設定・Taskを削除')),
  new SlashCommandBuilder().setName('tasks').setDescription('このチャンネルに関連する現在のTaskを表示'),
  new SlashCommandBuilder().setName('memory').setDescription('AIが保持している自分または現在チャンネルの要約を表示'),
].map((command) => command.toJSON());
