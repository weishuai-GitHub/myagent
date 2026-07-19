import * as path from 'path';
import * as fs from 'fs';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import childProcess = require('child_process');
import { Tool, ToolContext, ToolMetadata, ToolResult } from './types';
import { ComponentSource } from '../types';
import { validateToolArguments } from './validation';
import {
  authorizeToolCall,
  createScopedContext,
  getPathArgumentNames,
  inferCapabilities,
  resolvePathArguments,
  resolveWorkspacePath
} from './security';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 50_000;
const runtimeRequire = createRequire(__filename);

/**
 * 从指定目录加载所有工具
 */
export function loadToolsFromDir(baseDir: string, source: ComponentSource, toolsMap: Map<string, Tool>): void {
  const toolsDir = path.join(baseDir, 'tools');
  if (!fs.existsSync(toolsDir)) return;

  const dirs = fs.readdirSync(toolsDir);
  for (const dir of dirs) {
    const toolPath = path.join(toolsDir, dir);
    if (!fs.statSync(toolPath).isDirectory()) continue;

      const metadataPath = path.join(toolPath, 'metadata.json');
    if (!fs.existsSync(metadataPath)) continue;

    try {
      const metadataContent = fs.readFileSync(metadataPath, 'utf-8');
      const metadata = parseToolMetadata(metadataContent, dir);
      if (metadata.enabled === false) continue;
      const indexPath = path.join(toolPath, 'index.js');
      if (!fs.existsSync(indexPath)) {
        throw new Error(`missing index.js`);
      }
      validateDependencies(metadata.dependencies ?? [], toolPath);
      if (!metadata.permissions) {
        console.warn(
          `Tool "${metadata.name}" 未声明 permissions，当前使用兼容推断模式；建议显式声明 capabilities/pathArguments/env`
        );
      }
      if (toolsMap.has(metadata.name)) {
        const previous = toolsMap.get(metadata.name)!;
        console.log(`Tool "${metadata.name}" from ${previous.source} overridden by ${source}`);
      }
      toolsMap.set(metadata.name, {
        name: metadata.name,
        description: metadata.description,
        version: metadata.version,
        parameters: metadata.parameters,
        dependencies: metadata.dependencies ?? [],
        permissions: metadata.permissions ?? {},
        timeoutMs: metadata.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputChars: metadata.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
        source,
        entryPath: indexPath,
        codeHash: createHash('sha256')
          .update(metadataContent)
          .update('\0')
          .update(fs.readFileSync(indexPath))
          .digest('hex')
      });
    } catch (e) {
      console.error(`Failed to load tool ${dir} from ${source}:`, e);
    }
  }
}

/**
 * 执行指定工具
 */
