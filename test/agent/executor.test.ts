import { AgentExecutor } from '../../src/agent/executor';
import { LLMClient } from '../../src/agent/llm';
import { AgentConfig } from '../../src/agent/component/types';

function makeClient(responses: Array<{ content: string; usage?: any }>): LLMClient {
  const chat = jest.fn();
  for (const r of responses) chat.mockResolvedValueOnce(r);
  return {
    chat,
    switchModel: jest.fn(),
    getModelName: () => 'm'
  } as any;
}

const baseConfig: AgentConfig = {
  agentPrompt: 'SYS',
  tools: [],
  skills: [],
  subagents: []
};

const baseCtx = { env: {}, workspaceDir: '/w', availableComponents: '' };

describe('AgentExecutor', () => {
  it('returns text when LLM response has no XML calls', async () => {
    const client = makeClient([{ content: 'final answer', usage: { inputTokens: 1, outputTokens: 1 } }]);
    const exec = new AgentExecutor(
      client, baseConfig,
      async () => 'tool-ok',
      async () => 'skill-content',
      async () => 'sub-reply'
    );
    const out = await exec.run([], baseCtx, 5);
    expect(out).toBe('final answer');
  });

  it('dispatches tool/skill/subagent calls and feeds results back', async () => {
    const client = makeClient([
      { content: '<tool><name>t1</name><args></args></tool>', usage: { inputTokens: 1, outputTokens: 1 } },
      { content: '<skill>s1</skill>', usage: { inputTokens: 1, outputTokens: 1 } },
      { content: '<subagent><name>sa1</name><question>q?</question></subagent>', usage: { inputTokens: 1, outputTokens: 1 } },
      { content: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
    ]);
    const toolExec = jest.fn().mockResolvedValue('TR');
    const skillLoader = jest.fn().mockResolvedValue('SR');
    const subRun = jest.fn().mockResolvedValue('UR');

    const exec = new AgentExecutor(client, baseConfig, toolExec, skillLoader, subRun);
    const msgs: any[] = [];
    const out = await exec.run(msgs, baseCtx, 10);

    expect(out).toBe('done');
    expect(toolExec).toHaveBeenCalledWith('t1', expect.any(Object), baseCtx);
    expect(skillLoader).toHaveBeenCalledWith('s1');
    expect(subRun).toHaveBeenCalledWith('sa1', 'q?');
  });

  it('fires onToolCall callback for calling + success', async () => {
    const client = makeClient([
      { content: '<tool><name>t1</name><args></args></tool>', usage: { inputTokens: 1, outputTokens: 1 } },
      { content: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
    ]);
    const onToolCall = jest.fn();
    const exec = new AgentExecutor(client, baseConfig,
      async () => 'OK',
      async () => '',
      async () => '',
      onToolCall
    );
    await exec.run([], baseCtx, 5);
    const calls = onToolCall.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.name === 't1' && c.status === 'calling')).toBe(true);
    expect(calls.some(c => c.name === 't1' && c.status === 'success')).toBe(true);
  });

  it('fires onToolCall with error status when tool throws', async () => {
    const client = makeClient([
      { content: '<tool><name>t1</name><args></args></tool>', usage: { inputTokens: 1, outputTokens: 1 } },
      { content: 'done', usage: { inputTokens: 1, outputTokens: 1 } }
    ]);
    const onToolCall = jest.fn();
    const exec = new AgentExecutor(client, baseConfig,
      async () => { throw new Error('boom'); },
      async () => '',
      async () => '',
      onToolCall
    );
    await exec.run([], baseCtx, 5);
    const calls = onToolCall.mock.calls.map(c => c[0]);
    expect(calls.some(c => c.status === 'error' && c.error === 'boom')).toBe(true);
  });

  it('triggers onCompress with inputTokens after >5 messages', async () => {
    const client = makeClient([
      { content: 'done', usage: { inputTokens: 12345, outputTokens: 1 } }
    ]);
    const onCompress = jest.fn().mockResolvedValue(undefined);
    const exec = new AgentExecutor(client, baseConfig, async () => '', async () => '', async () => '');
    exec.setOnCompress(onCompress);
    const seed: any[] = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    await exec.run(seed, baseCtx, 3);
    expect(onCompress).toHaveBeenCalledWith(12345);
  });
});
