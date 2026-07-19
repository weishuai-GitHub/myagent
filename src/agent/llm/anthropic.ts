import { Message, ChatOptions, ChatResponse, ModelConfig } from '../types';
import { LLMClient } from './index';
import { LLMRequestError, parseRetryAfterMs, retryLLMCall } from './retry';

export class AnthropicClient implements LLMClient {
  private config: ModelConfig;
  private modelName: string;

  constructor(config: ModelConfig) {
    this.config = config;
    this.modelName = config.model;
  }

  async chat(messages: Message[], options: ChatOptions, signal?: AbortSignal): Promise<ChatResponse> {
    return retryLLMCall(
      attemptSignal => this.chatOnce(messages, options, attemptSignal),
      this.config.retry,
      signal
    );
  }

  private async chatOnce(
    messages: Message[],
    options: ChatOptions,
    signal: AbortSignal
  ): Promise<ChatResponse> {
    const apiKey = this.config.apiKey;
    const configuredBaseUrl = this.config.baseUrl;
    if (!apiKey) {
      throw new Error('Anthropic API key 未配置');
    }
    if (!configuredBaseUrl) {
      throw new Error('Anthropic baseUrl 未配置');
    }

    const systemMessages = messages.filter(m => m.role === 'system');
    const systemPrompt = [
      options.systemPrompt,
      ...systemMessages.map(message => message.content)
    ].filter(Boolean).join('\n\n');
    const userMessages = messages.filter(m => m.role !== 'system');

    const thinking = options.thinking === true;

    const requestBody: any = {
      model: this.modelName,
      max_tokens: options.maxTokens ?? 100000,
      temperature: thinking ? 1.0 : (options.temperature ?? 1.0),
      system: systemPrompt,
      messages: userMessages.map(m => ({
        role: m.role,
        content: m.content
      })),
      ...(options.tools && options.tools.length > 0 ? {
        tools: options.tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters
        }))
      } : {})
    };

    // 开启 extended thinking 时添加 thinking 配置
    if (thinking) {
      requestBody.thinking = {
        type: 'enabled',
        budget_tokens: options.maxTokens ? Math.min(options.maxTokens, 10000) : 10000
      };
    }

    const baseUrl = configuredBaseUrl.replace(/\/+$/, '');
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody),
      signal
    });

    if (!response.ok) {
      const error = await response.text();
      throw new LLMRequestError(
        `Anthropic API error: ${response.status} - ${error}`,
        {
          status: response.status,
          retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after'))
        }
      );
    }

    const data = await response.json();

    // content 数组包含 thinking 和 text 两种 block
    const thinkingBlock = data.content.find((b: any) => b.type === 'thinking');
    const textBlocks = data.content.filter((b: any) => b.type === 'text');
    const toolCalls = data.content
      .filter((block: any) => block.type === 'tool_use')
      .map((block: any) => ({
        id: String(block.id || ''),
        name: String(block.name || ''),
        arguments: block.input && typeof block.input === 'object' ? block.input : {}
      }))
      .filter((call: any) => call.name);

    return {
      content: textBlocks.map((block: any) => block.text || '').join('\n'),
      thinking: thinkingBlock?.thinking || undefined,
      stopReason: data.stop_reason,
      usage: data.usage ? {
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0
      } : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    };
  }

  switchModel(modelName: string): void {
    this.modelName = modelName;
  }

  getModelName(): string {
    return this.modelName;
  }
}
