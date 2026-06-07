import { ComponentLoader } from './loader-types';
import { ComponentSource, Tool, Skill, Subagent } from './types';
import { loadToolsFromDir } from './tools/executor';
import { loadSkillsFromDir } from './skills/loader';
import { loadSubagentsFromDir } from './subagents/runner';

/**
 * 文件系统组件加载器：从指定目录加载 tools / skills / subagents 到给定 Map。
 *
 * 委托给现有的 loadToolsFromDir / loadSkillsFromDir / loadSubagentsFromDir，
 * 这些函数在写入 Map 时已经设置了 source 字段。
 */
export class FilesystemLoader implements ComponentLoader {
  public readonly name: string;

  constructor(
    private readonly baseDir: string,
    private readonly source: ComponentSource
  ) {
    this.name = `filesystem-${source}`;
  }

  async loadTools(map: Map<string, Tool>): Promise<void> {
    loadToolsFromDir(this.baseDir, this.source, map);
  }

  async loadSkills(map: Map<string, Skill>): Promise<void> {
    loadSkillsFromDir(this.baseDir, this.source, map);
  }

  async loadSubagents(map: Map<string, Subagent>): Promise<void> {
    loadSubagentsFromDir(this.baseDir, this.source, map);
  }
}
