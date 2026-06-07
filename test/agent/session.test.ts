import { AgentRuntime } from '../../src/agent/runtime';
import { ConfigManager } from '../../src/agent/config/manager';

const chatMock = jest.fn();

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn(() => ({
    chat: chatMock,
    switchModel: jest.fn(),
    getModelName: () => 'm'
  }))
}));

const fakeModel = { name: 'm', provider: 'anthropic', model: 'm', apiKey: '' } as any;

describe('Session', () => {
  beforeEach(() => {
    jest.spyOn(ConfigManager.prototype, 'getActiveModel').mockReturnValue(fakeModel);
    jest.spyOn(ConfigManager.prototype, 'isEnabledInSource').mockReturnValue(true);
    chatMock.mockReset();
    chatMock.mockResolvedValue({ content: 'hello', usage: { inputTokens: 10, outputTokens: 2 } });
  });
  afterEach(() => jest.restoreAllMocks());

  async function makeRuntime() {
    return AgentRuntime.create({ workspaceDir: '/workspace', skipDefaultLoaders: true });
  }

  it('execute appends user message and returns assistant reply', async () => {
    const rt = await makeRuntime();
    const s = rt.createSession();
    const reply = await s.execute('hi');
    expect(reply).toBe('hello');
    expect(s.getMessageCount()).toBeGreaterThanOrEqual(2);
  });

  it('multiple execute calls share the same history', async () => {
    const rt = await makeRuntime();
    const s = rt.createSession();
    await s.execute('one');
    const beforeLen = s.getMessageCount();
    await s.execute('two');
    expect(s.getMessageCount()).toBeGreaterThan(beforeLen);
  });

  it('reset clears history and resets cumulative tokens but preserves systemPrompt', async () => {
    const rt = await makeRuntime();
    const s = rt.createSession();
    // 注入一个非空 systemPrompt 以便断言保留
    const mm: any = (s as any).messageManager;
    mm.systemPrompt = 'KEEP-ME';
    await s.execute('a');
    s.reset();
    expect(s.getMessageCount()).toBe(0);
    expect(s.getTokenUsage().totalTokens).toBe(0);
    expect(mm.getSystemPrompt()).toBe('KEEP-ME');
    await expect(s.execute('b')).resolves.toBeDefined();
  });
});
