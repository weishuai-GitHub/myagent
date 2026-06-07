import { AgentRuntime } from './runtime';
import { ComponentRegistry } from './component/registry';
import { MessageManager } from './message/MessageManager';
import { AgentExecutor, ToolCallCallback, TokenUsageCallback, CompressCallback } from './executor';
import { executeTool } from './component/tools/executor';
import { getSkillContent } from './component/skills/loader';
import { extractToolDescription } from './component/tools/types';
import { extractSkillDescription } from './component/skills/types';
import { extractSubagentDescription } from './component/subagents/types';
import { ToolContext, Tool, Skill, Subagent } from './component/types';
import { createSummarizeFn } from './message/summarizer';

export interface SessionOptions {
  callbacks?: {
    onToolCall?: ToolCallCallback;
    onTokenUsage?: TokenUsageCallback;
    onCompress?: CompressCallback;
  };
  enabledTools?: string[];
  enabledSkills?: string[];
  enabledSubagents?: string[];
}

/**
 * Session：一次会话生命周期内的状态容器。
 *
 * 负责：
 * - 持有 MessageManager（系统提示词 / 组件描述 / 对话历史 / token 累计）
 * - 持有 AgentExecutor，并将 SessionOptions.callbacks 注入到 executor
 * - execute(text)：追加用户消息 → 跑 executor → 追加 assistant 回复；出错时回滚最后一条
 * - reset()：清空历史并复位 token 累计，但保留系统上下文
 * - 内部 runSubagent：通过 runtime.spawnSubagent 派生子 runtime + 子 session 执行
 */
export class Session {
  private readonly messageManager: MessageManager;
  private readonly executor: AgentExecutor;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly registry: ComponentRegistry,
    private readonly opts: SessionOptions
  ) {
    this.messageManager = new MessageManager();

    // 系统提示词：本 chunk 暂用空串，Chunk 4 会接入 ~/.myagent/AGENT.md
    const systemPrompt = '';
    const components = this.buildComponentDescriptions(
      this.registry.listTools(),
      this.registry.listSkills(),
      this.registry.listSubagents()
    );
    this.messageManager.setSystemContext(systemPrompt, components);

    this.executor = new AgentExecutor(
      this.runtime.client,
      {
        tools: this.registry.listTools(),
        skills: this.registry.listSkills(),
        subagents: this.registry.listSubagents(),
        agentPrompt: systemPrompt
      },
      (name, args, ctx) => executeTool(this.registry.listTools(), name, args, ctx),
      (name) => getSkillContent(this.registry.listSkills(), name),
      (name, question) => this.runSubagent(name, question),
      opts.callbacks?.onToolCall
    );

    if (opts.callbacks?.onTokenUsage) this.executor.setOnTokenUsage(opts.callbacks.onTokenUsage);
    if (opts.callbacks?.onCompress) this.executor.setOnCompress(opts.callbacks.onCompress);
  }

  async execute(userText: string): Promise<string> {
    this.messageManager.addUserMessage(userText);
    const ctx: ToolContext = {
      env: this.runtime.config.getEnv(),
      workspaceDir: this.runtime.workspaceDir ?? '',
      availableComponents: this.messageManager.getAvailableComponents()
    };
    try {
      const reply = await this.executor.run(
        this.messageManager.getMessages(),
        ctx,
        this.runtime.getMaxRounds()
      );
      this.messageManager.addAssistantMessage(reply);
      return reply;
    } catch (e) {
      this.messageManager.popLast();
      throw e;
    }
  }

  async compressHistory(): Promise<boolean> {
    const summarize = createSummarizeFn(this.runtime.client);
    return this.messageManager.compressHistory(summarize);
  }

  /**
   * 清空对话历史，保留 systemPrompt + 组件描述；同时复位累计 token 为 0。
   * clearHistory() 只清 history，不影响 systemPrompt/componentDescriptions。
   */
  reset(): void {
    this.messageManager.clearHistory();
    this.messageManager.resetTokenUsage();
  }

  getTokenUsage() {
    return this.messageManager.getTokenUsage();
  }

  getMessageCount(): number {
    return this.messageManager.getLength();
  }

  private async runSubagent(name: string, question: string): Promise<string> {
    const sub = this.registry.findSubagent(name);
    if (!sub) throw new Error(`Subagent ${name} not found`);

    const childRuntime = this.runtime.spawnSubagent(sub);
    const childSession = childRuntime.createSession({
      callbacks: this.opts.callbacks,
      enabledTools: sub.tools?.map((t: any) => typeof t === 'string' ? t : t.name),
      enabledSkills: sub.skills?.map((s: any) => typeof s === 'string' ? s : s.name)
    });
    return childSession.execute(question);
  }

  private buildComponentDescriptions(tools: Tool[], skills: Skill[], subagents: Subagent[]): string {
    const parts: string[] = ['以下是组件列表的详细描述：\n'];
    if (tools.length > 0) parts.push('工具列表:\n' + tools.map(extractToolDescription).join('\n'));
    if (skills.length > 0) parts.push('技能列表:\n' + skills.map(extractSkillDescription).join('\n'));
    if (subagents.length > 0) parts.push('子代理列表:\n' + subagents.map(extractSubagentDescription).join('\n'));
    return parts.join('\n\n');
  }
}
