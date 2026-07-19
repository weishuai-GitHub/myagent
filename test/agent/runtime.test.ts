import { AgentRuntime } from '../../src/agent/runtime';
import { ConfigManager } from '../../src/agent/config/manager';
import { ComponentLoader } from '../../src/agent/component/loader-types';
import { Skill, Subagent, Tool } from '../../src/agent/component/types';
import { createLLMClient } from '../../src/agent/llm/factory';

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn().mockReturnValue({
    chat: jest.fn().mockResolvedValue({ content: 'r', usage: { inputTokens: 1, outputTokens: 1 } }),
    switchModel: jest.fn(),
    getModelName: () => 'm'
  })
}));

const fakeModel = { name: 'm', provider: 'anthropic', model: 'm', apiKey: '' } as any;

function makeTool(name: string, source: 'home' | 'workspace'): Tool {
  return { name, source, description: name, parameters: {}, execute: async () => name };
}

function makeSkill(name: string, source: 'home' | 'workspace'): Skill {
  return { name, source, path: `/p/${name}`, description: name, content: name };
}

function makeSubagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    name: 'reviewer',
    description: 'review',
    agentPrompt: 'prompt',
    tools: [],
    skills: [],
    disallowedTools: [],
    disallowedSkills: [],
    model: 'inherit',
    allowWorkspaceComponents: false,
    source: 'home',
    subAgentPath: '/sub/reviewer',
    ...overrides
  };
}

class MixedLoader implements ComponentLoader {
  readonly name = 'mixed';
  async loadTools(map: Map<string, Tool>) {
    map.set('home-read', makeTool('home-read', 'home'));
    map.set('home-write', makeTool('home-write', 'home'));
    map.set('ws-build', makeTool('ws-build', 'workspace'));
  }
  async loadSkills(map: Map<string, Skill>) {
    map.set('home-review', makeSkill('home-review', 'home'));
    map.set('ws-ship', makeSkill('ws-ship', 'workspace'));
  }
  async loadSubagents(map: Map<string, Subagent>) {
    map.set('reviewer', makeSubagent());
  }
}

describe('AgentRuntime', () => {
  beforeEach(() => {
    jest.spyOn(ConfigManager.prototype, 'getActiveModel').mockReturnValue(fakeModel);
    jest.spyOn(ConfigManager.prototype, 'setActiveModel').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('create with skipDefaultLoaders builds an empty runtime', async () => {
    const rt = await AgentRuntime.create({ workspaceDir: '/workspace', skipDefaultLoaders: true });
    expect(rt).toBeInstanceOf(AgentRuntime);
    expect(rt.depth).toBe(0);
    expect(rt.workspaceDir).toBe('/workspace');
  });

  it('creates a recoverable runtime when no active model is configured', async () => {
    (ConfigManager.prototype.getActiveModel as jest.Mock).mockReturnValueOnce(null);
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });

    await expect(rt.client.chat([], { systemPrompt: '' })).rejects.toThrow(/No active model/);
    expect(rt.getActiveModelName()).toBe('m');
  });

  it('createSession returns Session instance', async () => {
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    const s = rt.createSession();
    expect(s).toBeDefined();
  });

  it('reload without arguments preserves the workspace directory', async () => {
    const rt = await AgentRuntime.create({ workspaceDir: '/workspace', skipDefaultLoaders: true });

    await rt.reload();

    expect(rt.workspaceDir).toBe('/workspace');
    expect(rt.config.getWorkspaceMyAgentDir()).toBe('/workspace/.myagent');
  });

  it('reload preserves custom component loaders', async () => {
    const rt = await AgentRuntime.create({
      workspaceDir: '/workspace',
      skipDefaultLoaders: true,
      extraLoaders: [new MixedLoader()]
    });
    expect(rt.registry.findTool('home-read')).toBeDefined();

    await rt.reload();

    expect(rt.registry.findTool('home-read')).toBeDefined();
    expect(rt.registry.findSkill('ws-ship')).toBeDefined();
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

  it('switchModel rebuilds the client from the named model configuration', async () => {
    const nextModel = {
      name: 'new',
      provider: 'openai',
      model: 'gpt-test',
      auth: 'codex',
      apiKey: '',
      baseUrl: ''
    } as any;
    jest.spyOn(ConfigManager.prototype, 'getAvailableModels').mockReturnValue([fakeModel, nextModel]);
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    rt.switchModel('new');
    expect(createLLMClient).toHaveBeenLastCalledWith(nextModel);
    expect(ConfigManager.prototype.setActiveModel).toHaveBeenCalledWith('new');
  });

  it('switchModel rejects unknown configuration names', async () => {
    jest.spyOn(ConfigManager.prototype, 'getAvailableModels').mockReturnValue([fakeModel]);
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true });
    expect(() => rt.switchModel('missing')).toThrow('Unknown model configuration');
  });

  it('spawnSubagent defaults to home-only components', async () => {
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true, extraLoaders: [new MixedLoader()] });
    const child = rt.spawnSubagent(makeSubagent());

    expect(child.registry.listTools().map(t => t.name).sort()).toEqual(['home-read', 'home-write']);
    expect(child.registry.listSkills().map(s => s.name)).toEqual(['home-review']);
  });

  it('spawnSubagent can explicitly allow workspace components', async () => {
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true, extraLoaders: [new MixedLoader()] });
    const child = rt.spawnSubagent(makeSubagent({ allowWorkspaceComponents: true }));

    expect(child.registry.listTools().map(t => t.name).sort()).toEqual(['home-read', 'home-write', 'ws-build']);
    expect(child.registry.listSkills().map(s => s.name).sort()).toEqual(['home-review', 'ws-ship']);
  });

  it('spawnSubagent applies allow lists before deny lists', async () => {
    const rt = await AgentRuntime.create({ skipDefaultLoaders: true, extraLoaders: [new MixedLoader()] });
    const child = rt.spawnSubagent(makeSubagent({
      allowWorkspaceComponents: true,
      tools: ['home-read', 'home-write', 'ws-build'],
      skills: ['home-review', 'ws-ship'],
      disallowedTools: ['home-write', 'ws-build'],
      disallowedSkills: ['ws-ship']
    }));

    expect(child.registry.listTools().map(t => t.name)).toEqual(['home-read']);
    expect(child.registry.listSkills().map(s => s.name)).toEqual(['home-review']);
  });
});
