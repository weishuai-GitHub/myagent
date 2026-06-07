import { ConfigManager } from './config/manager';
import { ComponentRegistry } from './component/registry';
import { ComponentLoader } from './component/loader-types';
import { FilesystemLoader } from './component/filesystem-loader';
import { LLMClient } from './llm';
import { createLLMClient } from './llm/factory';
import { Session, SessionOptions } from './session';
import { Subagent, ComponentSource, DiscoveredComponents } from './component/types';
import { ModelConfig } from './types';

/** subagent 嵌套层数上限，防止 LLM 互相递归调用造成栈/费用爆炸 */
const MAX_SUBAGENT_DEPTH = 3;

export interface RuntimeOptions {
  workspaceDir?: string;
  extraLoaders?: ComponentLoader[];
  /** 跳过默认的 home + workspace FilesystemLoader（测试或纯 extraLoaders 场景） */
  skipDefaultLoaders?: boolean;
}

/**
 * 新 AgentRuntime：负责持有 config / registry / client，并提供 createSession 与 spawnSubagent。
 *
 * - create(opts)：从配置和加载器构建初始 registry 与 LLMClient
 * - createSession(opts)：派生一个 Session，会按 enabled 列表与可选 SessionOptions 白名单过滤 registry
 * - spawnSubagent(sub)：派生子 runtime（depth+1，registry 限定为 home only），不做磁盘 I/O
 * - reload(workspaceDir)：刷新配置 + 重新加载组件 + 重建 client
 */
export class AgentRuntime {
  private constructor(
    public readonly config: ConfigManager,
    public registry: ComponentRegistry,
    public client: LLMClient,
    public depth: number,
    private readonly _workspaceDir?: string
  ) {}

  static async create(opts: RuntimeOptions = {}): Promise<AgentRuntime> {
    const cfg = new ConfigManager(opts.workspaceDir);

    const loaders: ComponentLoader[] = [];
    if (!opts.skipDefaultLoaders) {
      const home = cfg.getHomeMyAgentDir();
      const ws = cfg.getWorkspaceMyAgentDir();
      loaders.push(new FilesystemLoader(home, 'home'));
      if (ws) loaders.push(new FilesystemLoader(ws, 'workspace'));
    }
    if (opts.extraLoaders && opts.extraLoaders.length > 0) {
      loaders.push(...opts.extraLoaders);
    }

    const registry = await ComponentRegistry.load(loaders);

    const model = cfg.getActiveModel();
    if (!model) {
      throw new Error('No active model configured');
    }
    const client = createLLMClient(model);

    return new AgentRuntime(cfg, registry, client, 0, opts.workspaceDir);
  }

  createSession(opts: SessionOptions = {}): Session {
    // 先按 settings.json 中各 source 的 enabled 列表过滤
    let reg = this.registry.filter({
      tools: this.enabledNames('tools'),
      skills: this.enabledNames('skills'),
      subagents: this.enabledNames('subagents')
    });

    // 如果调用方再传白名单（subagent 用），二次过滤
    if (opts.enabledTools || opts.enabledSkills || opts.enabledSubagents) {
      reg = reg.filter({
        tools: opts.enabledTools,
        skills: opts.enabledSkills,
        subagents: opts.enabledSubagents
      });
    }

    return new Session(this, reg, opts);
  }

  /** 返回某分类下当前 settings 启用的组件名列表（按 source 判定） */
  private enabledNames(category: 'tools' | 'skills' | 'subagents'): string[] {
    const list =
      category === 'tools' ? this.registry.listTools() :
      category === 'skills' ? this.registry.listSkills() :
      this.registry.listSubagents();
    return list
      .filter(c => this.config.isEnabledInSource(c.source, category, c.name))
      .map(c => c.name);
  }

  spawnSubagent(_sub: Subagent): AgentRuntime {
    if (this.depth + 1 > MAX_SUBAGENT_DEPTH) {
      throw new Error(`Subagent recursion depth exceeded (max=${MAX_SUBAGENT_DEPTH})`);
    }
    const childRegistry = this.registry.filterHomeOnly();
    return new AgentRuntime(this.config, childRegistry, this.client, this.depth + 1, this._workspaceDir);
  }

  async reload(workspaceDir?: string): Promise<void> {
    this.config.reloadBaseDir(workspaceDir);
    const home = this.config.getHomeMyAgentDir();
    const ws = this.config.getWorkspaceMyAgentDir();
    const loaders: ComponentLoader[] = [new FilesystemLoader(home, 'home')];
    if (ws) loaders.push(new FilesystemLoader(ws, 'workspace'));
    this.registry = await ComponentRegistry.load(loaders);

    const model = this.config.getActiveModel();
    if (!model) throw new Error('No active model configured');
    this.client = createLLMClient(model);
  }

  switchModel(name: string): void {
    this.client.switchModel(name);
  }

  /**
   * 切换某来源目录下某组件启用状态。
   * 若当前 enabled 列表含 '*' 且本次要 disable 单项，先把 '*' 展开成完整名字列表，再 disable。
   */
  toggleComponent(
    source: ComponentSource,
    category: 'tools' | 'skills' | 'subagents',
    name: string,
    enabled: boolean
  ): void {
    if (!enabled) {
      const list = this.config.getEnabledList(source, category);
      if (list.includes('*')) {
        const all = (
          category === 'tools' ? this.registry.listTools() :
          category === 'skills' ? this.registry.listSkills() :
          this.registry.listSubagents()
        ).filter(c => c.source === source).map(c => c.name);
        this.config.expandWildcard(source, category, all);
      }
    }
    this.config.setComponentEnabled(source, category, name, enabled);
  }

  getDiscoveredComponents(): DiscoveredComponents {
    return {
      tools: this.registry.listTools().map(t => ({
        name: t.name,
        description: t.description,
        source: t.source,
        enabled: this.config.isEnabledInSource(t.source, 'tools', t.name)
      })),
      skills: this.registry.listSkills().map(s => ({
        name: s.name,
        description: s.description,
        source: s.source,
        enabled: this.config.isEnabledInSource(s.source, 'skills', s.name)
      })),
      subagents: this.registry.listSubagents().map(s => ({
        name: s.name,
        description: s.description,
        source: s.source,
        enabled: this.config.isEnabledInSource(s.source, 'subagents', s.name)
      }))
    };
  }

  getConfigPath(): string {
    return this.config.getConfigPath();
  }

  getAvailableModels(): ModelConfig[] {
    return this.config.getAvailableModels();
  }

  getActiveModelName(): string | undefined {
    return this.config.getActiveModel()?.name;
  }

  getMaxRounds(): number {
    return this.config.getMaxRounds();
  }

  get workspaceDir(): string | undefined {
    return this._workspaceDir;
  }
}
