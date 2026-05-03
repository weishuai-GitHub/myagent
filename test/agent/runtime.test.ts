import { AgentRuntime } from '../../src/agent/index';
import { ConfigManager } from '../../src/config/manager';
import { AgentConfig, Tool, ToolContext } from '../../src/agent/types';
import { AgentLoader } from '../../src/agent/loader';

jest.mock('../../src/agent/loader');

describe('AgentRuntime', () => {
  let mockConfigManager: Partial<ConfigManager>;

  beforeEach(() => {
    mockConfigManager = {
      getActiveModel: jest.fn().mockReturnValue({
        name: 'test-model',
        provider: 'anthropic',
        model: 'claude-3-opus',
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com'
      }),
      getEnv: jest.fn().mockReturnValue({ TEST_VAR: 'test-value' }),
      getMaxRounds: jest.fn().mockReturnValue(5)
    };

    (AgentLoader as jest.Mock).mockImplementation(() => ({
      load: jest.fn().mockReturnValue({
        agentPrompt: 'Test prompt',
        tools: [],
        skills: [],
        subagents: []
      }),
      getBaseDir: jest.fn().mockReturnValue('/test/myagent')
    }));
  });

  it('should initialize with config manager', () => {
    const runtime = new AgentRuntime(mockConfigManager as ConfigManager);
    expect(runtime).toBeInstanceOf(AgentRuntime);
  });

  it('should throw error when no active model configured', async () => {
    mockConfigManager.getActiveModel = jest.fn().mockReturnValue(null);
    const runtime = new AgentRuntime(mockConfigManager as ConfigManager);

    await expect(runtime.execute('test task', '/workspace')).rejects.toThrow('No active model configured');
  });

  it('should get config path', () => {
    const runtime = new AgentRuntime(mockConfigManager as ConfigManager);
    const configPath = runtime.getConfigPath();
    expect(typeof configPath).toBe('string');
  });
});
