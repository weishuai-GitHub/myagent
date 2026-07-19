import { Message, ChatOptions, ChatResponse } from '../types';

export interface LLMClient {
  chat(messages: Message[], options: ChatOptions, signal?: AbortSignal): Promise<ChatResponse>;
  switchModel(modelName: string): void;
  getModelName(): string;
}
