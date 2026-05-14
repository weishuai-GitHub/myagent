import { Message, ChatOptions, ToolCallStatus, TokenUsage } from './types';
import { AgentConfig, ToolContext } from './component/types';
import { XMLParser } from './xml-parser';
import { LLMClient } from './llm';

export type ToolCallCallback = (status: ToolCallStatus) => void;
export type TokenUsageCallback = (usage: TokenUsage) => void;

export class AgentExecutor {
  private client: LLMClient;
  private config: AgentConfig;
  private toolExecutor: (toolName: string, args: any, context: ToolContext) => Promise<any>;
  private skillLoader: (skillName: string) => Promise<string>;
  private subagentRunner: (subagentName: string, question: string) => Promise<string>;
  private onToolCall?: ToolCallCallback;
  private onTokenUsage?: TokenUsageCallback;

  constructor(
    client: LLMClient,
    config: AgentConfig,
    toolExecutor: (toolName: string, args: any, context: ToolContext) => Promise<any>,
    skillLoader: (skillName: string) => Promise<string>,
    subagentRunner: (subagentName: string, question: string) => Promise<string>,
    onToolCall?: ToolCallCallback
  ) {
    this.client = client;
    this.config = config;
    this.toolExecutor = toolExecutor;
    this.skillLoader = skillLoader;
    this.subagentRunner = subagentRunner;
    this.onToolCall = onToolCall;
  }

  /**
   * 执行对话循环。
   * @param messages 当前消息历史（系统提示词和组件描述已由 MessageManager 注入）
   * @param context 工具执行上下文
   * @param maxRounds 最大执行轮次
   * @returns 最终回复文本
   */
  async run(messages: Message[], context: ToolContext, maxRounds: number = 10): Promise<string> {
    const parser = new XMLParser();

    // 从 env 读取 thinking 配置，默认不开启
    const thinking = context.env.ANTHROPIC_THINKING ? context.env.ANTHROPIC_THINKING === 'true' : false;
    let systemPrompt = this.config.agentPrompt.replace('${workspace}', context.workspaceDir || '')
    .replace('${components}', context.availableComponents || '');
    for (let round = 0; round < maxRounds; round++) {
      const options: ChatOptions = {
        systemPrompt: systemPrompt,
        maxTokens: context.env.MAX_TOKENS ? parseInt(context.env.MAX_TOKENS) : 100000,
        thinking
      };

      const response = await this.client.chat(messages, options);
      messages.push({ role: 'assistant', content: response.content });

      // 回调 token 使用量
      if (response.usage) {
        this.onTokenUsage?.(response.usage);
      }

      // 解析响应中的调用
      const calls = parser.parse(response.content);

      if (calls.length === 0) {
        // 没有更多调用，返回结果
        return parser.stripXmlTags(response.content);
      }

      // 执行调用并追加结果
      for (const call of calls) {
        let result = '';
        const callType = call.type as 'tool' | 'skill' | 'subagent';
        const callName = call.name;

        // 通知前端：正在调用
        this.onToolCall?.({ type: callType, name: callName, status: 'calling' });

        switch (call.type) {
          case 'tool':
            try {
              result = await this.toolExecutor(call.name, call.args, context);
              this.onToolCall?.({ type: callType, name: callName, status: 'success', result: this.truncateResult(result) });
            } catch (e: any) {
              result = `Error: ${e.message}`;
              this.onToolCall?.({ type: callType, name: callName, status: 'error', error: e.message });
            }
            break;
          case 'skill':
            try {
              result = await this.skillLoader(call.name);
              this.onToolCall?.({ type: callType, name: callName, status: 'success', result: this.truncateResult(result) });
            } catch (e: any) {
              result = `Error: ${e.message}`;
              this.onToolCall?.({ type: callType, name: callName, status: 'error', error: e.message });
            }
            break;
          case 'subagent':
            try {
              result = await this.subagentRunner(call.name, call.question);
              this.onToolCall?.({ type: callType, name: callName, status: 'success', result: this.truncateResult(result) });
            } catch (e: any) {
              result = `Error: ${e.message}`;
              this.onToolCall?.({ type: callType, name: callName, status: 'error', error: e.message });
            }
            break;
        }

        messages.push({
          role: 'user',
          content: `${call.type} ${call.name} 结果: ${result}`
        });
      }
    }

    // 达到最大轮次
    return messages[messages.length - 1]?.content || '达到最大执行轮次';
  }

  switchModel(modelName: string): void {
    this.client.switchModel(modelName);
  }

  setOnToolCall(cb: ToolCallCallback | undefined): void {
    this.onToolCall = cb;
  }

  setOnTokenUsage(cb: TokenUsageCallback | undefined): void {
    this.onTokenUsage = cb;
  }

  private truncateResult(result: string, maxLen: number = 200): string {
    if (!result) return '';
    const str = String(result);
    return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
  }
}
