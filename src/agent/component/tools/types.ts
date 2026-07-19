import { ComponentSource } from '../types';

export type ToolCapability =
  | 'filesystem-read'
  | 'filesystem-write'
  | 'shell'
  | 'network';

export interface ToolPermissions {
  /**
   * 工具需要的高风险能力。shell、network、filesystem-write 默认要求用户确认。
   * 旧工具未声明时，加载器会根据参数名和工具名做保守推断。
   */
  capabilities?: ToolCapability[];
  /** 包含文件或目录路径的参数名；未声明时自动识别 path/filePath/dir/cwd 等常见名称。 */
  pathArguments?: string[];
  /** 允许传给工具的 settings.env 键。默认不传递任何环境变量。 */
  env?: string[];
  /** 即使没有高风险能力，也要求每次调用前确认。 */
  requiresConfirmation?: boolean;
}

export interface ToolMetadata {
  name: string;
  description: string;
  version?: string;
  parameters: Record<string, any>;
  dependencies?: string[];
  enabled?: boolean;
  permissions?: ToolPermissions;
  /** 单次调用超时，默认 30 秒。 */
  timeoutMs?: number;
  /** 返回给模型的最大字符数，默认 50,000。 */
  maxOutputChars?: number;
}

export interface ToolApprovalRequest {
  toolName: string;
  capabilities: ToolCapability[];
  reason: string;
  argsPreview: string;
  /**
   * 当前工作区内可持久记忆的授权范围。
   * 例如 capability:shell 或 outside-workspace:/absolute/path。
   */
  approvalId: string;
  /** false 时界面只允许单次授权。 */
  rememberable?: boolean;
}

export interface ToolContext {
  env: Record<string, string>;
  workspaceDir: string;
  availableComponents?: string;
  signal?: AbortSignal;
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
  /** 将路径安全地解析到工作区内；工具应优先使用此方法。 */
  resolvePath?: (inputPath: string) => string;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    tool?: string;
    truncated?: boolean;
    originalChars?: number;
  };
}

export interface Tool {
  name: string;
  description: string;
  version?: string;
  parameters: Record<string, any>;
  dependencies?: string[];
  permissions?: ToolPermissions;
  timeoutMs?: number;
  maxOutputChars?: number;
  source: ComponentSource;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
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
      const desc = def.description || '';
      lines.push(`    - ${paramName} ${requiredMark} [${typeInfo}]: ${desc}`);
    }
  }

  return lines.join('\n');
}
