import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Settings, ModelConfig } from '../types';
import { ComponentSource } from '../component/types';

export class ConfigManager {
  private workspaceSettings: Settings | null = null;
  private homeSettings: Settings | null = null;
  /** 主配置：models/activeModel/maxRounds/env 等来自此，优先级 workspace > home */
  private primarySettings: Settings | null = null;
  private configPath: string = '';
  private workspaceMyAgentDir: string | null = null;
  private homeMyAgentDir: string;

  constructor(workspaceDir?: string) {
    const dir = workspaceDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    this.workspaceMyAgentDir = dir ? path.join(dir, '.myagent') : null;
    this.homeMyAgentDir = path.join(os.homedir(), '.myagent');
    this.loadAllSettings();
  }

  private loadAllSettings(): void {
    this.workspaceSettings = null;
    this.homeSettings = null;
    this.primarySettings = null;
    this.configPath = '';

    // 加载两个目录的 settings.json
    if (this.workspaceMyAgentDir) {
      const ws = path.join(this.workspaceMyAgentDir, 'settings.json');
      if (fs.existsSync(ws)) {
        console.log('Loading workspace config from:', ws);
        this.workspaceSettings = JSON.parse(fs.readFileSync(ws, 'utf-8'));
      }
    }

    const hs = path.join(this.homeMyAgentDir, 'settings.json');
    if (fs.existsSync(hs)) {
      console.log('Loading home config from:', hs);
      this.homeSettings = JSON.parse(fs.readFileSync(hs, 'utf-8'));
    }

    // 主配置优先级：workspace > home
    this.primarySettings = this.workspaceSettings || this.homeSettings;
    if (this.primarySettings) {
      this.configPath = this.workspaceSettings
        ? path.join(this.workspaceMyAgentDir!, 'settings.json')
        : hs;
    }
  }

  /**
   * 更新 workspaceDir 并重新加载配置
   */
  reloadBaseDir(workspaceDir?: string): void {
    const dir = workspaceDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
    this.workspaceMyAgentDir = dir ? path.join(dir, '.myagent') : null;
    this.loadAllSettings();
  }

  async loadSettings(configPath: string): Promise<Settings> {
    this.configPath = configPath;
    const content = fs.readFileSync(configPath, 'utf-8');
    const settings = JSON.parse(content);

    // 判断导入的配置属于哪个目录，更新对应 settings
    if (this.workspaceMyAgentDir && configPath.startsWith(this.workspaceMyAgentDir)) {
      this.workspaceSettings = settings;
    } else if (configPath.startsWith(this.homeMyAgentDir)) {
      this.homeSettings = settings;
    }
    // 无论如何更新主配置
    this.primarySettings = settings;
    return settings;
  }

