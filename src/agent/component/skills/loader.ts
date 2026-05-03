import * as path from 'path';
import * as fs from 'fs';
import { Skill } from './types';
import { ComponentSource } from '../types';

/**
 * 从指定目录加载所有技能
 */
export function loadSkillsFromDir(baseDir: string, source: ComponentSource, skillsMap: Map<string, Skill>): void {
  const skillsDir = path.join(baseDir, 'skills');
  if (!fs.existsSync(skillsDir)) return;

  const dirs = fs.readdirSync(skillsDir);
  for (const dir of dirs) {
    const skillPath = path.join(skillsDir, dir);
    if (!fs.statSync(skillPath).isDirectory()) continue;

    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const { name, description, body } = parseSkillMarkdown(content);
      if (skillsMap.has(name)) {
        console.log(`Skill "${name}" from home overridden by workspace`);
      }
      skillsMap.set(name, {
        name,
        path: skillMdPath,
        description,
        content: body,
        source
      });
    } catch (e) {
      console.error(`Failed to load skill ${dir} from ${source}:`, e);
    }
  }
}

/**
 * 获取技能内容
 */
export async function getSkillContent(skills: Skill[], skillName: string): Promise<string> {
  const skill = skills.find(s => s.name === skillName);
  if (!skill) {
    throw new Error(`Skill ${skillName} not found`);
  }
  return `the path of ${skillName} is ${skill.path}, and its content is:\n${skill.content}`;
}

/**
 * 解析 SKILL.md：提取 YAML 元数据和正文
 */
export function parseSkillMarkdown(content: string): { name: string; description: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { name: '', description: '', body: content };
  }

  const yamlContent = match[1];
  const body = match[2];

  const nameMatch = yamlContent.match(/name:\s*(.+)/);
  const descMatch = yamlContent.match(/description:\s*(.+)/);

  return {
    name: nameMatch?.[1]?.trim() || '',
    description: descMatch?.[1]?.trim() || '',
    body
  };
}
