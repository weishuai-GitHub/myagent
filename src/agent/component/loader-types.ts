import { Tool, Skill, Subagent } from './types';

export interface ComponentLoader {
  readonly name: string;
  /** 可选的 AGENT.md 系统提示词；多个 loader 中后者非空值覆盖前者 */
  readonly agentPrompt?: string;
  loadTools?(map: Map<string, Tool>): Promise<void>;
  loadSkills?(map: Map<string, Skill>): Promise<void>;
  loadSubagents?(map: Map<string, Subagent>): Promise<void>;
}
