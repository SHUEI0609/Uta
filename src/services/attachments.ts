import { extname } from 'node:path';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';
import type { AttachmentInput, ParsedAttachment } from '../types/index.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.c', '.h', '.cpp', '.hpp', '.py', '.js', '.ts', '.tsx',
  '.jsx', '.java', '.rs', '.go', '.php', '.html', '.css', '.json', '.yaml', '.yml']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 50;
const MAX_ARCHIVE_UNCOMPRESSED = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;

export class AttachmentService {
  async parseAll(inputs: AttachmentInput[]): Promise<ParsedAttachment[]> {
    return Promise.all(inputs.slice(0, 5).map((input) => this.parse(input)));
  }

  private async parse(input: AttachmentInput): Promise<ParsedAttachment> {
    if (input.size > MAX_FILE_BYTES) throw new Error(`${input.name}: 10MBを超えるため処理できません。`);
    const extension = extname(input.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && !IMAGE_EXTENSIONS.has(extension) && extension !== '.pdf' && extension !== '.zip') {
      throw new Error(`${input.name}: 対応していない、または安全に判定できない形式です。`);
    }
    const response = await fetch(input.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${input.name}: ダウンロードに失敗しました。`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_FILE_BYTES) throw new Error(`${input.name}: 実サイズが上限を超えています。`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${input.name}: 実サイズが上限を超えています。`);
    const contentType = input.contentType ?? response.headers.get('content-type') ?? 'application/octet-stream';

    if (IMAGE_EXTENSIONS.has(extension)) {
      return { name: input.name, category: 'image', text: `[画像 ${input.name}]`, contentType,
        imageDataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}` };
    }
    if (extension === '.pdf') {
      const parser = new PDFParse({ data: bytes });
      try {
        const result = await parser.getText();
        return { name: input.name, category: 'document', text: result.text.slice(0, MAX_TEXT_CHARS), contentType };
      } finally { await parser.destroy(); }
    }
    if (extension === '.zip') return this.parseZip(input.name, bytes, contentType);
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replaceAll('\0', '');
    return { name: input.name, category: TEXT_EXTENSIONS.has(extension) && extension !== '.txt' && extension !== '.md'
      ? 'code' : 'document', text: text.slice(0, MAX_TEXT_CHARS), contentType };
  }

  private async parseZip(name: string, bytes: Uint8Array, contentType: string): Promise<ParsedAttachment> {
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const files = Object.values(zip.files).filter((file) => !file.dir);
    if (files.length > MAX_ARCHIVE_FILES) throw new Error(`${name}: ZIP内のファイル数が上限を超えています。`);
    let total = 0;
    const sections: string[] = [];
    for (const file of files) {
      if (file.name.includes('..') || file.name.startsWith('/') || file.name.includes('\\')) {
        throw new Error(`${name}: 安全でないZIPパスを検出しました。`);
      }
      const extension = extname(file.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(extension)) continue;
      const data = await file.async('uint8array');
      total += data.byteLength;
      if (total > MAX_ARCHIVE_UNCOMPRESSED) throw new Error(`${name}: ZIP展開サイズが上限を超えています。`);
      sections.push(`--- ${file.name} ---\n${new TextDecoder().decode(data).slice(0, 12_000)}`);
    }
    return { name, category: 'archive', text: sections.join('\n').slice(0, MAX_TEXT_CHARS)
      || '安全に読めるテキストファイルはありませんでした。', contentType };
  }
}
