// 组件来源
export type ComponentSource = 'workspace' | 'home';

// 以下类型从各子模块 re-export，保持向后兼容
export type { Tool, ToolMetadata, ToolContext, ToolResult } from './tools/types';
export type { Skill } from './skills/types';
export type { Subagent } from './subagents/types';

// Agent
import { Tool } from './tools/types';
import { Skill } from './skills/types';
import { Subagent } from './subagents/types';

export interface AgentConfig {
  agentPrompt: string;
  tools: Tool[];
  skills: Skill[];
  subagents: Subagent[];
}

// 前端轻量组件类型（不含 execute 函数和大段 content）
export interface DiscoveredComponent {
  name: string;
  description: string;
  source: ComponentSource;
  enabled: boolean;
}

export interface DiscoveredComponents {
  tools: DiscoveredComponent[];
  skills: DiscoveredComponent[];
  subagents: DiscoveredComponent[];
}

// 组件启用状态
export interface ComponentState {
  tools: string[];
  skills: string[];
  subagents: string[];
}
