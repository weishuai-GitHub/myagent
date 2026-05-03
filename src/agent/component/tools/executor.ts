import * as path from 'path';
import * as fs from 'fs';
import { Tool, ToolContext } from './types';
import { ComponentSource } from '../types';

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
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      const indexPath = path.join(toolPath, 'index.js');
      if (toolsMap.has(metadata.name)) {
        console.log(`Tool "${metadata.name}" from home overridden by workspace`);
      }
      toolsMap.set(metadata.name, {
        name: metadata.name,
        description: metadata.description,
        parameters: metadata.parameters,
        source,
        execute: createToolExecutor(indexPath, metadata.name)
      });
    } catch (e) {
      console.error(`Failed to load tool ${dir} from ${source}:`, e);
    }
  }
}

/**
 * 创建工具执行函数
 */
function createToolExecutor(filePath: string, name: string): (args: any, context: ToolContext) => Promise<any> {
  return async (args: any, context: ToolContext) => {
    const module = require(filePath);
    const executor = module.execute || module.default?.execute;
    if (!executor) {
      throw new Error(`Tool ${name} does not have an execute function`);
    }

    // 执行前切换到工作区目录，执行后恢复
    const prevDir = process.cwd();
    try {
      if (context.workspaceDir) {
        process.chdir(context.workspaceDir);
      }
      return await executor(args, context);
    } finally {
      process.chdir(prevDir);
    }
  };
}

/**
 * 执行指定工具
 */
export async function executeTool(tools: Tool[], toolName: string, args: any, context: ToolContext): Promise<any> {
  const tool = tools.find(t => t.name === toolName);
  if (!tool) {
    throw new Error(`Tool ${toolName} not found`);
  }
  return tool.execute(args, context);
}
