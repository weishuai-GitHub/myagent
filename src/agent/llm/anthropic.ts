import { Message, ChatOptions, ChatResponse, ModelConfig } from '../types';
import { LLMClient } from './index';

export class AnthropicClient implements LLMClient {
  private config: ModelConfig;
  private modelName: string;

  constructor(config: ModelConfig) {
    this.config = config;
    this.modelName = config.model;
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    let systemMessage = messages.find(m => m.role === 'system');
    if (systemMessage) {
      systemMessage.content = options.systemPrompt + '\n\n' + systemMessage.content;
    }
    const userMessages = messages.filter(m => m.role !== 'system');

    const thinking = options.thinking === true;

    const requestBody: any = {
      model: this.modelName,
      max_tokens: options.maxTokens || 100000,
      temperature: thinking ? 1.0 : (options.temperature || 1.0),
      system: systemMessage?.content || '',
      messages: userMessages.map(m => ({
        role: m.role,
        content: m.content
      }))
    };

    // 开启 extended thinking 时添加 thinking 配置
    if (thinking) {
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: options.maxTokens ? Math.min(options.maxTokens, 10000) : 10000
      };
    }

    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    // content 数组包含 thinking 和 text 两种 block
    const thinkingBlock = data.content.find((b: any) => b.type === 'thinking');
    const textBlock = data.content.find((b: any) => b.type === 'text');

    return {
      content: textBlock?.text || '',
      thinking: thinkingBlock?.thinking || undefined,
      stopReason: data.stop_reason
    };
  }

  switchModel(modelName: string): void {
    this.modelName = modelName;
  }

  getModelName(): string {
    return this.modelName;
  }
}
