import { AgentRuntime } from '../../src/agent/runtime';
import { ConfigManager } from '../../src/agent/config/manager';
import { ComponentLoader } from '../../src/agent/component/loader-types';
import { FloatingPanelProvider } from '../../src/FloatingPanelProvider';
import * as vscode from 'vscode';

const chatMock = jest.fn();

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn(() => ({
    chat: chatMock,
    switchModel: jest.fn(),
    getModelName: () => 'm'
  }))
}));

const fakeModel = { name: 'm', provider: 'anthropic', model: 'm', apiKey: '' } as any;

class StubToolLoader implements ComponentLoader {
  readonly name = 'stub';
  async loadTools(m: Map<string, any>) {
    m.set('echo', { name: 'echo', description: '', source: 'home', toolPath: '/h/tools/echo' });
  }
}

describe('Session callbacks', () => {
  beforeEach(() => {
    jest.spyOn(ConfigManager.prototype, 'getActiveModel').mockReturnValue(fakeModel);
    jest.spyOn(ConfigManager.prototype, 'isEnabledInSource').mockReturnValue(true);
    chatMock.mockReset();
  });
  afterEach(() => jest.restoreAllMocks());

  it('onTokenUsage fires once per chat call', async () => {
    chatMock.mockResolvedValue({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } });
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    const onTokenUsage = jest.fn();
    const s = rt.createSession({ callbacks: { onTokenUsage } });
    await s.execute('a');
    await s.execute('b');
    expect(onTokenUsage).toHaveBeenCalledTimes(2);
    expect(onTokenUsage).toHaveBeenNthCalledWith(1, { inputTokens: 1, outputTokens: 1 });
    expect(onTokenUsage).toHaveBeenNthCalledWith(2, { inputTokens: 2, outputTokens: 2 });
    expect(s.getTokenUsage()).toEqual({ inputTokens: 2, outputTokens: 2, totalTokens: 4 });
  });

  it('tracks token usage even without a UI callback', async () => {
    chatMock.mockResolvedValue({ content: 'ok', usage: { inputTokens: 12, outputTokens: 3 } });
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    const s = rt.createSession();

    await s.execute('a');

    expect(s.getTokenUsage()).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 });
  });

  it('onToolCall fires for tool dispatch (calling + success/error)', async () => {
    chatMock
      .mockResolvedValueOnce({
        content: '<tool><name>echo</name><args></args></tool>',
        usage: { inputTokens: 1, outputTokens: 1 }
      })
      .mockResolvedValueOnce({ content: 'done', usage: { inputTokens: 1, outputTokens: 1 } });

    const rt = await AgentRuntime.create({ skipDefaultLoaders: true, extraLoaders: [new StubToolLoader()] });
    const onToolCall = jest.fn();
    const s = rt.createSession({ callbacks: { onToolCall } });
    await s.execute('use tool');

    const types = onToolCall.mock.calls.map(c => c[0]);
    // 不论 echo 工具实际执行 success 还是 error（fake path 不存在会 error），都至少触发 calling + 终态
    expect(types.some(t => t.type === 'tool' && t.name === 'echo' && t.status === 'calling')).toBe(true);
    expect(types.some(t => t.type === 'tool' && t.name === 'echo' && (t.status === 'success' || t.status === 'error'))).toBe(true);
    expect(s.getHistorySnapshot().items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        callId: expect.stringMatching(/^call-/),
        callType: 'tool',
        name: 'echo'
      })
    ]));
  });

  it('onCompress is awaited when executor signals high inputTokens after >5 messages', async () => {
    // 让 chat 反复返回带有大 inputTokens 的 usage；用大量 tool 调用累积 messages > 5
    chatMock.mockImplementation(async () => ({
      content: 'final',
      usage: { inputTokens: 999999, outputTokens: 1 }
    }));
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    const onCompress = jest.fn().mockResolvedValue(undefined);
    const s = rt.createSession({ callbacks: { onCompress } });

    // 灌 6 条以上历史消息：直接 execute 一次（chat 返回 final 立即结束），消息长度不足
    // 因此手动通过 messageManager 灌足
    const mm: any = (s as any).messageManager;
    for (let i = 0; i < 6; i++) mm.addMessage({ role: 'user', content: `m${i}` });

    await s.execute('trigger');
    expect(onCompress).toHaveBeenCalled();
    expect(onCompress.mock.calls[0][0]).toBe(999999);
  });

  it('does not auto-compress below MessageManager token threshold', async () => {
    chatMock.mockResolvedValue({
      content: 'final',
      usage: { inputTokens: 10_000, outputTokens: 1 }
    });
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    const onCompress = jest.fn().mockResolvedValue(undefined);
    const s = rt.createSession({ callbacks: { onCompress } });
    const mm: any = (s as any).messageManager;
    for (let index = 0; index < 8; index++) {
      mm.addMessage({ role: 'user', content: `m${index}` });
    }

    await s.execute('trigger');

    expect(onCompress).not.toHaveBeenCalled();
  });
});

