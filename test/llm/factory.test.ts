import { createLLMClient } from '../../src/llm/factory';
import { AnthropicClient } from '../../src/llm/anthropic';
import { OpenAIClient } from '../../src/llm/openai';
import { ModelConfig } from '../../src/agent/types';

describe('LLM Client Factory', () => {
  const anthropicConfig: ModelConfig = {
    name: 'test-anthropic',
    provider: 'anthropic',
    model: 'claude-3-opus',
    apiKey: 'test-key',
    baseUrl: 'https://api.anthropic.com'
  };

  const openaiConfig: ModelConfig = {
    name: 'test-openai',
    provider: 'openai',
    model: 'gpt-4',
    apiKey: 'test-key',
    baseUrl: 'https://api.openai.com/v1'
  };

  it('should create AnthropicClient for anthropic provider', () => {
    const client = createLLMClient(anthropicConfig);
    expect(client).toBeInstanceOf(AnthropicClient);
    expect(client.getModelName()).toBe('claude-3-opus');
  });

  it('should create OpenAIClient for aopenai provider', () => {
    const client = createLLMClient(openaiConfig);
    expect(client).toBeInstanceOf(OpenAIClient);
    expect(client.getModelName()).toBe('gpt-4');
  });

  it('should throw error for unsupported provider', () => {
    const invalidConfig: ModelConfig = {
      name: 'test-invalid',
      provider: 'invalid' as any,
      model: 'model',
      apiKey: 'test-key',
      baseUrl: 'https://api.test.com'
    };
    expect(() => createLLMClient(invalidConfig)).toThrow('Unsupported provider: invalid');
  });
});
