import { AgentRuntime } from '../../src/agent/index';
import { AgentLoader } from '../../src/agent/component/loader';
import { MessageManager } from '../../src/agent/message/MessageManager';

// Mock 子模块，避免触碰真实文件系统/网络
jest.mock('../../src/agent/component/loader');
jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn().mockReturnValue({
    chat: jest.fn(),
    switchModel: jest.fn(),
    getModelName: jest.fn().mockReturnValue('test-model')
  })
}));

describe('AgentRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    (AgentLoader as jest.Mock).mockImplementation(() => ({
      load: jest.fn().mockReturnValue({
        agentPrompt: 'Test prompt',
        tools: [],
        skills: [],
        subagents: []
      }),
      discoverComponents: jest.fn().mockReturnValue({
        tools: [],
        skills: [],
        subagents: []
      }),
      getBaseDir: jest.fn().mockReturnValue('/test/myagent')
    }));
  });

  it('should initialize with workspace directory', () => {
    const runtime = new AgentRuntime('/workspace');
    expect(runtime).toBeInstanceOf(AgentRuntime);
    expect(runtime.isInitialized()).toBe(false);
  });

  it('should throw error when initializing without active model', async () => {
    const runtime = new AgentRuntime('/workspace');
    // 强制 getActiveModel 返回 null
    jest.spyOn(runtime.configManager, 'getActiveModel').mockReturnValue(null as any);

    const messageManager = new MessageManager();
    await expect(runtime.initialize(messageManager)).rejects.toThrow('No active model configured');
  });

  it('should throw error when execute is called before initialize', async () => {
    const runtime = new AgentRuntime('/workspace');
    const messageManager = new MessageManager();
    await expect(runtime.execute(messageManager, '/workspace')).rejects.toThrow(
      'AgentRuntime not initialized'
    );
  });

  it('should return config path from loader', () => {
    const runtime = new AgentRuntime('/workspace');
    const configPath = runtime.getConfigPath();
    expect(typeof configPath).toBe('string');
    expect(configPath).toBe('/test/myagent');
  });

  it('should return empty config path when loader is null', () => {
    const runtime = new AgentRuntime('/workspace');
    // 模拟 loader 被清空的极端情况
    (runtime as any).loader = null;
    expect(runtime.getConfigPath()).toBe('');
  });

  it('should report not initialized before initialize is called', () => {
    const runtime = new AgentRuntime('/workspace');
    expect(runtime.isInitialized()).toBe(false);
  });

  it('should return empty discovered components when loader is null', () => {
    const runtime = new AgentRuntime('/workspace');
    (runtime as any).loader = null;
    const components = runtime.getDiscoveredComponents();
    expect(components).toEqual({ tools: [], skills: [], subagents: [] });
  });

  describe('runSubagent', () => {
    it('should throw when subagent not found', async () => {
      const runtime = new AgentRuntime('/workspace');
      await expect(
        (runtime as any).runSubagent('missing', 'do something', [])
      ).rejects.toThrow("Subagent missing not found");
    });

    it('should throw when recursion depth exceeded', async () => {
      // 直接构造一个已经达到深度上限的 runtime
      const deepRuntime = new AgentRuntime('/workspace', { subagentDepth: 3 });
      const fakeSub = {
        name: 'self',
        description: '',
        agentPrompt: 'subagent prompt',
        tools: [],
        skills: [],
        source: 'home' as const,
        subAgentPath: '/fake/subagents/self'
      };
      await expect(
        (deepRuntime as any).runSubagent('self', 'q', [fakeSub])
      ).rejects.toThrow(/Subagent recursion depth exceeded/);
    });
  });
});
