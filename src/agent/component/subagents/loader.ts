import * as path from 'path';
import * as fs from 'fs';
import { Subagent } from './types';
import { ComponentSource } from '../types';

/**
 * 从指定目录加载所有子代理
 */
export function loadSubagentsFromDir(baseDir: string, source: ComponentSource, subagentsMap: Map<string, Subagent>): void {
  const subagentsDir = path.join(baseDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return;

  const dirs = fs.readdirSync(subagentsDir);
  for (const dir of dirs) {
    const subagentPath = path.join(subagentsDir, dir);
    if (!fs.statSync(subagentPath).isDirectory()) continue;

    const agentMdPath = path.join(subagentPath, 'AGENT.md');
    if (!fs.existsSync(agentMdPath)) continue;

    try {
      const content = fs.readFileSync(agentMdPath, 'utf-8');
      const { name, description, body } = parseAgentMarkdown(content);
      if (subagentsMap.has(name)) {
        console.log(`Subagent "${name}" from home overridden by workspace`);
      }
      subagentsMap.set(name, {
        name,
        description,
        agentPrompt: body,
        tools: [],
        skills: [],
        source,
        subAgentPath: subagentPath
      });
    } catch (e) {
      console.error(`Failed to load subagent ${dir} from ${source}:`, e);
    }
  }
}

/**
 * 解析 AGENT.md：提取 YAML 元数据和正文
 */
export function parseAgentMarkdown(content: string): { name: string; description: string; body: string } {
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
