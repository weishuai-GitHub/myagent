import * as path from 'path';
import * as fs from 'fs';
import { ComponentLoader } from './loader-types';
import { ComponentSource, Tool, Skill, Subagent } from './types';
import { loadToolsFromDir } from './tools/executor';
import { loadSkillsFromDir } from './skills/loader';
import { loadSubagentsFromDir } from './subagents/loader';

/** 读取 baseDir/AGENT.md 并剥离 YAML front matter。不存在则返回空串。 */
function readAgentPrompt(baseDir: string): string {
  const agentPath = path.join(baseDir, 'AGENT.md');
  if (!fs.existsSync(agentPath)) return '';
  const raw = fs.readFileSync(agentPath, 'utf-8');
  return raw.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/**
 * 文件系统组件加载器：从指定目录加载 tools / skills / subagents 到给定 Map。
 *
 * 委托给现有的 loadToolsFromDir / loadSkillsFromDir / loadSubagentsFromDir，
 * 这些函数在写入 Map 时已经设置了 source 字段。
 * 构造时同步读取 AGENT.md 作为 agentPrompt。
 */
export class FilesystemLoader implements ComponentLoader {
  public readonly name: string;
  public readonly agentPrompt: string;

  constructor(
    private readonly baseDir: string,
    private readonly source: ComponentSource
  ) {
    this.name = `filesystem-${source}`;
    this.agentPrompt = readAgentPrompt(baseDir);
  }

  loadTools(map: Map<string, Tool>): Promise<void> {
    loadToolsFromDir(this.baseDir, this.source, map);
    return Promise.resolve();
  }

  loadSkills(map: Map<string, Skill>): Promise<void> {
    loadSkillsFromDir(this.baseDir, this.source, map);
    return Promise.resolve();
  }

  loadSubagents(map: Map<string, Subagent>): Promise<void> {
    loadSubagentsFromDir(this.baseDir, this.source, map);
    return Promise.resolve();
  }
}
