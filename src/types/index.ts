export type AgentKind =
  | 'conversation'
  | 'web'
  | 'task'
  | 'memory'
  | 'file'
  | 'coding'
  | 'development';

export interface UserSettings {
  memory: boolean;
  personalMemory: boolean;
  tasks: boolean;
  interruption: boolean;
  webAccess: boolean;
  githubConnected: boolean;
  developmentAgent: boolean;
  pcConnected: boolean;
}

export interface StoredMessage {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: number;
}

export type TaskStatus = 'open' | 'completed' | 'cancelled';

export interface StoredTask {
  id: number;
  guildId: string;
  channelId: string;
  ownerUserId: string | null;
  ownerDisplayName: string | null;
  title: string;
  description: string | null;
  deadline: number | null;
  status: TaskStatus;
  confidence: number;
  sourceMessageId: string;
  createdAt: number;
  updatedAt: number;
}

export interface AttachmentInput {
  name: string;
  url: string;
  size: number;
  contentType: string | null;
}

export interface ParsedAttachment {
  name: string;
  category: 'document' | 'image' | 'code' | 'archive';
  text: string;
  contentType: string;
  imageDataUrl?: string;
}

export interface ChatRequest {
  guildId: string;
  channelId: string;
  userId: string;
  userName: string;
  sourceId?: string;
  createdAt?: number;
  prompt: string;
  replyContext?: string;
  attachments?: AttachmentInput[];
  spontaneous?: boolean;
}

export interface ChatResult {
  content: string;
  agents: AgentKind[];
  degraded?: boolean;
}

export interface LlmRequest {
  prompt: string;
  route: 'light' | 'reasoning' | 'coding';
  imageDataUrls?: string[];
}

export interface LlmProvider {
  readonly name: string;
  complete(request: LlmRequest): Promise<string>;
  close?(): Promise<void>;
}
