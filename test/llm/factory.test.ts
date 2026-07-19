import { createLLMClient } from '../../src/agent/llm/factory';
import { AnthropicClient } from '../../src/agent/llm/anthropic';
import { OpenAIClient } from '../../src/agent/llm/openai';
import { ModelConfig } from '../../src/agent/types';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';

jest.mock('child_process', () => ({
  spawn: jest.fn()
}));

const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

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

function makeOpenAIConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'GPT',
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test-key',
    baseUrl: 'https://api.example.test/v1',
    ...overrides
  };
}

function createCodexProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter() as any;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = jest.fn(() => {
    child.killed = true;
    return true;
  });
  const stdin = new EventEmitter() as any;
  stdin.write = jest.fn((chunk: string) => {
    const message = JSON.parse(chunk);
    if (message.method === 'initialize') {
      stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'test' } })}\n`);
    } else if (message.method === 'thread/start') {
      stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: 'thread-1' } } })}\n`);
    } else if (message.method === 'turn/start') {
      stdout.write(`${JSON.stringify({ id: message.id, result: { turn: { id: 'turn-1' } } })}\n`);
      stdout.write(`${JSON.stringify({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: { type: 'agentMessage', text: 'codex reply' }
        }
      })}\n`);
      stdout.write(`${JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed' }
        }
      })}\n`);
      setTimeout(() => {
        stdout.write(`${JSON.stringify({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            tokenUsage: {
              last: { inputTokens: 12, outputTokens: 3 }
            }
          }
        })}\n`);
      }, 0);
    }
    return true;
  });
  stdin.end = jest.fn();
  child.stdin = stdin;
  return child;
}

describe('OpenAIClient', () => {
  const originalFetch = (global as any).fetch;

  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    if (originalFetch) {
      (global as any).fetch = originalFetch;
    } else {
      delete (global as any).fetch;
    }
  });

  it('uses the API key chat completions path by default and maps usage', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'api reply' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 4 }
      })
    });
    (global as any).fetch = fetchMock;

    const client = new OpenAIClient(makeOpenAIConfig());
    const result = await client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: 'system'
    });

    expect(result).toEqual({
      content: 'api reply',
      stopReason: 'stop',
      usage: { inputTokens: 9, outputTokens: 4 }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/v1/chat/completions',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' })
      })
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('uses Codex App Server when auth is codex', async () => {
    const codexProcess = createCodexProcess();
    spawnMock.mockReturnValue(codexProcess);

    const client = new OpenAIClient(makeOpenAIConfig({
      auth: 'codex',
      apiKey: '',
      baseUrl: '',
      codexCommand: '/opt/codex'
    }));
    const result = await client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: 'system'
    });

    expect(result).toEqual({
      content: 'codex reply',
      stopReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 3 }
    });
    expect(spawnMock).toHaveBeenCalledWith(
      '/opt/codex',
      ['app-server', '--listen', 'stdio://'],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const sent = codexProcess.stdin.write.mock.calls.map((call: [string]) => JSON.parse(call[0]));
    expect(sent.find((message: any) => message.method === 'thread/start').params).toEqual(
      expect.objectContaining({
        model: 'gpt-test',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
        baseInstructions: 'system'
      })
    );
    expect(sent.find((message: any) => message.method === 'turn/start').params.sandboxPolicy).toEqual({
      type: 'readOnly',
      networkAccess: false
    });
  });

  it('explains how to log in when Codex cannot start', async () => {
    const codexProcess = createCodexProcess();
    codexProcess.stdin.write = jest.fn(() => {
      codexProcess.emit('error', new Error('ENOENT'));
      return false;
    });
    spawnMock.mockReturnValue(codexProcess);

    const client = new OpenAIClient(makeOpenAIConfig({ auth: 'codex', apiKey: '', baseUrl: '' }));

    await expect(client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: ''
    })).rejects.toThrow('codex login');
  });
});
