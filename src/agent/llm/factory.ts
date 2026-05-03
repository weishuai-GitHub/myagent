import { ModelConfig } from '../types';
import { LLMClient } from './index';
import { AnthropicClient } from './anthropic';
import { OpenAIClient } from './openai';

export function createLLMClient(config: ModelConfig): LLMClient {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicClient(config);
    case 'openai':
      return new OpenAIClient(config);
    default:
      throw new Error(`Unsupported provider: ${config.provider}`);
  }
}

export { AnthropicClient } from './anthropic';
export { OpenAIClient } from './openai';
export { LLMClient } from './index';