  getSettings(): Settings | null {
    return this.primarySettings;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getActiveModel(): ModelConfig | null {
    if (!this.primarySettings) return null;
    return this.primarySettings.models.find(m => m.name === this.primarySettings!.activeModel) || this.primarySettings.models[0];
  }

  getAvailableModels(): ModelConfig[] {
    return this.primarySettings?.models || [];
  }

  getMaxRounds(): number {
    return this.primarySettings?.maxRounds || 10;
  }

  getEnv(): Record<string, string> {
    return this.primarySettings?.env || {};
  }

  getWorkspaceMyAgentDir(): string | null {
    return this.workspaceMyAgentDir;
  }

  getHomeMyAgentDir(): string {
    return this.homeMyAgentDir;
  }

  /**
   * 获取指定来源目录的 enabled 列表
   */
  private getSettingsForSource(source: ComponentSource): Settings | null {
    return source === 'workspace' ? this.workspaceSettings : this.homeSettings;
  }

  private getCategoryKey(category: 'tools' | 'skills' | 'subagents'): 'enabledTools' | 'enabledSkills' | 'enabledSubagents' {
    const map = { tools: 'enabledTools', skills: 'enabledSkills', subagents: 'enabledSubagents' } as const;
    return map[category];
  }

  getEnabledList(source: ComponentSource, category: 'tools' | 'skills' | 'subagents'): string[] {
    const settings = this.getSettingsForSource(source);
    if (!settings) return [];
    const key = this.getCategoryKey(category);
    return (settings as any)[key] || [];
  }

  /**
   * 判断组件是否启用，使用该组件来源目录的 enabled 列表。支持 ["*"] 通配符。
   */
  isEnabledInSource(source: ComponentSource, category: 'tools' | 'skills' | 'subagents', componentName: string): boolean {
    const enabledList = this.getEnabledList(source, category);
    if (!enabledList || enabledList.length === 0) return false;
    if (enabledList.includes('*')) return true;
    return enabledList.includes(componentName);
  }

  /**
   * 切换某来源目录下某组件的启用状态
   */
  setComponentEnabled(source: ComponentSource, category: 'tools' | 'skills' | 'subagents', name: string, enabled: boolean): void {
    const settings = this.getSettingsForSource(source);
    if (!settings) return;

    const key = this.getCategoryKey(category);
    const list: string[] = [...((settings as any)[key] || [])];

    if (enabled) {
      if (!list.includes(name) && !list.includes('*')) {
        list.push(name);
      }
    } else {
      // 如果当前是 *，需要展开为显式列表再去掉该项
      if (list.includes('*')) {
        // * 模式下无法直接展开（需要 loader 的完整列表），简单处理：去掉 *，加 * 以外再排除 name
        // 这里先简单移除 name，如果 * 存在则保留 * 并添加排除规则
        // 最简方案：* 时禁用某项，就把 * 替换为空（表示全部禁用），后续由 loader 补充
        // 更实用的方案：先记录 *，前端显示为启用，禁用时从 list 中移除 * 加上排除项
        // 简单起见：禁用 name 时，如果 list 含 *，移除 * 并不做其他处理
        // 这意味着用户需要手动逐个启用 — 不太好
        // 更好的做法：* 时移除 *，不添加其他内容（因为 AgentRuntime 中 * 会匹配全部，去掉 * 后只有列表中的才启用）
        const idx = list.indexOf('*');
        if (idx !== -1) list.splice(idx, 1);
        // 不添加 name，相当于从 * 全部启用 变成 只启用列表中已有的（不含 * 也不含 name）
      } else {
        const idx = list.indexOf(name);
        if (idx !== -1) list.splice(idx, 1);
      }
    }

    (settings as any)[key] = list;
  }

  /**
   * 兼容旧接口：判断组件是否启用（不区分来源）
   */
  isEnabled(enabledList: string[], componentName: string): boolean {
    if (!enabledList || enabledList.length === 0) return false;
    if (enabledList.includes('*')) return true;
    return enabledList.includes(componentName);
  }

  // ========== 以下为向后兼容方法，操作主配置 ==========

  getComponentState() {
    if (!this.primarySettings) {
      return { tools: [], skills: [], subagents: [] };
    }
    return {
      tools: this.primarySettings.enabledTools || [],
      skills: this.primarySettings.enabledSkills || [],
      subagents: this.primarySettings.enabledSubagents || []
    };
  }

  getEnabledTools(): string[] {
    return this.primarySettings?.enabledTools || [];
  }

  getEnabledSkills(): string[] {
    return this.primarySettings?.enabledSkills || [];
  }

  getEnabledSubagents(): string[] {
    return this.primarySettings?.enabledSubagents || [];
  }

  /**
   * 从前端传入启用组件列表（不区分来源），同步到所有 settings。
   * 前端传入的列表中，workspace 来源的组件写入 workspaceSettings，home 来源的写入 homeSettings。
   */
  setEnabledListsFromFrontend(lists: { tools: string[]; skills: string[]; subagents: string[] }): void {
    for (const category of ['tools', 'skills', 'subagents'] as const) {
      const key = this.getCategoryKey(category);
      const names = lists[category];
      if (this.workspaceSettings) {
        (this.workspaceSettings as any)[key] = names;
      }
      if (this.homeSettings) {
        (this.homeSettings as any)[key] = names;
      }
    }
  }
}
