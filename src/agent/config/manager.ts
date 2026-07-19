import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Settings, ModelConfig } from '../types';
import { ComponentSource } from '../component/types';
import { parseSettings, SettingsValidationError } from './schema';
import { defaultApiKeyReference, SecretStore } from './secret-store';

export class ConfigManager {
  private workspaceSettings: Settings | null = null;
  private homeSettings: Settings | null = null;
  /** 主配置：models/activeModel/maxRounds/env 等来自此，优先级 workspace > home */
  private primarySettings: Settings | null = null;
  private configPath: string = '';
  private workspaceMyAgentDir: string | null = null;
  private homeMyAgentDir: string;
  private importedConfigPath: string | null = null;
  private importedSettings: Settings | null = null;
  private diagnostics: Array<{ filePath: string; fieldPath: string; message: string }> = [];

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
    this.diagnostics = [];

    // 加载两个目录的 settings.json
    if (this.workspaceMyAgentDir) {
      const ws = path.join(this.workspaceMyAgentDir, 'settings.json');
      if (fs.existsSync(ws)) {
        console.log('Loading workspace config from:', ws);
        this.workspaceSettings = this.tryReadSettingsFile(ws);
      }
    }

    const hs = path.join(this.homeMyAgentDir, 'settings.json');
    if (fs.existsSync(hs)) {
      console.log('Loading home config from:', hs);
      this.homeSettings = this.tryReadSettingsFile(hs);
    }

    // 主配置优先级：workspace > home
    this.primarySettings = this.workspaceSettings || this.homeSettings;
    if (this.primarySettings) {
      this.configPath = this.workspaceSettings
        ? path.join(this.workspaceMyAgentDir!, 'settings.json')
        : hs;
    }

