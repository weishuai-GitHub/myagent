import { AgentRuntime } from '../../src/agent/runtime';
import { ConfigManager } from '../../src/agent/config/manager';
import { ComponentLoader } from '../../src/agent/component/loader-types';

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn().mockReturnValue({ chat: jest.fn(), switchModel: jest.fn(), getModelName: () => 'm' })
}));

const fakeModel = { name: 'm', provider: 'anthropic', model: 'm', apiKey: '' } as any;

describe('AgentRuntime.spawnSubagent does not re-invoke loaders', () => {
  beforeEach(() => {
    jest.spyOn(ConfigManager.prototype, 'getActiveModel').mockReturnValue(fakeModel);
  });
  afterEach(() => jest.restoreAllMocks());

  it('extraLoaders called exactly once during create and zero times during spawn', async () => {
    const loadTools = jest.fn(async (_m: Map<string, any>) => {});
    const loadSkills = jest.fn(async (_m: Map<string, any>) => {});
    const loadSubagents = jest.fn(async (m: Map<string, any>) => {
      m.set('x', { name: 'x', source: 'home', tools: [], skills: [] });
    });
    const loader: ComponentLoader = { name: 'fake', loadTools, loadSkills, loadSubagents };

    const rt = await AgentRuntime.create({ skipDefaultLoaders: true, extraLoaders: [loader] });
    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadSkills).toHaveBeenCalledTimes(1);
    expect(loadSubagents).toHaveBeenCalledTimes(1);

    const child = rt.spawnSubagent({ name: 'x', source: 'home', tools: [], skills: [] } as any);
    expect(child).toBeDefined();

    // 关键断言：派生 child runtime 不应再次调用任何 loader（纯内存派生）
    expect(loadTools).toHaveBeenCalledTimes(1);
    expect(loadSkills).toHaveBeenCalledTimes(1);
    expect(loadSubagents).toHaveBeenCalledTimes(1);
  });
});
