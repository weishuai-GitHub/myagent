import { ComponentSource } from '../types';

export interface ToolMetadata {
  name: string;
  description: string;
  version: string;
  parameters: object;
  dependencies: string[];
  enabled: boolean;
}

export interface ToolContext {
  env: Record<string, string>;
  workspaceDir: string;
  availableComponents?: string;
}

export interface ToolResult {
  success: boolean;
  result?: any;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: any;
  source: ComponentSource;
  execute: (args: any, context: ToolContext) => Promise<any>;
}

/**
 * 提取工具的详细描述，包含名称、描述和参数说明
 */
export function extractToolDescription(tool: Tool): string {
  const lines: string[] = [];
  lines.push(`- ${tool.name}: ${tool.description}`);

  if (tool.parameters && tool.parameters.properties) {
    const props = tool.parameters.properties;
    const required: string[] = tool.parameters.required || [];
    for (const [paramName, paramDef] of Object.entries(props)) {
      const def = paramDef as any;
      const requiredMark = required.includes(paramName) ? '(必填)' : '(可选)';
      const typeInfo = def.type || '';
      const desc = def.description ? ` - ${def.description}` : '';
      lines.push(`    - name: ${paramName} required: ${requiredMark} type: ${typeInfo} desc:${desc}`);
    }
  }

  return lines.join('\n');
}
