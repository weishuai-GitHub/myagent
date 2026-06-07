import { AgentRuntime } from '../../src/agent/runtime';
import { ConfigManager } from '../../src/agent/config/manager';

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn().mockReturnValue({
    chat: jest.fn().mockResolvedValue({ content: 'r', usage: { inputTokens: 1, outputTokens: 1 } }),
    switchModel: jest.fn(),
    getModelName: () => 'm'
  })
}));

const fakeModel = { name: 'm', provider: 'anthropic', model: 'm', apiKey: '' } as any;

describe('AgentRuntime', () => {
  beforeEach(() => {
    jest.spyOn(ConfigManager.prototype, 'getActiveModel').mockReturnValue(fakeModel);
  });
  afterEach(() => jest.restoreAllMocks());

  it('create with skipDefaultLoaders builds an empty runtime', async () => {
    const rt = await AgentRuntime.create({ workspaceDir: '/workspace', skipDefaultLoaders: true });
    expect(rt).toBeInstanceOf(AgentRuntime);
    expect(rt.depth).toBe(0);
    expect(rt.workspaceDir).toBe('/workspace');
  });

  it('throws when no active model is configured', async () => {
    (ConfigManager.prototype.getActiveModel as jest.Mock).mockReturnValueOnce(null);
    await expect(AgentRuntime.create({ skipDefaultLoaders: true })).rejects.toThrow(/No active model/);
  });

  it('createSession returns Session instance', async () => {
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    const s = rt.createSession();
    expect(s).toBeDefined();
  });

  it('spawnSubagent increments depth and shares client', async () => {
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    const child = rt.spawnSubagent({ name: 'x', source: 'home', tools: [], skills: [] } as any);
    expect(child.depth).toBe(1);
    expect(child.client).toBe(rt.client);
  });

  it('spawnSubagent throws beyond MAX_DEPTH', async () => {
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    (rt as any).depth = 3;
    expect(() => rt.spawnSubagent({ name: 'x', source: 'home', tools: [], skills: [] } as any))
      .toThrow(/depth exceeded/);
  });

  it('switchModel delegates to client', async () => {
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    rt.switchModel('new');
    expect(rt.client.switchModel).toHaveBeenCalledWith('new');
  });
});
