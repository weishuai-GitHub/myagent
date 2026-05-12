import { AgentLoader } from './component/loader';
import { AgentExecutor, ToolCallCallback } from './executor';
import { ConfigManager } from './config/manager';
import { createLLMClient } from './llm/factory';
import { ToolContext, DiscoveredComponents, Tool, Skill, Subagent } from './component/types';
import { extractToolDescription } from './component/tools/types';
import { extractSkillDescription } from './component/skills/types';
import { extractSubagentDescription } from './component/subagents/types';
import { executeTool } from './component/tools/executor';
import { getSkillContent } from './component/skills/loader';
import { runSubagent } from './component/subagents/runner';
import { MessageManager } from './message/MessageManager';
import { ToolCallStatus } from './types';

export class AgentRuntime {
  private loader: AgentLoader | null = null;
  private executor: AgentExecutor | null = null;
  private initialized: boolean = false;
  private toolCallCallback?: ToolCallCallback;
  readonly configManager: ConfigManager;

  constructor() {
    this.configManager = new ConfigManager();
    const workspaceDir = this.configManager.getWorkspaceMyAgentDir();
    const homeDir = this.configManager.getHomeMyAgentDir();
    this.loader = new AgentLoader(workspaceDir, homeDir);
  }

  /**
   * 初始化 AgentRuntime：加载组件、创建 LLM 客户端和 executor。
   * 应在导入配置后尽早调用。
   * @param messageManager 注入系统提示词和组件描述
   */
  async initialize(messageManager: MessageManager): Promise<void> {
    if (!this.loader) {
      const workspaceDir = this.configManager.getWorkspaceMyAgentDir();
      const homeDir = this.configManager.getHomeMyAgentDir();
      this.loader = new AgentLoader(workspaceDir, homeDir);
    }

    const config = this.loader.load();

    // 用每个组件来源目录的 enabled 列表过滤组件
    const filteredConfig = {
      ...config,
      tools: config.tools.filter(t => this.configManager.isEnabledInSource(t.source, 'tools', t.name)),
      skills: config.skills.filter(s => this.configManager.isEnabledInSource(s.source, 'skills', s.name)),
      subagents: config.subagents.filter(s => this.configManager.isEnabledInSource(s.source, 'subagents', s.name))
    };

    const modelConfig = this.configManager.getActiveModel();
    if (!modelConfig) {
      throw new Error('No active model configured');
    }

    const client = createLLMClient(modelConfig);

    this.executor = new AgentExecutor(
      client,
      filteredConfig,
      (name, args, ctx) => executeTool(filteredConfig.tools, name, args, ctx),
      (name) => getSkillContent(filteredConfig.skills, name),
      (name, question) => runSubagent(filteredConfig.subagents, name, question),
      this.toolCallCallback
    );

    // 注入系统提示词到 MessageManager
    messageManager.setSystemPrompt(config.agentPrompt);

    // 注入组件描述到 MessageManager
    const descriptions = this.buildComponentDescriptions(filteredConfig.tools, filteredConfig.skills, filteredConfig.subagents);
    messageManager.setComponentDescriptions(descriptions);

    this.initialized = true;
  }

  /**
   * 执行对话循环。接收 MessageManager，从中获取消息历史。
   */
  async execute(messageManager: MessageManager, workspaceDir: string): Promise<string> {
    if (!this.executor) {
      throw new Error('AgentRuntime not initialized. Call initialize() first.');
    }
    const context: ToolContext = {
      env: this.configManager.getEnv(),
      workspaceDir,
      availableComponents: messageManager.getAvailableComponents()
    };

    const messages = messageManager.getMessages();
    return this.executor!.run(messages, context, this.configManager.getMaxRounds());
  }

  private buildComponentDescriptions(tools: Tool[], skills: Skill[], subagents: Subagent[]): string {
    const parts: string[] = [];
    parts.push("以下是组件列表的详细描述：\n");
    if (tools.length > 0) {
      parts.push('工具列表:\n' + tools.map(extractToolDescription).join('\n'));
    }

    if (skills.length > 0) {
      parts.push('技能列表:\n' + skills.map(extractSkillDescription).join('\n'));
    }

    if (subagents.length > 0) {
      parts.push('子代理列表:\n' + subagents.map(extractSubagentDescription).join('\n'));
    }

    return parts.join('\n\n');
  }

  switchModel(modelName: string): void {
    if (this.executor) {
      this.executor.switchModel(modelName);
    }
  }

  setToolCallCallback(cb: ToolCallCallback): void {
    this.toolCallCallback = cb;
    if (this.executor) {
      this.executor.setOnToolCall(cb);
    }
  }

  getConfigPath(): string {
    return this.loader?.getBaseDir() || '';
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 返回所有可发现的组件信息（含启用状态），供前端展示。
   */
  getDiscoveredComponents(): DiscoveredComponents {
    if (!this.loader) {
      return { tools: [], skills: [], subagents: [] };
    }

    const components = this.loader.discoverComponents();

    return {
      tools: components.tools.map(t => ({
        ...t,
        enabled: this.configManager.isEnabledInSource(t.source, 'tools', t.name)
      })),
      skills: components.skills.map(s => ({
        ...s,
        enabled: this.configManager.isEnabledInSource(s.source, 'skills', s.name)
      })),
      subagents: components.subagents.map(s => ({
        ...s,
        enabled: this.configManager.isEnabledInSource(s.source, 'subagents', s.name)
      }))
    };
  }
}
