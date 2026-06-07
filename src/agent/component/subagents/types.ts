import { Tool } from '../tools/types';
import { Skill } from '../skills/types';
import { ComponentSource } from '../types';

export interface Subagent {
  name: string;
  description: string;
  agentPrompt: string;
  tools: Tool[];
  skills: Skill[];
  source: ComponentSource;
  /** 子代理所在目录的绝对路径（包含 AGENT.md 的目录） */
  subAgentPath: string;
}

/**
 * 提取子代理的详细描述，包含名称、描述、拥有的工具和技能列表
 */
export function extractSubagentDescription(subagent: Subagent): string {
  const lines: string[] = [];
  lines.push(`- ${subagent.name}: ${subagent.description}`);

  if (subagent.tools.length > 0) {
    lines.push(`    工具: ${subagent.tools.map(t => t.name).join(', ')}`);
  }

  if (subagent.skills.length > 0) {
    lines.push(`    技能: ${subagent.skills.map(s => s.name).join(', ')}`);
  }

  // 截取 agentPrompt 的前 200 字符作为摘要
  if (subagent.agentPrompt) {
    const summary = subagent.agentPrompt.replace(/\n/g, ' ').trim().slice(0, 200);
    lines.push(`    角色摘要: ${summary}${subagent.agentPrompt.length > 200 ? '...' : ''}`);
  }

  return lines.join('\n');
}
