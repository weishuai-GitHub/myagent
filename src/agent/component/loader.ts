import * as path from 'path';
import * as fs from 'fs';
import { AgentConfig, Tool, Skill, Subagent, ComponentSource, DiscoveredComponents } from './types';
import { loadToolsFromDir } from './tools/executor';
import { loadSkillsFromDir } from './skills/loader';
import { loadSubagentsFromDir } from './subagents/runner';

export class AgentLoader {
  private workspaceDir: string | null;
  private homeDir: string;

  /**
   * @param workspaceDir workspace 下的 .myagent 目录（如 ./.myagent），可为 null
   * @param homeDir home 下的 .myagent 目录（如 ~/.myagent）
   */
  constructor(workspaceDir: string | null, homeDir: string) {
    this.workspaceDir = workspaceDir;
    this.homeDir = homeDir;
  }

  load(): AgentConfig {
    return {
      agentPrompt: this.getAgentPrompt(),
      tools: this.loadTools(),
      skills: this.loadSkills(),
      subagents: this.loadSubagents()
    };
  }

  getBaseDir(): string {
    return this.workspaceDir || this.homeDir;
  }

  setBaseDir(baseDir: string) {
    this.workspaceDir = baseDir;
  }

  getAgentPrompt(): string {
    const workspacePrompt = this.workspaceDir
      ? this.readAgentPrompt(this.workspaceDir)
      : '';
    if (workspacePrompt) return workspacePrompt;
    return this.readAgentPrompt(this.homeDir);
  }

  private readAgentPrompt(baseDir: string): string {
    const agentPath = path.join(baseDir, 'AGENT.md');
    if (fs.existsSync(agentPath)) {
      let prompt = fs.readFileSync(agentPath, 'utf-8');
      prompt = prompt.replace(/^---\n[\s\S]*?\n---\n/, '');
      return prompt;
    }
    return '';
  }

  loadTools(): Tool[] {
    const toolsMap = new Map<string, Tool>();
    loadToolsFromDir(this.homeDir, 'home', toolsMap);
    if (this.workspaceDir) {
      loadToolsFromDir(this.workspaceDir, 'workspace', toolsMap);
    }
    return Array.from(toolsMap.values());
  }

  loadSkills(): Skill[] {
    const skillsMap = new Map<string, Skill>();
    loadSkillsFromDir(this.homeDir, 'home', skillsMap);
    if (this.workspaceDir) {
      loadSkillsFromDir(this.workspaceDir, 'workspace', skillsMap);
    }
    return Array.from(skillsMap.values());
  }

  loadSubagents(): Subagent[] {
    const subagentsMap = new Map<string, Subagent>();
    loadSubagentsFromDir(this.homeDir, 'home', subagentsMap);
    if (this.workspaceDir) {
      loadSubagentsFromDir(this.workspaceDir, 'workspace', subagentsMap);
    }
    return Array.from(subagentsMap.values());
  }

  /**
   * 发现所有组件，返回轻量信息（不含 execute 函数和大段 content）。
   * enabled 字段设为 false，由调用方（AgentRuntime）根据 ConfigManager 填充。
   */
  discoverComponents(): DiscoveredComponents {
    const tools = this.loadTools();
    const skills = this.loadSkills();
    const subagents = this.loadSubagents();

    return {
      tools: tools.map(t => ({ name: t.name, description: t.description, source: t.source, enabled: false })),
      skills: skills.map(s => ({ name: s.name, description: s.description, source: s.source, enabled: false })),
      subagents: subagents.map(s => ({ name: s.name, description: s.description, source: s.source, enabled: false }))
    };
  }
}