describe('persistent tool approvals', () => {
  const request = {
    toolName: 'executeBash',
    capabilities: ['shell'] as const,
    reason: '工具请求高风险能力：shell',
    argsPreview: '{"command":"pwd"}',
    approvalId: 'capability:shell'
  };

  function createProvider() {
    const state = new Map<string, any>();
    const workspaceState = {
      get: jest.fn((key: string, fallback?: any) => state.has(key) ? state.get(key) : fallback),
      update: jest.fn(async (key: string, value: any) => {
        state.set(key, value);
      })
    };
    const context = { workspaceState } as any;
    const provider = new FloatingPanelProvider(context, {} as any) as any;
    return { provider, state, workspaceState };
  }

  beforeEach(() => {
    (vscode.window.showWarningMessage as jest.Mock).mockReset();
    (vscode.window.showInformationMessage as jest.Mock).mockReset();
  });

  it('persists always-allow per workspace and skips later prompts', async () => {
    const { provider, workspaceState } = createProvider();
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('一直允许');

    await expect(provider.requestToolApproval(request)).resolves.toBe(true);
    await expect(provider.requestToolApproval(request)).resolves.toBe(true);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(workspaceState.update).toHaveBeenCalledWith(
      'myagent_tool_approvals_v1',
      [JSON.stringify(['executeBash', 'capability:shell'])]
    );
  });

  it('keeps outside-workspace approvals separate from shell capability', async () => {
    const { provider } = createProvider();
    (vscode.window.showWarningMessage as jest.Mock)
      .mockResolvedValueOnce('一直允许')
      .mockResolvedValueOnce('拒绝');

    await expect(provider.requestToolApproval(request)).resolves.toBe(true);
    await expect(provider.requestToolApproval({
      ...request,
      reason: '工具请求访问工作区外路径：/tmp',
      approvalId: 'outside-workspace:/tmp'
    })).resolves.toBe(false);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(2);
  });

  it('can revoke all persistent approvals for the workspace', async () => {
    const { provider, workspaceState } = createProvider();
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('一直允许');
    await provider.requestToolApproval(request);

    await provider.clearToolApprovals();

    expect(workspaceState.update).toHaveBeenLastCalledWith(
      'myagent_tool_approvals_v1',
      []
    );
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });
});

