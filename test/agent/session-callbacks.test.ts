import { AgentRuntime } from '../../src/agent/runtime';
import { ConfigManager } from '../../src/agent/config/manager';
import { ComponentLoader } from '../../src/agent/component/loader-types';

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
    for (let i = 0; i < 6; i++) mm.history.push({ role: 'user', content: `m${i}` });

    await s.execute('trigger');
    expect(onCompress).toHaveBeenCalled();
    expect(onCompress.mock.calls[0][0]).toBe(999999);
  });
});
