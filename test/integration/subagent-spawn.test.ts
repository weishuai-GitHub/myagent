/// <reference types="jest" />
/// <reference types="node" />
import { AgentRuntime } from '../../src/agent/runtime';
import { ConfigManager } from '../../src/agent/config/manager';
import { ComponentLoader } from '../../src/agent/component/loader-types';
import { Subagent, Tool } from '../../src/agent/component/types';
import { createLLMClient } from '../../src/agent/llm/factory';

const chatMock = jest.fn();

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn(() => ({
    chat: chatMock,
    switchModel: jest.fn(),
    getModelName: () => 'm'
  }))
}));

const fakeModel = { name: 'm', provider: 'anthropic', model: 'm', apiKey: '' } as any;
const reviewerModel = { name: 'reviewer-model', provider: 'openai', model: 'reviewer-model', apiKey: '', baseUrl: 'https://example.test' } as any;

const fakeSub: Subagent = {
  name: 'echo',
  description: 'echo sub',
  agentPrompt: 'CHILD-SP',
  tools: [],
  skills: [],
  disallowedTools: [],
  disallowedSkills: [],
  model: 'inherit',
  allowWorkspaceComponents: false,
  source: 'home',
  subAgentPath: '/sub/echo'
};

const fakeTool: Tool = {
  name: 'noop',
  description: 'noop tool',
  parameters: {},
  source: 'home',
  execute: async () => 'ok'
};

class StubLoader implements ComponentLoader {
  readonly name = 'stub';
  async loadTools(m: Map<string, Tool>) { m.set(fakeTool.name, fakeTool); }
  async loadSubagents(m: Map<string, Subagent>) { m.set(fakeSub.name, fakeSub); }
}

describe('integration: subagent spawn', () => {
  beforeEach(() => {
    jest.spyOn(ConfigManager.prototype, 'getActiveModel').mockReturnValue(fakeModel);
    jest.spyOn(ConfigManager.prototype, 'getAvailableModels').mockReturnValue([fakeModel, reviewerModel]);
    jest.spyOn(ConfigManager.prototype, 'isEnabledInSource').mockReturnValue(true);
    chatMock.mockReset();
    (createLLMClient as jest.Mock).mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it('parent → child session forwards onToolCall and uses child agentPrompt', async () => {
    chatMock
      // 父 session 第一次回复：调用 subagent echo
      .mockResolvedValueOnce({
        content: '<subagent><name>echo</name><question>hi</question></subagent>',
        usage: { inputTokens: 1, outputTokens: 1 }
      })
      // 子 session：直接给最终回复
      .mockResolvedValueOnce({
        content: 'child-reply',
        usage: { inputTokens: 2, outputTokens: 2 }
      })
      // 父 session 收到 subagent 结果后给最终回复
      .mockResolvedValueOnce({
        content: 'done',
        usage: { inputTokens: 3, outputTokens: 3 }
      });

    const rt = await AgentRuntime.create({
      workspaceDir: '/workspace',
      skipDefaultLoaders: true,
      extraLoaders: [new StubLoader()]
    });

    const onToolCall = jest.fn();
    const onTokenUsage = jest.fn();
    const s = rt.createSession({ callbacks: { onToolCall, onTokenUsage } });
    const reply = await s.execute('please call sub');

    expect(typeof reply).toBe('string');
    // 子 session 的 subagent 调用应该被父回调捕获（透传）
    const subagentCalls = onToolCall.mock.calls
      .map(c => c[0])
      .filter(s => s.type === 'subagent' && s.name === 'echo');
    expect(subagentCalls.length).toBeGreaterThanOrEqual(1);

    // 子 session 使用了 sub.agentPrompt 作为 systemPrompt
    const childChat = chatMock.mock.calls[1];
    expect(childChat[1].systemPrompt).toBe('CHILD-SP');
    expect(s.getTokenUsage()).toEqual({
      inputTokens: 6,
      outputTokens: 6,
      totalTokens: 12
    });
    expect(onTokenUsage).toHaveBeenLastCalledWith({
      inputTokens: 6,
      outputTokens: 6
    });
  });

  it('respects MAX_SUBAGENT_DEPTH (=3) and throws on excess', async () => {
    const rt = await AgentRuntime.create({
      workspaceDir: '/workspace',
      skipDefaultLoaders: true,
      extraLoaders: [new StubLoader()]
    });
    const d1 = rt.spawnSubagent(fakeSub);
    const d2 = d1.spawnSubagent(fakeSub);
    const d3 = d2.spawnSubagent(fakeSub);
    expect(() => d3.spawnSubagent(fakeSub)).toThrow(/depth/);
  });

  it('uses subagent maxRounds for the child session', async () => {
    const subWithMaxRounds: Subagent = { ...fakeSub, maxRounds: 1, tools: ['noop'] };
    class MaxRoundsLoader extends StubLoader {
      async loadSubagents(m: Map<string, Subagent>) { m.set(subWithMaxRounds.name, subWithMaxRounds); }
    }

    chatMock
      .mockResolvedValueOnce({
        content: '<subagent><name>echo</name><question>hi</question></subagent>',
        usage: { inputTokens: 1, outputTokens: 1 }
      })
      .mockResolvedValueOnce({
        content: '<tool><name>noop</name><args>{}</args></tool>',
        usage: { inputTokens: 2, outputTokens: 2 }
      })
      .mockResolvedValueOnce({
        content: 'parent-final',
        usage: { inputTokens: 3, outputTokens: 3 }
      });

    const rt = await AgentRuntime.create({
      workspaceDir: '/workspace',
      skipDefaultLoaders: true,
      extraLoaders: [new MaxRoundsLoader()]
    });

    const reply = await rt.createSession().execute('please call sub');

    expect(reply).toBe('parent-final');
    expect(chatMock).toHaveBeenCalledTimes(3);
  });

  it('creates a child client from a configured subagent model', async () => {
    const subWithModel: Subagent = { ...fakeSub, model: 'reviewer-model' };
    class ModelLoader extends StubLoader {
      async loadSubagents(m: Map<string, Subagent>) { m.set(subWithModel.name, subWithModel); }
    }

    chatMock
      .mockResolvedValueOnce({
        content: '<subagent><name>echo</name><question>hi</question></subagent>',
        usage: { inputTokens: 1, outputTokens: 1 }
      })
      .mockResolvedValueOnce({
        content: 'child-reply',
        usage: { inputTokens: 2, outputTokens: 2 }
      })
      .mockResolvedValueOnce({
        content: 'done',
        usage: { inputTokens: 3, outputTokens: 3 }
      });

    const rt = await AgentRuntime.create({
      workspaceDir: '/workspace',
      skipDefaultLoaders: true,
      extraLoaders: [new ModelLoader()]
    });

    await rt.createSession().execute('please call sub');

    expect(createLLMClient).toHaveBeenCalledWith(reviewerModel);
  });
});
