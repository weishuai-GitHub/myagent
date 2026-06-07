import { ComponentLoader } from './loader-types';
import { Tool, Skill, Subagent } from './types';

export interface ComponentFilter {
  tools?: string[];
  skills?: string[];
  subagents?: string[];
}

/**
 * 组件注册表：聚合多个 ComponentLoader 的加载结果，提供查询与派生过滤能力。
 *
 * - load(loaders)：按顺序应用 loaders，后者覆盖前者（基于 name 的 Map.set 语义）。
 * - filterHomeOnly()：派生出仅包含 source==='home' 项的新注册表。
 * - filter(opts)：按白名单过滤指定分类；省略的分类整体保留。
 */
export class ComponentRegistry {
  private constructor(
    private readonly toolsMap: Map<string, Tool>,
    private readonly skillsMap: Map<string, Skill>,
    private readonly subagentsMap: Map<string, Subagent>
  ) {}

  static async load(loaders: ComponentLoader[]): Promise<ComponentRegistry> {
    const tools = new Map<string, Tool>();
    const skills = new Map<string, Skill>();
    const subagents = new Map<string, Subagent>();
    for (const loader of loaders) {
      if (loader.loadTools) await loader.loadTools(tools);
      if (loader.loadSkills) await loader.loadSkills(skills);
      if (loader.loadSubagents) await loader.loadSubagents(subagents);
    }
    return new ComponentRegistry(tools, skills, subagents);
  }

  filterHomeOnly(): ComponentRegistry {
    const filterHome = <T extends { source: string }>(src: Map<string, T>): Map<string, T> => {
      const out = new Map<string, T>();
      for (const [k, v] of src) {
        if (v.source === 'home') out.set(k, v);
      }
      return out;
    };
    return new ComponentRegistry(
      filterHome(this.toolsMap),
      filterHome(this.skillsMap),
      filterHome(this.subagentsMap)
    );
  }

  filter(opts: ComponentFilter): ComponentRegistry {
    const pick = <T>(src: Map<string, T>, whitelist: string[] | undefined): Map<string, T> => {
      if (whitelist === undefined) return new Map(src);
      const allow = new Set(whitelist);
      const out = new Map<string, T>();
      for (const [k, v] of src) {
        if (allow.has(k)) out.set(k, v);
      }
      return out;
    };
    return new ComponentRegistry(
      pick(this.toolsMap, opts.tools),
      pick(this.skillsMap, opts.skills),
      pick(this.subagentsMap, opts.subagents)
    );
  }

  findTool(name: string): Tool | undefined {
    return this.toolsMap.get(name);
  }
  findSkill(name: string): Skill | undefined {
    return this.skillsMap.get(name);
  }
  findSubagent(name: string): Subagent | undefined {
    return this.subagentsMap.get(name);
  }

  listTools(): Tool[] {
    return Array.from(this.toolsMap.values());
  }
  listSkills(): Skill[] {
    return Array.from(this.skillsMap.values());
  }
  listSubagents(): Subagent[] {
    return Array.from(this.subagentsMap.values());
  }
}
