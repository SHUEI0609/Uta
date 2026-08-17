import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../storage/database.js';

interface DeviceCodeResponse { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number; }
type GithubWritePayload =
  | { operation: 'write'; owner: string; repo: string; path: string; content: string; commitMessage: string }
  | { operation: 'delete'; owner: string; repo: string; path: string; commitMessage: string }
  | { operation: 'pull_request'; owner: string; repo: string; head: string; base?: string; title: string; body?: string }
  | { operation: 'issue_update'; owner: string; repo: string; issue: number; state?: 'closed' | 'open'; comment?: string };

export class GithubService {
  constructor(private readonly db: AppDatabase, private readonly config: AppConfig) {}

  async startConnection(userId: string): Promise<{ code: string; url: string }> {
    if (!this.config.githubClientId) throw new Error('GITHUB_CLIENT_IDが未設定です。');
    if (!this.encryptionKey()) throw new Error('GITHUB_TOKEN_ENCRYPTION_KEYが未設定または不正です。');
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.githubClientId, scope: 'repo read:user' }),
    });
    if (!response.ok) throw new Error(`GitHub Device Flowを開始できません (${response.status})`);
    const body = await response.json() as DeviceCodeResponse;
    void this.pollConnection(userId, body);
    return { code: body.user_code, url: body.verification_uri };
  }

  async disconnect(userId: string): Promise<void> {
    await this.db.setGithubCredential(userId, null, null);
    await this.db.audit(userId, 'github_disconnect', 'self', 'completed');
  }

  async status(userId: string): Promise<string> {
    const credential = await this.db.getGithubCredential(userId);
    return credential ? `接続済み${credential.login ? `: ${credential.login}` : ''}` : '未接続';
  }

  async contextForPrompt(userId: string, prompt: string): Promise<string> {
    const credential = await this.db.getGithubCredential(userId);
    if (!credential) return '【Development Agent】GitHubは未接続です。`/auth github connect` を実行してください。';
    const target = parseGithubTarget(prompt);
    if (!target) return '【Development Agent】対象の `owner/repo` またはGitHub URLを依頼に含めてください。';
    const token = this.decrypt(credential.ciphertext);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'JarvisDiscordBot/2.0' };
    const repoResponse = await fetch(`https://api.github.com/repos/${target.owner}/${target.repo}`, { headers });
    if (!repoResponse.ok) return `【Development Agent】リポジトリを読めません (${repoResponse.status})。本人のGitHub権限を確認してください。`;
    const repo = await repoResponse.json() as { full_name: string; description: string | null; default_branch: string; language: string | null };
    const details: string[] = [];
    if (target.issue) {
      const issueResponse = await fetch(`https://api.github.com/repos/${target.owner}/${target.repo}/issues/${target.issue}`, { headers });
      if (issueResponse.ok) {
        const item = await issueResponse.json() as { title: string; body: string | null; state: string };
        details.push(`Issue #${target.issue}: ${item.title} (${item.state})\n${item.body?.slice(0, 8000) ?? ''}`);
      }
    }
    const pullNumber = prompt.match(/(?:pull\/(\d+)|(?:PR|pull request)\s*#?(\d+))/iu);
    const pull = Number(pullNumber?.[1] ?? pullNumber?.[2] ?? 0);
    if (pull > 0) {
      const [pullResponse, filesResponse] = await Promise.all([
        fetch(`https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${pull}`, { headers }),
        fetch(`https://api.github.com/repos/${target.owner}/${target.repo}/pulls/${pull}/files?per_page=30`, { headers }),
      ]);
      if (pullResponse.ok) {
        const item = await pullResponse.json() as { title: string; body: string | null; state: string; head: { ref: string }; base: { ref: string } };
        const files = filesResponse.ok ? await filesResponse.json() as Array<{ filename: string; status: string; patch?: string }> : [];
        details.push(`PR #${pull}: ${item.title} (${item.state}, ${item.head.ref} -> ${item.base.ref})\n${item.body?.slice(0, 6000) ?? ''}\n`
          + files.map((file) => `${file.status} ${file.filename}\n${file.patch?.slice(0, 3000) ?? ''}`).join('\n').slice(0, 12_000));
      }
    }
    const blob = prompt.match(/github\.com\/[\w.-]+\/[\w.-]+\/blob\/([^/\s]+)\/([^\s#?]+)/iu);
    if (blob?.[1] && blob[2]) {
      const contentUrl = `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${blob[2].split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(blob[1])}`;
      const contentResponse = await fetch(contentUrl, { headers });
      if (contentResponse.ok) {
        const file = await contentResponse.json() as { content?: string; encoding?: string; path?: string };
        const content = file.encoding === 'base64' && file.content ? Buffer.from(file.content.replace(/\s/gu, ''), 'base64').toString('utf8') : '';
        details.push(`File ${file.path ?? blob[2]} @ ${blob[1]}:\n${content.slice(0, 16_000)}`);
      }
    }
    const searchTerm = prompt.match(/(?:code search|コード検索|search)\s*[:：]\s*([^\n]+)/iu)?.[1]?.trim();
    if (searchTerm) {
      const searchResponse = await fetch(`https://api.github.com/search/code?q=${encodeURIComponent(`${searchTerm} repo:${target.owner}/${target.repo}`)}&per_page=10`, { headers });
      if (searchResponse.ok) {
        const result = await searchResponse.json() as { items?: Array<{ path: string; html_url: string }> };
        details.push(`Code search: ${searchTerm}\n${result.items?.map((item) => `- ${item.path}: ${item.html_url}`).join('\n') ?? '結果なし'}`);
      }
    }
    await this.db.audit(userId, 'github_read', repo.full_name, 'completed');
    return `【Development Agent: 本人権限で取得したGitHub文脈】\nRepository: ${repo.full_name}\nDescription: ${repo.description ?? ''}\nDefault branch: ${repo.default_branch}\nLanguage: ${repo.language ?? 'unknown'}\n${details.join('\n\n').slice(0, 30_000)}\n書き込み・commit・push・PR作成は、この読み取りだけでは実行しない。Discord上の明示確認が必須。`;
  }

  async prepareWrite(userId: string, prompt: string): Promise<{ id: string; summary: string } | null> {
    if (!/(作成|変更|編集|削除|書き込|commit|コミット|push|pull request|PR)/iu.test(prompt)) return null;
    const target = parseGithubTarget(prompt);
    if (!target) return null;
    if (!(await this.db.getGithubCredential(userId))) throw new Error('先に `/auth github connect` で本人のGitHubを接続してください。');
    const id = randomBytes(12).toString('hex');
    if (target.issue && /(issue|Issue|#\d+).{0,30}(更新|閉じ|close|open|再開|コメント|comment)/iu.test(prompt)) {
      const comment = prompt.match(/```(?:md|markdown)?\n([\s\S]*?)```/u)?.[1]
        ?? prompt.match(/(?:コメント|comment)\s*[:：]\s*([^\n]+)/iu)?.[1];
      const state = /(閉じ|close)/iu.test(prompt) ? 'closed' as const : /(再開|reopen)/iu.test(prompt) ? 'open' as const : undefined;
      if (!comment && !state) throw new Error('Issue更新内容をコードブロックのコメント、または close/reopen で指定してください。');
      const payload: GithubWritePayload = { operation: 'issue_update', owner: target.owner, repo: target.repo,
        issue: target.issue, state, comment: comment?.slice(0, 20_000) };
      await this.db.createPendingAction(id, userId, 'github_write', payload, Date.now() + 10 * 60 * 1000);
      await this.db.audit(userId, 'github_issue_proposed', `${target.owner}/${target.repo}#${target.issue}`, 'pending_confirmation');
      return { id, summary: `変更内容: Issue #${target.issue}を更新${comment ? '・コメント追加' : ''}${state ? `・state=${state}` : ''}\n対象: ${target.owner}/${target.repo}\n危険度: 中（Issue mutation）` };
    }
    if (/(pull request|PR).{0,20}(作成|open|開いて)/iu.test(prompt)) {
      const head = prompt.match(/head\s*[:：=]\s*([\w./-]+)/iu)?.[1];
      if (!head) throw new Error('PR作成には `head: ブランチ名` を指定してください。');
      const base = prompt.match(/base\s*[:：=]\s*([\w./-]+)/iu)?.[1];
      const title = prompt.match(/title\s*[:：=]\s*([^\n]+)/iu)?.[1]?.trim() ?? `Jarvis: ${head}`;
      const body = prompt.match(/```(?:md|markdown)?\n([\s\S]*?)```/u)?.[1];
      const payload: GithubWritePayload = { operation: 'pull_request', owner: target.owner, repo: target.repo,
        head, base, title: title.slice(0, 250), body: body?.slice(0, 20_000) };
      await this.db.createPendingAction(id, userId, 'github_write', payload, Date.now() + 10 * 60 * 1000);
      await this.db.audit(userId, 'github_pr_proposed', `${target.owner}/${target.repo}:${head}`, 'pending_confirmation');
      return { id, summary: `変更内容: Pull Requestを作成\n対象: ${target.owner}/${target.repo}\nhead: ${head}\nbase: ${base ?? 'default branch'}\n危険度: 中（PR作成）` };
    }
    const pathMatch = prompt.match(/(?:path|ファイル|対象)\s*[:：=]?\s*`?([\w./-]+\.[\w-]+)`?/iu);
    const code = prompt.match(/```(?:[\w+-]+)?\n([\s\S]*?)```/u)?.[1];
    if (!pathMatch?.[1]) return null;
    const path = pathMatch[1];
    if (path.startsWith('/') || path.split('/').includes('..') || (code?.length ?? 0) > 500_000) {
      throw new Error('GitHub書き込み対象のパスまたは内容サイズが安全条件を満たしません。');
    }
    const deleting = /(削除|delete|remove)/iu.test(prompt);
    if (!deleting && code === undefined) return null;
    const payload: GithubWritePayload = deleting
      ? { operation: 'delete', owner: target.owner, repo: target.repo, path, commitMessage: `Jarvis: delete ${path}` }
      : { operation: 'write', owner: target.owner, repo: target.repo, path, content: code ?? '', commitMessage: `Jarvis: update ${path}` };
    await this.db.createPendingAction(id, userId, 'github_write', payload, Date.now() + 10 * 60 * 1000);
    await this.db.audit(userId, 'github_write_proposed', `${target.owner}/${target.repo}:${path}`, 'pending_confirmation');
    return { id, summary: `変更内容: ファイルを${deleting ? '削除' : '作成または更新'}し、1件のcommitを作成\n対象: ${target.owner}/${target.repo}\n変更ファイル: ${path}\n危険度: ${deleting ? '高' : '中'}（リポジトリへの書き込み）` };
  }

  async executePending(userId: string, id: string): Promise<string> {
    const pending = await this.db.pendingAction(id);
    if (!pending || pending.status !== 'pending') throw new Error('この操作は存在しないか、すでに処理済みです。');
    if (pending.userId !== userId) throw new Error('この操作を承認できるのは作成した本人だけです。');
    if (pending.expiresAt < Date.now()) { await this.db.finishPendingAction(id, 'failed'); throw new Error('確認の有効期限が切れました。'); }
    if (pending.kind !== 'github_write') throw new Error('未対応の操作です。');
    const payload = pending.payload as GithubWritePayload;
    const credential = await this.db.getGithubCredential(userId);
    if (!credential) throw new Error('GitHub接続が解除されています。');
    const token = this.decrypt(credential.ciphertext);
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'JarvisDiscordBot/2.0' };
    const repoResponse = await fetch(`https://api.github.com/repos/${payload.owner}/${payload.repo}`, { headers });
    if (!repoResponse.ok) throw new Error(`実行直前のリポジトリ権限確認に失敗しました (${repoResponse.status})`);
    const repo = await repoResponse.json() as { default_branch: string };
    if (payload.operation === 'issue_update') {
      if (payload.state) {
        const stateResponse = await fetch(`https://api.github.com/repos/${payload.owner}/${payload.repo}/issues/${payload.issue}`, {
          method: 'PATCH', headers, body: JSON.stringify({ state: payload.state }),
        });
        if (!stateResponse.ok) return this.failAction(id, userId, 'github_issue_update',
          `${payload.owner}/${payload.repo}#${payload.issue}`, stateResponse.status);
      }
      let commentUrl: string | undefined;
      if (payload.comment) {
        const commentResponse = await fetch(`https://api.github.com/repos/${payload.owner}/${payload.repo}/issues/${payload.issue}/comments`, {
          method: 'POST', headers, body: JSON.stringify({ body: payload.comment }),
        });
        if (!commentResponse.ok) return this.failAction(id, userId, 'github_issue_comment',
          `${payload.owner}/${payload.repo}#${payload.issue}`, commentResponse.status);
        commentUrl = (await commentResponse.json() as { html_url?: string }).html_url;
      }
      await this.db.finishPendingAction(id, 'executed');
      await this.db.audit(userId, 'github_issue_update', `${payload.owner}/${payload.repo}#${payload.issue}`, 'completed');
      return `Issue #${payload.issue}を更新しました${commentUrl ? `: ${commentUrl}` : '。'}`;
    }
    if (payload.operation === 'pull_request') {
      const response = await fetch(`https://api.github.com/repos/${payload.owner}/${payload.repo}/pulls`, {
        method: 'POST', headers, body: JSON.stringify({ title: payload.title, head: payload.head,
          base: payload.base ?? repo.default_branch, body: payload.body ?? '' }),
      });
      if (!response.ok) return this.failAction(id, userId, 'github_pr_create', `${payload.owner}/${payload.repo}`, response.status);
      const result = await response.json() as { html_url?: string; number?: number };
      await this.db.finishPendingAction(id, 'executed');
      await this.db.audit(userId, 'github_pr_create', `${payload.owner}/${payload.repo}#${result.number ?? ''}`, 'completed');
      return `Pull Requestを作成しました: ${result.html_url ?? `#${result.number ?? '?'}`}`;
    }
    const contentUrl = `https://api.github.com/repos/${payload.owner}/${payload.repo}/contents/${payload.path.split('/').map(encodeURIComponent).join('/')}`;
    const existing = await fetch(`${contentUrl}?ref=${encodeURIComponent(repo.default_branch)}`, { headers });
    let sha: string | undefined;
    if (existing.ok) sha = (await existing.json() as { sha?: string }).sha;
    else if (existing.status !== 404) throw new Error(`既存ファイルの確認に失敗しました (${existing.status})`);
    if (payload.operation === 'delete' && !sha) throw new Error('削除対象ファイルが存在しません。');
    const response = await fetch(contentUrl, { method: payload.operation === 'delete' ? 'DELETE' : 'PUT', headers,
      body: JSON.stringify(payload.operation === 'delete'
        ? { message: payload.commitMessage, sha, branch: repo.default_branch }
        : { message: payload.commitMessage, content: Buffer.from(payload.content, 'utf8').toString('base64'),
          branch: repo.default_branch, ...(sha ? { sha } : {}) }) });
    if (!response.ok) {
      return this.failAction(id, userId, payload.operation === 'delete' ? 'github_file_delete' : 'github_file_write',
        `${payload.owner}/${payload.repo}:${payload.path}`, response.status);
    }
    const result = await response.json() as { commit?: { html_url?: string; sha?: string } };
    await this.db.finishPendingAction(id, 'executed');
    await this.db.audit(userId, payload.operation === 'delete' ? 'github_file_delete' : 'github_file_write',
      `${payload.owner}/${payload.repo}:${payload.path}`, 'completed');
    return `実行しました。commit: ${result.commit?.html_url ?? result.commit?.sha ?? 'created'}`;
  }

  async cancelPending(userId: string, id: string): Promise<void> {
    const pending = await this.db.pendingAction(id);
    if (!pending || pending.userId !== userId) throw new Error('この操作をキャンセルできません。');
    await this.db.finishPendingAction(id, 'cancelled');
    await this.db.audit(userId, 'github_write_cancelled', id, 'cancelled');
  }

  private async failAction(id: string, userId: string, action: string, target: string, status: number): Promise<never> {
    await this.db.finishPendingAction(id, 'failed');
    await this.db.audit(userId, action, target, `failed_${status}`);
    throw new Error(`GitHub操作に失敗しました (${status})`);
  }

  private async pollConnection(userId: string, device: DeviceCodeResponse): Promise<void> {
    if (!this.config.githubClientId) return;
    const expiresAt = Date.now() + device.expires_in * 1000;
    let interval = Math.max(device.interval, 5) * 1000;
    while (Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: this.config.githubClientId, device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const result = await response.json() as { access_token?: string; error?: string; interval?: number };
      if (result.error === 'authorization_pending') continue;
      if (result.error === 'slow_down') { interval += 5000; continue; }
      if (!result.access_token) return;
      const user = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${result.access_token}`,
        Accept: 'application/vnd.github+json', 'User-Agent': 'JarvisDiscordBot/2.0' } });
      const profile = user.ok ? await user.json() as { login?: string } : {};
      await this.db.setGithubCredential(userId, this.encrypt(result.access_token), profile.login ?? null);
      await this.db.audit(userId, 'github_connect', profile.login ?? 'self', 'completed');
      return;
    }
  }

  private encryptionKey(): Buffer | null {
    if (!this.config.githubEncryptionKey || !/^[a-f\d]{64}$/iu.test(this.config.githubEncryptionKey)) return null;
    return Buffer.from(this.config.githubEncryptionKey, 'hex');
  }

  private encrypt(value: string): string {
    const key = this.encryptionKey();
    if (!key) throw new Error('暗号化キーがありません。');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
  }

  private decrypt(value: string): string {
    const key = this.encryptionKey();
    if (!key) throw new Error('暗号化キーがありません。');
    const [ivText, tagText, dataText] = value.split('.');
    if (!ivText || !tagText || !dataText) throw new Error('GitHub credentialの形式が不正です。');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64')), decipher.final()]).toString('utf8');
  }
}

function parseGithubTarget(text: string): { owner: string; repo: string; issue?: number } | null {
  const url = text.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\/issues\/(\d+))?(?:[\s/#?]|$)/iu);
  const shorthand = text.match(/(?:^|\s)([\w.-]+)\/([\w.-]+)(?:#(\d+))?(?:\s|$)/u);
  const match = url ?? shorthand;
  if (!match?.[1] || !match[2]) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/u, ''), issue: match[3] ? Number(match[3]) : undefined };
}