    if (this.importedConfigPath) {
      const imported = this.tryReadSettingsFile(this.importedConfigPath);
      if (imported) {
        this.importedSettings = imported;
        this.primarySettings = imported;
        this.configPath = this.importedConfigPath;
      }
    }
  }

  /**
   * 更新 workspaceDir（工作区根目录）并重新加载配置。
   * 内部会拼接 `.myagent` 子目录，与构造函数一致。
   */
  reloadBaseDir(workspaceDir?: string | null): void {
    if (workspaceDir !== undefined) {
      this.workspaceMyAgentDir = workspaceDir ? path.join(workspaceDir, '.myagent') : null;
    }
    this.loadAllSettings();
  }

  async loadSettings(configPath: string): Promise<Settings> {
    this.configPath = configPath;
    const settings = this.readSettingsFile(configPath);

    // 判断导入的配置属于哪个目录，更新对应 settings
    if (this.workspaceMyAgentDir && this.isPathInside(this.workspaceMyAgentDir, configPath)) {
      this.workspaceSettings = settings;
      this.importedConfigPath = null;
      this.importedSettings = null;
    } else if (this.isPathInside(this.homeMyAgentDir, configPath)) {
      this.homeSettings = settings;
      this.importedConfigPath = null;
      this.importedSettings = null;
    } else {
      this.importedConfigPath = configPath;
      this.importedSettings = settings;
    }
    // 无论如何更新主配置
    this.primarySettings = settings;
    return settings;
  }

  getSettings(): Settings | null {
    return this.primarySettings;
  }

  getDiagnostics(): Array<{ filePath: string; fieldPath: string; message: string }> {
    return this.diagnostics.map(diagnostic => ({ ...diagnostic }));
  }

  /** 使用 SecretStorage 引用补齐仅存在于运行时内存中的 apiKey。 */
  async hydrateSecrets(secretStore: SecretStore): Promise<void> {
    const settingsList = [this.homeSettings, this.workspaceSettings, this.importedSettings]
      .filter((settings): settings is Settings => settings !== null);
    for (const settings of settingsList) {
      for (const model of settings.models) {
        if (!model.apiKey && model.apiKeyRef) {
          model.apiKey = await secretStore.get(model.apiKeyRef);
        }
      }
    }
  }

  /**
   * 经用户确认后把旧版明文 apiKey 写入 SecretStorage，并用 apiKeyRef 原子改写配置。
   * 内存中的 apiKey 会保留到下一次 reload，以免中断正在使用的客户端。
   */
  async migrateLegacyApiKeys(
    secretStore: SecretStore,
    confirm: (modelNames: string[]) => Promise<boolean>
  ): Promise<number> {
    const entries = this.settingsEntries();
    const candidates = entries.flatMap(entry => entry.settings.models
      .filter(model => Boolean(model.apiKey) && !model.apiKeyRef && model.auth !== 'codex')
      .map(model => ({ entry, model })));
    if (candidates.length === 0) return 0;
    if (!await confirm(candidates.map(candidate => candidate.model.name))) return 0;

    for (const { entry, model } of candidates) {
      const reference = defaultApiKeyReference(model.name, entry.filePath);
      await secretStore.store(reference, model.apiKey!);
      model.apiKeyRef = reference;
    }
    for (const entry of new Set(candidates.map(candidate => candidate.entry))) {
      this.writeSettingsFile(entry.filePath, entry.settings);
    }
    return candidates.length;
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
    this.persistSourceSettings(source);
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
    this.persistSourceSettings(source);
  }

  setActiveModel(name: string): void {
    if (!this.primarySettings?.models.some(model => model.name === name)) {
      throw new Error(`Unknown model configuration "${name}"`);
    }
    this.primarySettings.activeModel = name;
    if (this.configPath) {
      this.writeSettingsFile(this.configPath, this.primarySettings);
    }
  }

  private readSettingsFile(filePath: string): Settings {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new SettingsValidationError(filePath, '$', `不是有效 JSON：${error.message}`);
      }
      throw error;
    }
    return parseSettings(raw, filePath);
  }

  private tryReadSettingsFile(filePath: string): Settings | null {
    try {
      const settings = this.readSettingsFile(filePath);
      if (!settings.models.some(model => model.name === settings.activeModel)) {
        this.diagnostics.push({
          filePath,
          fieldPath: 'activeModel',
          message: `${filePath}: activeModel 引用的模型 "${settings.activeModel}" 不存在，当前临时回退到 models[0]`
        });
      }
      return settings;
    } catch (error) {
      const validationError = error instanceof SettingsValidationError
        ? error
        : new SettingsValidationError(
          filePath,
          '$',
          error instanceof Error ? error.message : String(error)
        );
      this.diagnostics.push({
        filePath: validationError.filePath,
        fieldPath: validationError.fieldPath,
        message: validationError.message
      });
      console.error('MyAgent settings validation failed:', validationError.message);
      return null;
    }
  }

  private persistSourceSettings(source: ComponentSource): void {
    const settings = this.getSettingsForSource(source);
    if (!settings) return;
    const filePath = source === 'workspace'
      ? (this.workspaceMyAgentDir ? path.join(this.workspaceMyAgentDir, 'settings.json') : '')
      : path.join(this.homeMyAgentDir, 'settings.json');
    if (filePath) {
      this.writeSettingsFile(filePath, settings);
    }
  }

  private settingsEntries(): Array<{ settings: Settings; filePath: string }> {
    const entries: Array<{ settings: Settings; filePath: string }> = [];
    if (this.homeSettings) {
      entries.push({
        settings: this.homeSettings,
        filePath: path.join(this.homeMyAgentDir, 'settings.json')
      });
    }
    if (this.workspaceSettings && this.workspaceMyAgentDir) {
      entries.push({
        settings: this.workspaceSettings,
        filePath: path.join(this.workspaceMyAgentDir, 'settings.json')
      });
    }
    if (this.importedSettings && this.importedConfigPath) {
      entries.push({ settings: this.importedSettings, filePath: this.importedConfigPath });
    }
    return entries;
  }

  private writeSettingsFile(filePath: string, settings: Settings): void {
    const serialized = {
      ...settings,
      models: settings.models.map(model => {
        const copy = { ...model };
        // 一旦存在 SecretStorage 引用，绝不把运行时解出的密钥写回磁盘。
        if (copy.apiKeyRef) delete copy.apiKey;
        return copy;
      })
    };
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(serialized, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600
      });
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
      throw new Error(
        `无法安全写入配置 ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private isPathInside(parentDir: string, candidatePath: string): boolean {
    const relative = path.relative(path.resolve(parentDir), path.resolve(candidatePath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }
}
