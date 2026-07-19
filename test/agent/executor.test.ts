import { AgentExecutor } from '../../src/agent/executor';
import { LLMClient } from '../../src/agent/llm';
import { AgentConfig } from '../../src/agent/component/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { executeTool, loadToolsFromDir } from '../../src/agent/component/tools/executor';
import { Tool, ToolContext } from '../../src/agent/component/tools/types';

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

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: 'reader',
    description: 'read a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', format: 'path' }
      },
      required: ['path'],
      additionalProperties: false
    },
    source: 'workspace',
    execute: async args => args,
    ...overrides
  };
}

function makeToolContext(workspaceDir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceDir,
    env: {},
    ...overrides
  };
}

describe('tool executor safety boundary', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-tool-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('validates arguments before invoking the tool', async () => {
    const execute = jest.fn();
    const tool = makeTool({ execute });

    await expect(executeTool([tool], tool.name, {}, makeToolContext(workspaceDir)))
      .rejects.toThrow('$.path is required');
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolves relative path arguments inside the workspace and scopes env', async () => {
    const execute = jest.fn(async (args, context) => ({
      path: args.path,
      env: context.env
    }));
    const tool = makeTool({
      permissions: {
        pathArguments: ['path'],
        env: ['SAFE_TOKEN']
      },
      execute
    });

    const output = await executeTool(
      [tool],
      tool.name,
      { path: 'src/a.ts' },
      makeToolContext(workspaceDir, {
        env: { SAFE_TOKEN: 'allowed', SECRET_TOKEN: 'hidden' }
      })
    );

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      data: {
        path: path.join(workspaceDir, 'src/a.ts'),
        env: { SAFE_TOKEN: 'allowed' }
      }
    });
  });

  it('rejects workspace-external paths unless the user approves once', async () => {
    const tool = makeTool();
    const requestApproval = jest.fn().mockResolvedValue(false);

    await expect(executeTool(
      [tool],
      tool.name,
      { path: path.dirname(workspaceDir) },
      makeToolContext(workspaceDir, { requestApproval })
    )).rejects.toThrow('cannot access path outside workspace');

    expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolName: tool.name,
      reason: expect.stringContaining('工作区外路径')
    }));
  });

  it('requires confirmation for inferred shell capability', async () => {
    const execute = jest.fn().mockResolvedValue('ok');
    const tool = makeTool({
      name: 'runCommand',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command']
      },
      execute
    });

    await expect(executeTool(
      [tool],
      tool.name,
      { command: 'pwd' },
      makeToolContext(workspaceDir)
    )).rejects.toThrow('was not approved');
    expect(execute).not.toHaveBeenCalled();
  });

  it('times out tools at the framework layer and aborts the signal', async () => {
    let signal: AbortSignal | undefined;
    const tool = makeTool({
      parameters: { type: 'object', properties: {} },
      timeoutMs: 10,
      execute: async (_args, context) => {
        signal = context.signal;
        return new Promise(() => undefined);
      }
    });

    await expect(executeTool([tool], tool.name, {}, makeToolContext(workspaceDir)))
      .rejects.toThrow('timed out after 10ms');
    expect(signal?.aborted).toBe(true);
  });

  it('returns a valid bounded JSON envelope for large output', async () => {
    const tool = makeTool({
      parameters: { type: 'object', properties: {} },
      maxOutputChars: 256,
      execute: async () => 'x'.repeat(2_000)
    });

    const output = await executeTool([tool], tool.name, {}, makeToolContext(workspaceDir));
    expect(output.length).toBeLessThanOrEqual(256);
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      meta: { truncated: true }
    });
  });

  it('honors disabled metadata and rejects missing entry files at discovery', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-loader-'));
    const disabledDir = path.join(baseDir, 'tools', 'disabled');
    const missingDir = path.join(baseDir, 'tools', 'missing');
    fs.mkdirSync(disabledDir, { recursive: true });
    fs.mkdirSync(missingDir, { recursive: true });
    fs.writeFileSync(path.join(disabledDir, 'metadata.json'), JSON.stringify({
      name: 'disabled',
      description: 'disabled',
      enabled: false,
      parameters: { type: 'object' }
    }));
    fs.writeFileSync(path.join(missingDir, 'metadata.json'), JSON.stringify({
      name: 'missing',
      description: 'missing',
      parameters: { type: 'object' }
    }));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const tools = new Map<string, Tool>();

    loadToolsFromDir(baseDir, 'workspace', tools);

    expect(tools.size).toBe(0);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load tool missing'),
      expect.any(Error)
    );
    error.mockRestore();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
