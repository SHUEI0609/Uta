export function splitDiscordMessage(text: string, maxChars = 1900): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  let remaining = text;
  let openFence = '';
  while (remaining.length) {
    const wasOpen = Boolean(openFence);
    const prefix = openFence ? `${openFence}\n` : '';
    const budget = maxChars - prefix.length - 4;
    let cut = Math.min(budget, remaining.length);
    if (cut < remaining.length) {
      const newline = remaining.lastIndexOf('\n', cut);
      const space = remaining.lastIndexOf(' ', cut);
      cut = Math.max(newline > budget * 0.55 ? newline : 0, space > budget * 0.7 ? space : 0, cut);
    }
    const part = remaining.slice(0, cut);
    const fences = [...part.matchAll(/```([^\n]*)/gu)];
    let suffix = '';
    const endsOpen = wasOpen ? fences.length % 2 === 0 : fences.length % 2 === 1;
    if (endsOpen) {
      const latest = fences.at(-1)?.[1]?.trim() ?? '';
      if (!wasOpen || fences.length > 0) openFence = `\`\`\`${latest}`;
      suffix = '\n```';
    } else {
      openFence = '';
    }
    chunks.push(`${prefix}${part}${suffix}`);
    remaining = remaining.slice(cut).replace(/^\n/u, '');
  }
  return chunks;
}