describe('webview public configuration', () => {
  it('does not send credentials, environment variables, or transport details to the webview', () => {
    const postMessage = jest.fn();
    const settings = {
      models: [{
        name: 'secure-model',
        provider: 'openai',
        model: 'gpt-secure',
        auth: 'codex',
        apiKey: 'super-secret',
        baseUrl: 'https://private.example.test',
        codexCommand: '/private/bin/codex',
        retry: { maxAttempts: 9 }
      }],
      activeModel: 'secure-model',
      enabledTools: ['fileRead'],
      enabledSkills: ['review'],
      enabledSubagents: [],
      maxRounds: 12,
      env: {
        PRIVATE_TOKEN: 'environment-secret',
        ANTHROPIC_THINKING: 'true'
      }
    };
    const runtime = {
      config: {
        getConfigPath: () => '/workspace/.myagent/settings.json',
        getSettings: () => settings,
        getDiagnostics: () => []
      },
      getAvailableModels: () => settings.models,
      getActiveModelName: () => 'secure-model',
      getDiscoveredComponents: () => ({ tools: [], skills: [], subagents: [] })
    };
    const context = { workspaceState: { get: jest.fn(), update: jest.fn() } } as any;
    const provider = new FloatingPanelProvider(context, runtime as any) as any;
    provider.view = { webview: { postMessage } };

    provider.updateConfig();

    const payload = postMessage.mock.calls[0][0];
    expect(payload.config).toEqual({
      activeModel: 'secure-model',
      enabledTools: ['fileRead'],
      enabledSkills: ['review'],
      enabledSubagents: [],
      maxRounds: 12
    });
    expect(payload.models).toEqual([{
      name: 'secure-model',
      provider: 'openai',
      model: 'gpt-secure',
      auth: 'codex'
    }]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('environment-secret');
    expect(serialized).not.toContain('private.example.test');
    expect(serialized).not.toContain('/private/bin/codex');
    expect(serialized).not.toContain('maxAttempts');
  });
});

describe('FloatingPanelProvider message routing', () => {
  it('routes execute-task through the session and reports a terminal state', async () => {
    const postMessage = jest.fn();
    const execute = jest.fn().mockResolvedValue('routed response');
    const getTokenUsage = jest.fn().mockReturnValue({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5
    });
    const getHistorySnapshot = jest.fn().mockReturnValue([
      { role: 'user', content: 'route me' },
      { role: 'assistant', content: 'routed response' }
    ]);
    const createSession = jest.fn().mockReturnValue({
      execute,
      getTokenUsage,
      getHistorySnapshot,
      restoreHistory: jest.fn()
    });
    const runtime = { createSession } as any;
    const context = {
      workspaceState: {
        get: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined)
      }
    } as any;
    const provider = new FloatingPanelProvider(context, runtime) as any;
    provider.view = { webview: { postMessage } };

    await provider.handleMessage({
      type: 'execute-task',
      requestId: 'route-1',
      content: 'route me',
      enabledTools: ['fileRead'],
      enabledSkills: [],
      enabledSubagents: []
    });

    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      enabledTools: ['fileRead'],
      enabledSkills: [],
      enabledSubagents: []
    }));
    expect(execute).toHaveBeenCalledWith('route me', 'route-1');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'agent-response',
      requestId: 'route-1',
      content: 'routed response'
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: 'execution-status',
      requestId: 'route-1',
      phase: 'completed'
    });
  });

  it('restores the webview from the canonical conversation snapshot', async () => {
    const postMessage = jest.fn();
    const snapshot = {
      version: 1,
      items: [
        { id: '1', createdAt: 1, role: 'user', content: 'read it' },
        {
          id: '2',
          createdAt: 2,
          role: 'assistant',
          content: '<tool><name>fileRead</name><args></args></tool>'
        },
        {
          id: '3',
          createdAt: 3,
          role: 'tool',
          callId: 'call-1',
          callType: 'tool',
          name: 'fileRead',
          status: 'success',
          content: 'file contents'
        },
        { id: '4', createdAt: 4, role: 'assistant', content: 'done' }
      ]
    };
    const context = {
      workspaceState: {
        get: jest.fn((key: string, fallback: any) => (
          key === 'myagent_conversation_v1' ? snapshot : fallback
        )),
        update: jest.fn()
      }
    } as any;
    const provider = new FloatingPanelProvider(context, {} as any) as any;
    provider.view = { webview: { postMessage } };

    await provider.handleMessage({ type: 'request-messages' });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'restore-messages',
      messages: [
        { role: 'user', content: 'read it' },
        expect.objectContaining({
          role: 'agent',
          type: 'tool',
          toolCallStatus: expect.objectContaining({
            name: 'fileRead',
            status: 'success'
          })
        }),
        { role: 'agent', content: 'done' }
      ]
    });
  });

  it('rejects a second requestId without corrupting the active request state', async () => {
    let resolveFirst!: (value: string) => void;
    const execute = jest.fn().mockImplementation(() => new Promise<string>(resolve => {
      resolveFirst = resolve;
    }));
    const session = {
      execute,
      getTokenUsage: () => ({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
      getHistorySnapshot: () => ({ version: 1, items: [] }),
      restoreHistory: jest.fn(),
      cancel: jest.fn()
    };
    const runtime = { createSession: jest.fn(() => session) };
    const postMessage = jest.fn();
    const context = {
      workspaceState: {
        get: jest.fn((_key: string, fallback: any) => fallback),
        update: jest.fn().mockResolvedValue(undefined)
      }
    } as any;
    const provider = new FloatingPanelProvider(context, runtime as any) as any;
    provider.view = { webview: { postMessage } };

    const first = provider.handleMessage({
      type: 'execute-task',
      requestId: 'request-1',
      content: 'first'
    });
    await Promise.resolve();
    await provider.handleMessage({
      type: 'execute-task',
      requestId: 'request-2',
      content: 'second'
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'execution-status',
      requestId: 'request-2',
      phase: 'error'
    }));

    resolveFirst('done');
    await first;
    expect(postMessage).toHaveBeenCalledWith({
      type: 'execution-status',
      requestId: 'request-1',
      phase: 'completed'
    });
  });
});
