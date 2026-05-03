import { Message, ChatOptions, ChatResponse, ModelConfig } from '../types';
import { LLMClient } from './index';

export class OpenAIClient implements LLMClient {
  private config: ModelConfig;
  private modelName: string;

  constructor(config: ModelConfig) {
    this.config = config;
    this.modelName = config.model;
  }

  async chat(messages: Message[], options: ChatOptions): Promise<ChatResponse> {
    const formattedMessages: { role: string; content: string }[] = [];

    if (options.systemPrompt) {
      formattedMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role !== 'system') {
        formattedMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        model: this.modelName,
        messages: formattedMessages,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature || 1.0
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      stopReason: data.choices[0].finish_reason
    };
  }

  switchModel(modelName: string): void {
    this.modelName = modelName;
  }

  getModelName(): string {
    return this.modelName;
  }
}
