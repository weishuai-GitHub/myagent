import { createLLMClient } from '../../src/agent/llm/factory';
import { AnthropicClient } from '../../src/agent/llm/anthropic';
import { OpenAIClient } from '../../src/agent/llm/openai';
import { ModelConfig } from '../../src/agent/types';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import {
  LLMRequestError,
  isRetryableLLMError,
  parseRetryAfterMs,
  retryLLMCall
} from '../../src/agent/llm/retry';

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

describe('LLM retry policy', () => {
  const immediateRetry = {
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    requestTimeoutMs: 1_000
  };

  it('retries rate limits and transient server errors until success', async () => {
    const operation = jest.fn()
      .mockRejectedValueOnce(new LLMRequestError('rate limited', { status: 429 }))
      .mockRejectedValueOnce(new LLMRequestError('unavailable', { status: 503 }))
      .mockResolvedValue('ok');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(retryLLMCall(operation, immediateRetry)).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('does not retry authentication or invalid request failures', async () => {
    const operation = jest.fn()
      .mockRejectedValue(new LLMRequestError('unauthorized', { status: 401 }));

    await expect(retryLLMCall(operation, immediateRetry)).rejects.toThrow('unauthorized');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries network failures', () => {
    expect(isRetryableLLMError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })))
      .toBe(true);
    expect(isRetryableLLMError(new TypeError('fetch failed'))).toBe(true);
  });

  it('aborts timed-out attempts and retries them', async () => {
    const operation = jest.fn((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(retryLLMCall(operation, {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      requestTimeoutMs: 10
    })).rejects.toThrow('模型调用超时');

    expect(operation).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('stops retries immediately when the caller cancels', async () => {
    const controller = new AbortController();
    const operation = jest.fn((signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const request = retryLLMCall(operation, {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      requestTimeoutMs: 1_000
    }, controller.signal);

    controller.abort(new Error('cancelled by user'));

    await expect(request).rejects.toThrow('cancelled by user');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('1.5')).toBe(1_500);
    expect(parseRetryAfterMs(new Date(Date.now() + 5_000).toUTCString()))
      .toBeGreaterThan(3_000);
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
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

function createCodexProcess(options: {
  transientError?: boolean;
  terminalError?: {
    message: string;
    codexErrorInfo?: any;
    additionalDetails?: string;
  };
} = {}) {
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
      if (options.transientError) {
        stdout.write(`${JSON.stringify({
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            willRetry: true,
            error: {
              message: 'stream disconnected',
              codexErrorInfo: {
                responseStreamDisconnected: { httpStatusCode: 503 }
              },
              additionalDetails: null
            }
          }
        })}\n`);
      }
      if (options.terminalError) {
        stdout.write(`${JSON.stringify({
          method: 'error',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            willRetry: false,
            error: {
              message: options.terminalError.message,
              codexErrorInfo: options.terminalError.codexErrorInfo ?? null,
              additionalDetails: options.terminalError.additionalDetails ?? null
            }
          }
        })}\n`);
        return true;
      }
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

  it('preserves compressed system summaries in OpenAI request messages', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'continued' }, finish_reason: 'stop' }]
      })
    });
    (global as any).fetch = fetchMock;
    const client = new OpenAIClient(makeOpenAIConfig());

    await client.chat([
      { role: 'system', content: '[历史对话摘要]\n用户决定使用方案 A' },
      { role: 'user', content: '继续' }
    ], {
      systemPrompt: 'base system'
    });

    const request = fetchMock.mock.calls[0][1];
    const body = JSON.parse(request.body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'base system' },
      { role: 'system', content: '[历史对话摘要]\n用户决定使用方案 A' },
      { role: 'user', content: '继续' }
    ]);
  });

  it('sends native function definitions and normalizes returned tool calls', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: {
                name: 'tool_0_reader',
                arguments: '{"path":"README.md"}'
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      })
    });
    (global as any).fetch = fetchMock;
    const client = new OpenAIClient(makeOpenAIConfig());

    const result = await client.chat([{ role: 'user', content: 'read' }], {
      systemPrompt: 'system',
      tools: [{
        name: 'tool_0_reader',
        description: 'read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path']
        }
      }]
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'tool_0_reader' })
      })
    ]);
    expect(result).toMatchObject({
      content: '',
      stopReason: 'tool_calls',
      toolCalls: [{
        id: 'call-1',
        name: 'tool_0_reader',
        arguments: { path: 'README.md' }
      }]
    });
  });

  it('retries retryable API failures and preserves the final usage', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        headers: { get: () => null },
        text: async () => 'temporarily unavailable'
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 }
        })
      });
    (global as any).fetch = fetchMock;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new OpenAIClient(makeOpenAIConfig({
      retry: {
        maxAttempts: 2,
        baseDelayMs: 0,
        maxDelayMs: 0
      }
    }));

    await expect(client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: 'system'
    })).resolves.toMatchObject({
      content: 'recovered',
      usage: { inputTokens: 5, outputTokens: 2 }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('does not retry non-retryable API failures', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => 'invalid key'
    });
    (global as any).fetch = fetchMock;
    const client = new OpenAIClient(makeOpenAIConfig({
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0
      }
    }));

    await expect(client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: 'system'
    })).rejects.toThrow('401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('waits when Codex App Server reports it is retrying internally', async () => {
    const codexProcess = createCodexProcess({ transientError: true });
    spawnMock.mockReturnValue(codexProcess);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = new OpenAIClient(makeOpenAIConfig({
      auth: 'codex',
      apiKey: '',
      baseUrl: ''
    }));

    await expect(client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: ''
    })).resolves.toMatchObject({ content: 'codex reply' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('waiting for internal retry'),
      expect.stringContaining('stream disconnected')
    );
    warn.mockRestore();
  });

  it('surfaces structured terminal errors without a misleading login hint', async () => {
    const codexProcess = createCodexProcess({
      terminalError: {
        message: 'The requested model is unavailable',
        codexErrorInfo: 'badRequest',
        additionalDetails: 'unknown model id'
      }
    });
    spawnMock.mockReturnValue(codexProcess);
    const client = new OpenAIClient(makeOpenAIConfig({
      auth: 'codex',
      apiKey: '',
      baseUrl: '',
      retry: { maxAttempts: 1 }
    }));

    const request = client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: ''
    });
    await expect(request).rejects.toThrow('The requested model is unavailable');
    await expect(request).rejects.toThrow('unknown model id');
    await expect(request).rejects.not.toThrow('codex login');
  });

  it('adds a login hint only for authentication errors', async () => {
    const codexProcess = createCodexProcess({
      terminalError: {
        message: 'token expired',
        codexErrorInfo: 'unauthorized'
      }
    });
    spawnMock.mockReturnValue(codexProcess);
    const client = new OpenAIClient(makeOpenAIConfig({
      auth: 'codex',
      apiKey: '',
      baseUrl: '',
      retry: { maxAttempts: 1 }
    }));

    await expect(client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: ''
    })).rejects.toThrow('codex login status');
  });

  it('reports a missing Codex executable without retrying', async () => {
    const codexProcess = createCodexProcess();
    codexProcess.stdin.write = jest.fn(() => {
      const error = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      codexProcess.emit('error', error);
      return false;
    });
    spawnMock.mockReturnValue(codexProcess);

    const client = new OpenAIClient(makeOpenAIConfig({ auth: 'codex', apiKey: '', baseUrl: '' }));

    await expect(client.chat([{ role: 'user', content: 'hello' }], {
      systemPrompt: ''
    })).rejects.toThrow('codexCommand');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('maps Anthropic tool_use blocks to the shared structured call shape', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [
          { type: 'text', text: 'I will inspect it.' },
          {
            type: 'tool_use',
            id: 'anthropic-call-1',
            name: 'tool_0_reader',
            input: { path: 'README.md' }
          }
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 7, output_tokens: 2 }
      })
    });
    (global as any).fetch = fetchMock;
    const client = new AnthropicClient({
      name: 'Claude',
      provider: 'anthropic',
      model: 'claude-test',
      apiKey: 'key',
      baseUrl: 'https://anthropic.example.test'
    });

    const result = await client.chat([{ role: 'user', content: 'read' }], {
      systemPrompt: 'system',
      tools: [{
        name: 'tool_0_reader',
        description: 'read',
        parameters: { type: 'object', properties: { path: { type: 'string' } } }
      }]
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools[0]).toEqual(expect.objectContaining({
      name: 'tool_0_reader',
      input_schema: expect.objectContaining({ type: 'object' })
    }));
    expect(result).toMatchObject({
      content: 'I will inspect it.',
      stopReason: 'tool_use',
      toolCalls: [{
        id: 'anthropic-call-1',
        name: 'tool_0_reader',
        arguments: { path: 'README.md' }
      }]
    });
  });
});
