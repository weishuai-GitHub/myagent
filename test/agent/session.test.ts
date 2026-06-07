import { Session } from '../../src/agent/session';
import { AgentRuntime } from '../../src/agent/runtime';

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn().mockReturnValue({
    chat: jest.fn().mockResolvedValue({ content: 'hello', usage: { inputTokens: 10, outputTokens: 2 } }),
    switchModel: jest.fn(),
    getModelName: () => 'm'
  })
}));

describe('Session', () => {
  async function makeRuntime() {
    return await (AgentRuntime as any).create({ workspaceDir: '/workspace', __testStubRegistry: true });
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

  it('reset clears history but keeps systemPrompt and resets cumulative tokens', async () => {
    const rt = await makeRuntime();
    const s = rt.createSession();
    await s.execute('a');
    s.reset();
    expect(s.getMessageCount()).toBe(0);
    expect(s.getTokenUsage().totalTokens).toBe(0);
    await expect(s.execute('b')).resolves.toBeDefined();
  });
});
