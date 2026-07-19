import { ComponentSource } from '../types';

export interface Subagent {
  name: string;
  description: string;
  agentPrompt: string;
  tools?: string[];
  skills?: string[];
  disallowedTools?: string[];
  disallowedSkills?: string[];
  model?: string | 'inherit';
  maxRounds?: number;
  allowWorkspaceComponents?: boolean;
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

  const tools = subagent.tools ?? [];
  const skills = subagent.skills ?? [];

  if (tools.length > 0) {
    lines.push(`    工具: ${tools.join(', ')}`);
  }

  if (skills.length > 0) {
    lines.push(`    技能: ${skills.join(', ')}`);
  }

  // 截取 agentPrompt 的前 200 字符作为摘要
  if (subagent.agentPrompt) {
    const summary = subagent.agentPrompt.replace(/\n/g, ' ').trim().slice(0, 200);
    lines.push(`    角色摘要: ${summary}${subagent.agentPrompt.length > 200 ? '...' : ''}`);
  }

  return lines.join('\n');
}
