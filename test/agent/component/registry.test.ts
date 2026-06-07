/// <reference types="jest" />
/// <reference types="node" />
import { Tool, Skill, Subagent, ComponentSource } from '../../../src/agent/component/types';
import { ComponentLoader } from '../../../src/agent/component/loader-types';
import { ComponentRegistry } from '../../../src/agent/component/registry';

function makeTool(name: string, source: ComponentSource): Tool {
  return {
    name,
    description: `desc-${name}`,
    parameters: {},
    source,
    execute: async () => null,
  };
}

function makeSkill(name: string, source: ComponentSource): Skill {
  return {
    name,
    path: `/p/${name}`,
    description: `desc-${name}`,
    content: 'body',
    source,
  };
}

function makeSubagent(name: string, source: ComponentSource): Subagent {
  return {
    name,
    description: `desc-${name}`,
    agentPrompt: 'prompt',
    tools: [],
    skills: [],
    source,
    subAgentPath: `/p/${name}`,
  };
}

class StubLoader implements ComponentLoader {
  public readonly agentPrompt?: string;
  constructor(
    public readonly name: string,
    private readonly tools: Tool[] = [],
    private readonly skills: Skill[] = [],
    private readonly subagents: Subagent[] = [],
    agentPrompt?: string
  ) {
    this.agentPrompt = agentPrompt;
  }

  async loadTools(map: Map<string, Tool>): Promise<void> {
    for (const t of this.tools) map.set(t.name, t);
  }
  async loadSkills(map: Map<string, Skill>): Promise<void> {
    for (const s of this.skills) map.set(s.name, s);
  }
  async loadSubagents(map: Map<string, Subagent>): Promise<void> {
    for (const a of this.subagents) map.set(a.name, a);
  }
}

describe('ComponentRegistry', () => {
  test('load applies loaders in order; later loader overrides earlier', async () => {
    const homeLoader = new StubLoader(
      'home',
      [makeTool('shared', 'home'), makeTool('home-only', 'home')],
      [makeSkill('skill-h', 'home')],
      [makeSubagent('agent-h', 'home')]
    );
    const wsLoader = new StubLoader(
      'workspace',
      [makeTool('shared', 'workspace'), makeTool('ws-only', 'workspace')],
      [makeSkill('skill-w', 'workspace')],
      [makeSubagent('agent-w', 'workspace')]
    );

    const registry = await ComponentRegistry.load([homeLoader, wsLoader]);

    expect(registry.findTool('shared')?.source).toBe('workspace');
    expect(registry.findTool('home-only')?.source).toBe('home');
    expect(registry.findTool('ws-only')?.source).toBe('workspace');
    expect(registry.listTools()).toHaveLength(3);
    expect(registry.listSkills()).toHaveLength(2);
    expect(registry.listSubagents()).toHaveLength(2);
  });

  test('filterHomeOnly returns a new registry containing only home-sourced items', async () => {
    const homeLoader = new StubLoader(
      'home',
      [makeTool('t-home', 'home')],
      [makeSkill('s-home', 'home')],
      [makeSubagent('a-home', 'home')]
    );
    const wsLoader = new StubLoader(
      'workspace',
      [makeTool('t-ws', 'workspace')],
      [makeSkill('s-ws', 'workspace')],
      [makeSubagent('a-ws', 'workspace')]
    );
    const registry = await ComponentRegistry.load([homeLoader, wsLoader]);
    const homeOnly = registry.filterHomeOnly();

    expect(homeOnly.listTools().map(t => t.name)).toEqual(['t-home']);
    expect(homeOnly.listSkills().map(s => s.name)).toEqual(['s-home']);
    expect(homeOnly.listSubagents().map(a => a.name)).toEqual(['a-home']);
    // Original registry untouched
    expect(registry.listTools()).toHaveLength(2);
  });

  test('filter applies per-category whitelist', async () => {
    const loader = new StubLoader(
      'home',
      [makeTool('t1', 'home'), makeTool('t2', 'home'), makeTool('t3', 'home')],
      [makeSkill('s1', 'home'), makeSkill('s2', 'home')],
      [makeSubagent('a1', 'home'), makeSubagent('a2', 'home')]
    );
    const registry = await ComponentRegistry.load([loader]);
    const filtered = registry.filter({
      tools: ['t1', 't3'],
      skills: ['s2'],
      subagents: [],
    });

    expect(filtered.listTools().map(t => t.name).sort()).toEqual(['t1', 't3']);
    expect(filtered.listSkills().map(s => s.name)).toEqual(['s2']);
    expect(filtered.listSubagents()).toEqual([]);
  });

  test('load aggregates agentPrompt with later loader overriding earlier non-empty', async () => {
    const homeLoader = new StubLoader('home', [], [], [], 'HOME-PROMPT');
    const wsLoader = new StubLoader('workspace', [], [], [], 'WS-PROMPT');
    const reg = await ComponentRegistry.load([homeLoader, wsLoader]);
    expect(reg.agentPrompt).toBe('WS-PROMPT');
  });

  test('load keeps earlier agentPrompt when later loader has none', async () => {
    const homeLoader = new StubLoader('home', [], [], [], 'HOME-PROMPT');
    const wsLoader = new StubLoader('workspace', [], [], [], '');
    const reg = await ComponentRegistry.load([homeLoader, wsLoader]);
    expect(reg.agentPrompt).toBe('HOME-PROMPT');
  });

  test('omitted filter categories pass through unchanged', async () => {
    const loader = new StubLoader(
      'home',
      [makeTool('t1', 'home'), makeTool('t2', 'home')],
      [makeSkill('s1', 'home'), makeSkill('s2', 'home')],
      [makeSubagent('a1', 'home')]
    );
    const registry = await ComponentRegistry.load([loader]);
    const filtered = registry.filter({ tools: ['t1'] });

    expect(filtered.listTools().map(t => t.name)).toEqual(['t1']);
    expect(filtered.listSkills()).toHaveLength(2);
    expect(filtered.listSubagents()).toHaveLength(1);
  });
});
