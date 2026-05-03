import { Message, ChatOptions } from './types';
import { AgentConfig, ToolContext } from './component/types';
import { XMLParser } from './xml-parser';
import { LLMClient } from './llm';

export class AgentExecutor {
  private client: LLMClient;
  private config: AgentConfig;
  private toolExecutor: (toolName: string, args: any, context: ToolContext) => Promise<any>;
  private skillLoader: (skillName: string) => Promise<string>;
  private subagentRunner: (subagentName: string, question: string) => Promise<string>;

  constructor(
    client: LLMClient,
    config: AgentConfig,
    toolExecutor: (toolName: string, args: any, context: ToolContext) => Promise<any>,
    skillLoader: (skillName: string) => Promise<string>,
    subagentRunner: (subagentName: string, question: string) => Promise<string>
  ) {
    this.client = client;
    this.config = config;
    this.toolExecutor = toolExecutor;
    this.skillLoader = skillLoader;
    this.subagentRunner = subagentRunner;
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
        maxTokens: 4096,
        thinking
      };

      const response = await this.client.chat(messages, options);
      messages.push({ role: 'assistant', content: response.content });

      // 解析响应中的调用
      const calls = parser.parse(response.content);

      if (calls.length === 0) {
        // 没有更多调用，返回结果
        return parser.stripXmlTags(response.content);
      }

      // 执行调用并追加结果
      for (const call of calls) {
        let result = '';
        switch (call.type) {
          case 'tool':
            try {
              result = await this.toolExecutor(call.name, call.args, context);
            } catch (e: any) {
              result = `Error: ${e.message}`;
            }
            break;
          case 'skill':
            try {
              result = await this.skillLoader(call.name);
            } catch (e: any) {
              result = `Error: ${e.message}`;
            }
            break;
          case 'subagent':
            try {
              result = await this.subagentRunner(call.name, call.question);
            } catch (e: any) {
              result = `Error: ${e.message}`;
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
}
