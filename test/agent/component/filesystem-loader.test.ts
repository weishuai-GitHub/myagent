/// <reference types="jest" />
/// <reference types="node" />
import { Tool, Skill, Subagent, ComponentSource } from '../../../src/agent/component/types';

jest.mock('../../../src/agent/component/tools/executor', () => ({
  loadToolsFromDir: jest.fn(),
}));
jest.mock('../../../src/agent/component/skills/loader', () => ({
  loadSkillsFromDir: jest.fn(),
}));
jest.mock('../../../src/agent/component/subagents/runner', () => ({
  loadSubagentsFromDir: jest.fn(),
}));

import { loadToolsFromDir } from '../../../src/agent/component/tools/executor';
import { loadSkillsFromDir } from '../../../src/agent/component/skills/loader';
import { loadSubagentsFromDir } from '../../../src/agent/component/subagents/runner';
import { FilesystemLoader } from '../../../src/agent/component/filesystem-loader';

const mockedLoadTools = loadToolsFromDir as jest.MockedFunction<typeof loadToolsFromDir>;
const mockedLoadSkills = loadSkillsFromDir as jest.MockedFunction<typeof loadSkillsFromDir>;
const mockedLoadSubagents = loadSubagentsFromDir as jest.MockedFunction<typeof loadSubagentsFromDir>;

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

describe('FilesystemLoader', () => {
  beforeEach(() => {
    mockedLoadTools.mockReset();
    mockedLoadSkills.mockReset();
    mockedLoadSubagents.mockReset();
  });

  describe('basic loading writes items with correct source', () => {
    test('loadTools delegates to loadToolsFromDir and populates the map', async () => {
      mockedLoadTools.mockImplementation((baseDir, source, map) => {
        map.set('t1', makeTool('t1', source));
      });
      const loader = new FilesystemLoader('/ws', 'workspace');
      const map = new Map<string, Tool>();
      await loader.loadTools!(map);
      expect(mockedLoadTools).toHaveBeenCalledWith('/ws', 'workspace', expect.any(Map));
      expect(map.get('t1')?.source).toBe('workspace');
    });

    test('loadSkills delegates to loadSkillsFromDir and populates the map', async () => {
      mockedLoadSkills.mockImplementation((baseDir, source, map) => {
        map.set('s1', makeSkill('s1', source));
      });
      const loader = new FilesystemLoader('/home', 'home');
      const map = new Map<string, Skill>();
      await loader.loadSkills!(map);
      expect(mockedLoadSkills).toHaveBeenCalledWith('/home', 'home', expect.any(Map));
      expect(map.get('s1')?.source).toBe('home');
    });

    test('loadSubagents delegates to loadSubagentsFromDir and populates the map', async () => {
      mockedLoadSubagents.mockImplementation((baseDir, source, map) => {
        map.set('a1', makeSubagent('a1', source));
      });
      const loader = new FilesystemLoader('/ws', 'workspace');
      const map = new Map<string, Subagent>();
      await loader.loadSubagents!(map);
      expect(mockedLoadSubagents).toHaveBeenCalledWith('/ws', 'workspace', expect.any(Map));
      expect(map.get('a1')?.source).toBe('workspace');
    });
  });

  describe('workspace overrides home in shared map', () => {
    test('workspace loader overrides existing home tool of the same name', async () => {
      const map = new Map<string, Tool>();
      map.set('shared', makeTool('shared', 'home'));

      mockedLoadTools.mockImplementation((baseDir, source, m) => {
        m.set('shared', makeTool('shared', source));
      });

      const loader = new FilesystemLoader('/ws', 'workspace');
      await loader.loadTools!(map);

      expect(map.get('shared')?.source).toBe('workspace');
    });
  });

  describe('loader name', () => {
    test('name reflects source', () => {
      expect(new FilesystemLoader('/ws', 'workspace').name).toBe('filesystem-workspace');
      expect(new FilesystemLoader('/h', 'home').name).toBe('filesystem-home');
    });
  });
});
