import { ComponentSource } from '../types';

export interface Skill {
  name: string;
  path: string;
  description: string;
  content: string;
  source: ComponentSource;
}

/**
 * 提取技能的详细描述，包含名称、描述和内容摘要
 */
export function extractSkillDescription(skill: Skill): string {
  const lines: string[] = [];
  lines.push(`- ${skill.name}: ${skill.description}`);

  // 截取内容的前 200 字符作为摘要
  if (skill.content) {
    const summary = skill.content.replace(/\n/g, ' ').trim().slice(0, 200);
    lines.push(`    摘要: ${summary}${skill.content.length > 200 ? '...' : ''}`);
  }

  return lines.join('\n');
}
