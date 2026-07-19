import * as fs from 'fs';
import * as path from 'path';
import {
  Tool,
  ToolApprovalRequest,
  ToolCapability,
  ToolContext
} from './types';

const WRITE_NAME_PATTERN = /(?:write|edit|delete|remove|rename|move|copy|patch|create)/i;
const PATH_NAME_PATTERN = /^(?:path|filePath|dirPath|directory|cwd|root)$/i;

export function inferCapabilities(tool: Tool): ToolCapability[] {
  const declared = tool.permissions?.capabilities ?? [];
  const inferred = new Set<ToolCapability>(declared);
  const properties = tool.parameters?.properties ?? {};

  if (Object.prototype.hasOwnProperty.call(properties, 'command')) inferred.add('shell');
  if (WRITE_NAME_PATTERN.test(tool.name)) inferred.add('filesystem-write');
  if (getPathArgumentNames(tool).length > 0 && !inferred.has('filesystem-write')) {
    inferred.add('filesystem-read');
  }
  return [...inferred];
}

export function getPathArgumentNames(tool: Tool): string[] {
  if (tool.permissions?.pathArguments) return [...tool.permissions.pathArguments];
  const properties = tool.parameters?.properties ?? {};
  return Object.keys(properties).filter(name =>
    properties[name]?.format === 'path' || PATH_NAME_PATTERN.test(name)
  );
}

export async function authorizeToolCall(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<void> {
  const capabilities = inferCapabilities(tool);
  const highRisk = capabilities.filter(capability =>
    capability === 'shell' ||
    capability === 'network' ||
    capability === 'filesystem-write'
  );
  if (!tool.permissions?.requiresConfirmation && highRisk.length === 0) return;

  const request: ToolApprovalRequest = {
    toolName: tool.name,
    capabilities,
    reason: highRisk.length > 0
      ? `工具请求高风险能力：${highRisk.join(', ')}`
      : '工具声明每次调用前都需要确认',
    argsPreview: safePreview(args),
    approvalId: `${toolApprovalScope(tool)}:capability:${highRisk.length > 0
      ? [...highRisk].sort().join(',')
      : 'explicit-confirmation'}`
  };
  if (!context.requestApproval || !await context.requestApproval(request)) {
    throw new Error(`Tool ${tool.name} was not approved`);
  }
}

export async function resolvePathArguments(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<Record<string, unknown>> {
  const names = getPathArgumentNames(tool);
  if (names.length === 0) return { ...args };
  if (!context.workspaceDir) {
    throw new Error(`Tool ${tool.name} uses paths but no workspace is open`);
  }

  const resolvedArgs = { ...args };
  for (const name of names) {
    if (!(name in resolvedArgs) || resolvedArgs[name] === undefined || resolvedArgs[name] === null) {
      // 兼容旧工具：移除全局 chdir 后，未显式传 cwd 的命令仍应默认在工作区执行。
      if (name.toLowerCase() === 'cwd') resolvedArgs[name] = context.workspaceDir;
      continue;
    }
    if (typeof resolvedArgs[name] !== 'string') {
      throw new Error(`Tool ${tool.name} path argument "${name}" must be a string`);
    }

    const inputPath = resolvedArgs[name] as string;
    const resolved = resolveWorkspacePath(context.workspaceDir, inputPath);
    if (!resolved.insideWorkspace) {
      const request: ToolApprovalRequest = {
        toolName: tool.name,
        capabilities: inferCapabilities(tool),
        reason: `工具请求访问工作区外路径：${resolved.path}`,
        argsPreview: safePreview({ [name]: inputPath }),
        approvalId: `${toolApprovalScope(tool)}:outside-workspace:${resolved.path}`
      };
      if (!context.requestApproval || !await context.requestApproval(request)) {
        throw new Error(`Tool ${tool.name} cannot access path outside workspace: ${inputPath}`);
      }
    }
    resolvedArgs[name] = resolved.path;
  }
  return resolvedArgs;
}

function toolApprovalScope(tool: Tool): string {
  return [
    'tool',
    tool.source,
    tool.version || 'unversioned',
    tool.codeHash || 'inline'
  ].join(':');
}

export function resolveWorkspacePath(
  workspaceDir: string,
  inputPath: string
): { path: string; insideWorkspace: boolean } {
  const workspace = realPathForBoundary(path.resolve(workspaceDir));
  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workspaceDir, inputPath);
  const realCandidate = realPathForBoundary(candidate);
  const relative = path.relative(workspace, realCandidate);
  const insideWorkspace = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  return { path: candidate, insideWorkspace };
}

export function createScopedContext(
  tool: Tool,
  context: ToolContext,
  signal: AbortSignal
): ToolContext {
  const envNames = tool.permissions?.env ?? [];
  const scopedEnv: Record<string, string> = {};
  for (const name of envNames) {
    if (Object.prototype.hasOwnProperty.call(context.env, name)) {
      scopedEnv[name] = context.env[name];
    }
  }

  return {
    ...context,
    env: scopedEnv,
    signal,
    resolvePath: (inputPath: string) => {
      const resolved = resolveWorkspacePath(context.workspaceDir, inputPath);
      if (!resolved.insideWorkspace) {
        throw new Error(`Path is outside workspace: ${inputPath}`);
      }
      return resolved.path;
    }
  };
}

function realPathForBoundary(candidate: string): string {
  let current = candidate;
  const suffix: string[] = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return candidate;
    suffix.unshift(path.basename(current));
    current = parent;
  }

  const realExisting = fs.realpathSync.native(current);
  return path.resolve(realExisting, ...suffix);
}

function safePreview(value: unknown, maxChars: number = 500): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'string' && item.length > 200) return `${item.slice(0, 200)}…`;
      return item;
    });
  } catch {
    serialized = String(value);
  }
  return serialized.length > maxChars ? `${serialized.slice(0, maxChars)}…` : serialized;
}
