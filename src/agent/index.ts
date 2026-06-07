import * as vscode from 'vscode';
import * as path from 'path';
import { AgentLoader } from './component/loader';
import { AgentExecutor, ToolCallCallback, TokenUsageCallback, CompressCallback } from './executor';
import { ConfigManager } from './config/manager';
import { createLLMClient } from './llm/factory';
import { ToolContext, DiscoveredComponents, Tool, Skill, Subagent } from './component/types';
import { extractToolDescription } from './component/tools/types';
import { extractSkillDescription } from './component/skills/types';
import { extractSubagentDescription } from './component/subagents/types';
import { executeTool } from './component/tools/executor';
import { getSkillContent } from './component/skills/loader';
import { MessageManager } from './message/MessageManager';
import { createSummarizeFn } from './message/summarizer';

/** subagent 嵌套层数上限，防止 LLM 互相递归调用造成栈/费用爆炸 */
const MAX_SUBAGENT_DEPTH = 3;

export class AgentRuntime {
  private loader: AgentLoader | null = null;
  private executor: AgentExecutor | null = null;
  private initialized: boolean = false;
  private toolCallCallback?: ToolCallCallback;
  private tokenUsageCallback?: TokenUsageCallback;
  private compressCallback?: CompressCallback;
  /** 当前 runtime 在 subagent 递归链中的深度，0 表示用户最外层 */
  private subagentDepth: number = 0;
  readonly configManager: ConfigManager;

  constructor(workspaceDir?: string, options?: { homeOnly?: boolean; subagentDepth?: number }) {
    this.configManager = new ConfigManager(workspaceDir, { homeOnly: options?.homeOnly });
    this.subagentDepth = options?.subagentDepth ?? 0;
    const wsDir = this.configManager.getWorkspaceMyAgentDir();
    const homeDir = this.configManager.getHomeMyAgentDir();
    this.loader = new AgentLoader(wsDir, homeDir);
  }

  /**
   * 更新 workspaceDir 并重新加载配置和 loader
   */
  reloadBaseDir(workspaceDir?: string): void {
    this.configManager.reloadBaseDir(path.join(workspaceDir || '', '.myagent'));
    const wsDir = this.configManager.getWorkspaceMyAgentDir();
    const homeDir = this.configManager.getHomeMyAgentDir();
    this.loader = new AgentLoader(wsDir, homeDir);
    this.initialized = false;
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
      (name, question) => this.runSubagent(name, question, filteredConfig.subagents),
      this.toolCallCallback
    );

    // 设置 token 使用回调
    if (this.tokenUsageCallback) {
      this.executor.setOnTokenUsage(this.tokenUsageCallback);
    }

    // 设置压缩回调
    if (this.compressCallback) {
      this.executor.setOnCompress(this.compressCallback);
    }

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

  /**
   * 运行子代理：创建一个全新的、只继承 ~/.myagent/ 的 AgentRuntime 来执行。
   *
   * 隔离策略（按 AGENT.md "Subagent" 章节）：
   *   - 不继承当前项目 ./.myagent/ 配置（homeOnly=true）
   *   - 继承 ~/.myagent/ 的 tools/skills/subagents 与 settings.json
   *   - 用子代理 AGENT.md 的 body 作为 system prompt（覆盖 home 默认 agentPrompt）
   *   - 工具执行仍然使用父 runtime 提供的 workspaceDir（即用户真实工作目录）
   *   - 限制嵌套深度，超过 MAX_SUBAGENT_DEPTH 时抛错
   *
   * @param subagentName    被调用的子代理名
   * @param question        父 Agent 传入的问题
   * @param availableSubagents 父 Agent 视野下可见的 subagent 列表（用于查找定义）
   */
  private async runSubagent(
    subagentName: string,
    question: string,
    availableSubagents: Subagent[]
  ): Promise<string> {
    if (this.subagentDepth + 1 > MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `Subagent recursion depth exceeded (max=${MAX_SUBAGENT_DEPTH}). Refusing to call '${subagentName}'.`
      );
    }

    const subagent = availableSubagents.find(s => s.name === subagentName);
    if (!subagent) {
      throw new Error(`Subagent ${subagentName} not found`);
    }

    // 创建独立的子 runtime：homeOnly 模式，深度 +1
    const childRuntime = new AgentRuntime(subagent.subAgentPath, {
      subagentDepth: this.subagentDepth + 1
    });

    // 透传父 runtime 的回调，让前端能看到子代理内部的工具调用与 token 使用
    if (this.toolCallCallback) childRuntime.setToolCallCallback(this.toolCallCallback);
    if (this.tokenUsageCallback) childRuntime.setTokenUsageCallback(this.tokenUsageCallback);

    // 用子代理自己的 AGENT.md body 覆盖默认 agentPrompt
    const childMessageManager = new MessageManager();
    await childRuntime.initialize(childMessageManager);
    const childAgentPrompt = childRuntime.loader?.getAgentPrompt();
    if (childAgentPrompt) {
      childMessageManager.setSystemPrompt(childAgentPrompt);
    }
    childMessageManager.setAvailableComponentsFromList(subagent.tools, subagent.skills, []);
    childMessageManager.addUserMessage(question);

    // 工具上下文沿用父 runtime 的 workspaceDir（用户实际项目目录）
    const parentWorkspaceDir = this.configManager.getWorkspaceMyAgentDir()
      ? this.configManager.getWorkspaceMyAgentDir()!.replace(/[\/\\]\.myagent$/, '')
      : process.cwd();

    return childRuntime.execute(childMessageManager, parentWorkspaceDir);
  }

  setToolCallCallback(cb: ToolCallCallback): void {
    this.toolCallCallback = cb;
    if (this.executor) {
      this.executor.setOnToolCall(cb);
    }
  }

  setTokenUsageCallback(cb: TokenUsageCallback): void {
    this.tokenUsageCallback = cb;
    if (this.executor) {
      this.executor.setOnTokenUsage(cb);
    }
  }

  setCompressCallback(cb: CompressCallback | undefined): void {
    this.compressCallback = cb;
    if (this.executor) {
      this.executor.setOnCompress(cb);
    }
  }

  getConfigPath(): string {
    return this.loader?.getBaseDir() || '';
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 压缩消息历史：用 LLM 摘要替代旧消息，保留近期对话。
   * 可由用户主动调用，也可由自动压缩回调触发。
   */
  async compressHistory(messageManager: MessageManager): Promise<boolean> {
    if (!this.executor) {
      return false;
    }

    const summarizeFn = createSummarizeFn((this.executor as any).client);
    return messageManager.compressHistory(summarizeFn);
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
