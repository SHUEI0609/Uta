import { describe, expect, it } from 'vitest';
import { splitDiscordMessage } from '../src/discord/messages.js';

describe('splitDiscordMessage', () => {
  it('長文を欠落させずDiscord上限未満へ分割する', () => {
    const text = '長い文章です。'.repeat(600);
    const chunks = splitDiscordMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1900)).toBe(true);
    expect(chunks.join('')).toBe(text);
  });

  it('分割されたコードフェンスを閉じる', () => {
    const chunks = splitDiscordMessage(`\`\`\`ts\n${'const value = 1;\n'.repeat(180)}\`\`\``);
    expect(chunks.every((chunk) => chunk.length <= 1900)).toBe(true);
    expect(chunks.every((chunk) => (chunk.match(/```/gu)?.length ?? 0) % 2 === 0)).toBe(true);
  });
});
