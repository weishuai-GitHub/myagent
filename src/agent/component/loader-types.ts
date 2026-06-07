import { Tool, Skill, Subagent } from './types';

export interface ComponentLoader {
  readonly name: string;
  loadTools?(map: Map<string, Tool>): Promise<void>;
  loadSkills?(map: Map<string, Skill>): Promise<void>;
  loadSubagents?(map: Map<string, Subagent>): Promise<void>;
}
