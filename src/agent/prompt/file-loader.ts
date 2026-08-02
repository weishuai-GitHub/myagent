import * as fs from 'fs';

export function stripMarkdownFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

export function readMarkdownPrompt(filePath: string): string {
  if (!fs.existsSync(filePath)) return '';
  return stripMarkdownFrontmatter(fs.readFileSync(filePath, 'utf-8')).trim();
}