export async function executeTool(
  tools: Tool[],
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<string> {
  const tool = tools.find(t => t.name === toolName);
  if (!tool) {
    throw new Error(`Tool ${toolName} not found`);
  }

  const validation = validateToolArguments(tool.parameters, args);
  if (!validation.valid) {
    throw new Error(`Invalid arguments for tool ${toolName}: ${validation.errors.join('; ')}`);
  }

  await authorizeToolCall(tool, args, context);
  const resolvedArgs = await resolvePathArguments(tool, args, context);
  if (context.signal?.aborted) {
    throw new Error(`Tool ${toolName} was cancelled`);
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(context.signal?.reason);
  context.signal?.addEventListener('abort', onParentAbort, { once: true });
  const scopedContext = createScopedContext(tool, context, controller.signal);

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutError = new Error(
          `Tool ${toolName} timed out after ${tool.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        );
        reject(timeoutError);
        controller.abort(timeoutError);
      }, tool.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    const execution = tool.entryPath
      ? executeInToolHost(tool, resolvedArgs, scopedContext)
      : executeInlineTool(tool, resolvedArgs, scopedContext);
    const rawResult = await Promise.race([
      execution,
      timeout
    ]);
    return serializeToolResult(tool, rawResult);
  } finally {
    if (timer) clearTimeout(timer);
    context.signal?.removeEventListener('abort', onParentAbort);
  }
}

async function executeInlineTool(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  if (!tool.execute) {
    throw new Error(`Tool ${tool.name} does not have an executable entry`);
  }
  return tool.execute(args, context);
}

function executeInToolHost(
  tool: Tool,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const hostPath = path.join(__dirname, 'tool-host.js');
    const childEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      ...context.env
    };
    const child = childProcess.fork(hostPath, [], {
      cwd: context.workspaceDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json'
    });
    let settled = false;
    let diagnostics = '';
    const maxDiagnostics = 16_000;

    const settle = (error?: Error, data?: unknown) => {
      if (settled) return;
      settled = true;
      context.signal?.removeEventListener('abort', onAbort);
      if (child.connected) child.disconnect();
      if (!child.killed) child.kill('SIGKILL');
      error ? reject(error) : resolve(data);
    };
    const appendDiagnostic = (chunk: unknown) => {
      diagnostics = `${diagnostics}${String(chunk)}`.slice(-maxDiagnostics);
    };
    child.stdout?.on('data', appendDiagnostic);
    child.stderr?.on('data', appendDiagnostic);
    child.on('message', (message: any) => {
      if (message?.type === 'result') {
        settle(undefined, message.data);
      } else if (message?.type === 'error') {
        settle(new Error(`Tool ${tool.name} failed in isolated host: ${message.error}`));
      }
    });
    child.on('error', error => settle(new Error(
      `Unable to start isolated host for tool ${tool.name}: ${error.message}`
    )));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const suffix = diagnostics.trim() ? `: ${diagnostics.trim()}` : '';
      settle(new Error(
        `Tool ${tool.name} host exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'none'})${suffix}`
      ));
    });
    const onAbort = () => settle(new Error(
      `Tool ${tool.name} was cancelled${context.signal?.reason ? `: ${String(context.signal.reason)}` : ''}`
    ));
    context.signal?.addEventListener('abort', onAbort, { once: true });
    if (context.signal?.aborted) {
      onAbort();
      return;
    }

    child.send({
      type: 'execute',
      entryPath: tool.entryPath,
      args,
      context: {
        env: context.env,
        workspaceDir: context.workspaceDir,
        availableComponents: context.availableComponents
      },
      capabilities: inferCapabilitiesForHost(tool),
      allowedExternalPaths: getPathArgumentNames(tool)
        .map(name => args[name])
        .filter((value): value is string => typeof value === 'string')
        .filter(value => !resolveWorkspacePath(context.workspaceDir, value).insideWorkspace),
      maxResultChars: Math.max(
        1_024,
        Math.min((tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS) * 2, 1_000_000)
      )
    }, error => {
      if (error) settle(new Error(`Unable to send tool ${tool.name} request: ${error.message}`));
    });
  });
}

function inferCapabilitiesForHost(tool: Tool): string[] {
  return inferCapabilities(tool);
}

function parseToolMetadata(content: string, dirName: string): ToolMetadata {
  const metadata = JSON.parse(content) as Partial<ToolMetadata>;
  if (!metadata || typeof metadata !== 'object') {
    throw new Error('metadata.json must contain an object');
  }
  if (typeof metadata.name !== 'string' || metadata.name.trim() === '') {
    throw new Error('metadata.name must be a non-empty string');
  }
  if (typeof metadata.description !== 'string' || metadata.description.trim() === '') {
    throw new Error('metadata.description must be a non-empty string');
  }
  if (!metadata.parameters || typeof metadata.parameters !== 'object' || Array.isArray(metadata.parameters)) {
    throw new Error('metadata.parameters must be a JSON Schema object');
  }
  if (metadata.timeoutMs !== undefined && (!Number.isFinite(metadata.timeoutMs) || metadata.timeoutMs <= 0)) {
    throw new Error('metadata.timeoutMs must be a positive number');
  }
  if (
    metadata.maxOutputChars !== undefined &&
    (!Number.isFinite(metadata.maxOutputChars) || metadata.maxOutputChars < 256)
  ) {
    throw new Error('metadata.maxOutputChars must be at least 256');
  }
  if (metadata.dependencies !== undefined && !Array.isArray(metadata.dependencies)) {
    throw new Error('metadata.dependencies must be an array');
  }
  if (metadata.permissions?.env && !Array.isArray(metadata.permissions.env)) {
    throw new Error('metadata.permissions.env must be an array');
  }
  if (metadata.permissions?.pathArguments && !Array.isArray(metadata.permissions.pathArguments)) {
    throw new Error('metadata.permissions.pathArguments must be an array');
  }
  const allowedCapabilities = new Set(['filesystem-read', 'filesystem-write', 'shell', 'network']);
  if (
    metadata.permissions?.capabilities &&
    (
      !Array.isArray(metadata.permissions.capabilities) ||
      metadata.permissions.capabilities.some(capability => !allowedCapabilities.has(capability))
    )
  ) {
    throw new Error('metadata.permissions.capabilities contains an unsupported capability');
  }
  if (metadata.name !== dirName) {
    console.warn(`Tool directory "${dirName}" declares name "${metadata.name}"`);
  }
  return metadata as ToolMetadata;
}

function validateDependencies(dependencies: string[], toolPath: string): void {
  for (const dependency of dependencies) {
    if (typeof dependency !== 'string' || dependency.trim() === '') {
      throw new Error('metadata.dependencies entries must be non-empty strings');
    }
    try {
      runtimeRequire.resolve(dependency, { paths: [toolPath] });
    } catch {
      throw new Error(`missing dependency "${dependency}"`);
    }
  }
}

function serializeToolResult(tool: Tool, data: unknown): string {
  const result: ToolResult = {
    ok: true,
    data,
    meta: { tool: tool.name }
  };
  let serialized = safeStringify(result);
  const maxOutputChars = tool.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  if (serialized.length <= maxOutputChars) return serialized;

  const previewLength = Math.max(0, maxOutputChars - 300);
  const truncated: ToolResult = {
    ok: true,
    data: safeStringify(data).slice(0, previewLength),
    meta: {
      tool: tool.name,
      truncated: true,
      originalChars: serialized.length
    }
  };
  serialized = safeStringify(truncated);
  if (serialized.length <= maxOutputChars) return serialized;

  // 极短上限或超长工具名也必须返回合法 JSON，而不是截断 JSON 文本。
  return safeStringify({
    ok: true,
    data: '[Tool output omitted because it exceeds the configured limit]',
    meta: { truncated: true, originalChars: serialized.length }
  });
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
  } catch {
    return JSON.stringify(String(value));
  }
}
