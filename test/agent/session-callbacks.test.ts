import { AgentRuntime } from '../../src/agent/runtime';

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn().mockReturnValue({
    chat: jest.fn().mockResolvedValue({ content: 'ok', usage: { inputTokens: 1, outputTokens: 1 } }),
    switchModel: jest.fn(),
    getModelName: () => 'm'
  })
}));

describe('Session callbacks', () => {
  it('onTokenUsage fires once per execute', async () => {
    const rt = await (AgentRuntime as any).create({ __testStubRegistry: true });
    const onTokenUsage = jest.fn();
    const s = rt.createSession({ callbacks: { onTokenUsage } });
    await s.execute('a');
    await s.execute('b');
    expect(onTokenUsage).toHaveBeenCalledTimes(2);
  });
});
