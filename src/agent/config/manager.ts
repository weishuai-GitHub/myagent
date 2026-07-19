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

  /**
   * @param workspaceDir 工作区根目录；传 undefined 时回退到 VSCode 当前工作区。
   *                     内部会拼接 `.myagent` 子目录，与 home 对称。
   * @param options.homeOnly 若为 true，则完全忽略 workspace（subagent 场景下使用）
   */
  constructor(workspaceDir?: string, options?: { homeOnly?: boolean }) {
    this.homeMyAgentDir = path.join(os.homedir(), '.myagent');
    if (options?.homeOnly) {
      this.workspaceMyAgentDir = null;
    } else {
      const dir = workspaceDir || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
      this.workspaceMyAgentDir = dir ? path.join(dir, '.myagent') : null;
    }
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
   * 更新 workspaceDir（工作区根目录）并重新加载配置。
   * 内部会拼接 `.myagent` 子目录，与构造函数一致。
   */
  reloadBaseDir(workspaceDir?: string): void {
    this.workspaceMyAgentDir = workspaceDir ? path.join(workspaceDir, '.myagent') : null;
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
   * 切换某来源目录下某组件的启用状态。
   * - enable：如果列表中已含 '*'，noop（已全启用）；否则去重 push。
   * - disable：如果列表中含 '*'，抛错（调用方应先用 expandWildcard 展开）；否则 splice 删除。
   */
  setComponentEnabled(source: ComponentSource, category: 'tools' | 'skills' | 'subagents', name: string, enabled: boolean): void {
    const settings = this.getSettingsForSource(source);
    if (!settings) return;

    const key = this.getCategoryKey(category);
    const list: string[] = [...((settings as any)[key] || [])];

    if (enabled) {
      if (list.includes('*')) {
        return; // 已经全启用，noop
      }
      if (!list.includes(name)) {
        list.push(name);
      }
    } else {
      if (list.includes('*')) {
        throw new Error('Cannot disable a single component when wildcard "*" is active; expand the list first');
      }
      const idx = list.indexOf(name);
      if (idx !== -1) list.splice(idx, 1);
    }

    (settings as any)[key] = list;
  }

  /**
   * 将含 '*' 的 enabled 列表展开为显式名字列表。
   * ConfigManager 不感知 registry，调用方传入该 source/category 下的全部组件名。
   */
  expandWildcard(source: ComponentSource, category: 'tools' | 'skills' | 'subagents', allNames: string[]): void {
    const settings = this.getSettingsForSource(source);
    if (!settings) return;
    const key = this.getCategoryKey(category);
    const list: string[] = (settings as any)[key] || [];
    if (!list.includes('*')) return;
    (settings as any)[key] = [...allNames];
  }
}
