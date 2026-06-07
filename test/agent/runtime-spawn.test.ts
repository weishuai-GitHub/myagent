import { AgentRuntime } from '../../src/agent/runtime';

const readSpy = jest.fn();
const existsSpy = jest.fn();

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: (...args: any[]) => {
      readSpy(...args);
      return (actual.readFileSync as any)(...args);
    },
    existsSync: (...args: any[]) => {
      existsSpy(...args);
      return (actual.existsSync as any)(...args);
    }
  };
});

jest.mock('../../src/agent/llm/factory', () => ({
  createLLMClient: jest.fn().mockReturnValue({ chat: jest.fn(), switchModel: jest.fn(), getModelName: () => 'm' })
}));

describe('AgentRuntime.spawnSubagent 0 disk I/O', () => {
  it('does not call fs.readFileSync/existsSync when spawning', async () => {
    const rt = await (AgentRuntime as any).create({ __testStubRegistry: true });
    readSpy.mockClear();
    existsSpy.mockClear();

    const child = rt.spawnSubagent({ name: 'x', source: 'home', tools: [], skills: [] } as any);
    expect(child).toBeDefined();
    expect(readSpy).not.toHaveBeenCalled();
    expect(existsSpy).not.toHaveBeenCalled();
  });
});
