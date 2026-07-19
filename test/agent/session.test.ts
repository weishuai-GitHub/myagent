import { AgentRuntime } from '../../src/agent/runtime';
import { ConfigManager } from '../../src/agent/config/manager';
import { ComponentLoader } from '../../src/agent/component/loader-types';
import { Skill } from '../../src/agent/component/types';

const chatMock = jest.fn();

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn(() => ({
    chat: chatMock,
    switchModel: jest.fn(),
    getModelName: () => 'm'
  }))
}));

const fakeModel = { name: 'm', provider: 'anthropic', model: 'm', apiKey: '' } as any;

class StubSkillLoader implements ComponentLoader {
  readonly name = 'stub-skill';

  async loadSkills(skills: Map<string, Skill>) {
    skills.set('inspect', {
      name: 'inspect',
      description: 'inspect',
      source: 'home',
      path: '/tmp/inspect/SKILL.md',
      content: 'inspection result'
    });
  }
}

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
    expect((s as any).messageManager.getMessages()).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' }
    ]);
  });

  it('multiple execute calls share the same history', async () => {
    const rt = await makeRuntime();
    const s = rt.createSession();
    await s.execute('one');
    const beforeLen = s.getMessageCount();
    await s.execute('two');
    expect(beforeLen).toBe(2);
    expect(s.getMessageCount()).toBe(4);
  });

  it('restores persisted history before sending the next model request', async () => {
    const rt = await makeRuntime();
    const s = rt.createSession();
    s.restoreHistory([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' }
    ]);

    await s.execute('continue');

    expect(chatMock.mock.calls[0][0]).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'continue' }
    ]);
    expect(s.getHistorySnapshot().items.map(({ role, content }: any) => ({ role, content }))).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'hello' }
    ]);
  });

  it('rolls back the complete turn when a later model round fails', async () => {
    chatMock
      .mockResolvedValueOnce({
        content: '<skill>inspect</skill>',
        usage: { inputTokens: 1, outputTokens: 1 }
      })
      .mockRejectedValueOnce(new Error('second round failed'));
    const rt = await AgentRuntime.create({
      workspaceDir: '/workspace',
      skipDefaultLoaders: true,
      extraLoaders: [new StubSkillLoader()]
    });
    const s = rt.createSession();

    await expect(s.execute('inspect this')).rejects.toThrow('second round failed');
    expect((s as any).messageManager.getMessages()).toEqual([]);
  });

  it('rejects concurrent execute calls on the same session', async () => {
    let resolveFirst!: (value: any) => void;
    chatMock.mockImplementationOnce(() => new Promise(resolve => {
      resolveFirst = resolve;
    }));
    const rt = await makeRuntime();
    const s = rt.createSession();

    const first = s.execute('first');
    await Promise.resolve();
    await expect(s.execute('second')).rejects.toThrow('已有任务正在执行');

    resolveFirst({ content: 'done', usage: { inputTokens: 1, outputTokens: 1 } });
    await expect(first).resolves.toBe('done');
    expect(s.getMessageCount()).toBe(2);
  });

  it('cancels the active model request and rolls back the turn', async () => {
    chatMock.mockImplementationOnce(
      (_messages: unknown, _options: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })
    );
    const rt = await makeRuntime();
    const s = rt.createSession();

    const execution = s.execute('cancel me');
    await Promise.resolve();
    expect(s.cancel()).toBe(true);

    await expect(execution).rejects.toThrow('用户已取消');
    expect(s.getMessageCount()).toBe(0);
    expect(s.cancel()).toBe(false);
  });

  it('passes agentPromptOverride into executor system prompt', async () => {
    const rt = await makeRuntime();
    const s = rt.createSession({ agentPromptOverride: 'CHILD-SP' });
    await s.execute('go');
    expect(chatMock).toHaveBeenCalled();
    const opts = chatMock.mock.calls[0][1];
    expect(opts.systemPrompt).toBe('CHILD-SP');
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
