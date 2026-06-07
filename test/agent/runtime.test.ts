import { AgentRuntime } from '../../src/agent/runtime';

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn().mockReturnValue({
    chat: jest.fn().mockResolvedValue({ content: 'r', usage: { inputTokens: 1, outputTokens: 1 } }),
    switchModel: jest.fn(),
    getModelName: () => 'm'
  })
}));

describe('AgentRuntime', () => {
  it('create with __testStubRegistry skips real loaders', async () => {
    const rt = await (AgentRuntime as any).create({ workspaceDir: '/workspace', __testStubRegistry: true });
    expect(rt).toBeInstanceOf(AgentRuntime);
    expect(rt.depth).toBe(0);
    expect(rt.workspaceDir).toBe('/workspace');
  });

  it('createSession returns Session instance', async () => {
    const rt = await (AgentRuntime as any).create({ __testStubRegistry: true });
    const s = rt.createSession();
    expect(s).toBeDefined();
  });

  it('spawnSubagent increments depth and shares client', async () => {
    const rt = await (AgentRuntime as any).create({ __testStubRegistry: true });
    const child = rt.spawnSubagent({ name: 'x', source: 'home', tools: [], skills: [] } as any);
    expect(child.depth).toBe(1);
    expect(child.client).toBe(rt.client);
  });

  it('spawnSubagent throws beyond MAX_DEPTH', async () => {
    const rt = await (AgentRuntime as any).create({ __testStubRegistry: true });
    (rt as any).depth = 3;
    expect(() => rt.spawnSubagent({ name: 'x', source: 'home', tools: [], skills: [] } as any))
      .toThrow(/depth exceeded/);
  });

  it('switchModel delegates to client', async () => {
    const rt = await (AgentRuntime as any).create({ __testStubRegistry: true });
    rt.switchModel('new');
    expect(rt.client.switchModel).toHaveBeenCalledWith('new');
  });
});
