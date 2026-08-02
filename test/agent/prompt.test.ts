/// <reference types="jest" />
/// <reference types="node" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleSystemPrompt } from '../../src/agent/prompt/assembler';
import { stripMarkdownFrontmatter } from '../../src/agent/prompt/file-loader';
import { loadProjectPrompt } from '../../src/agent/prompt/project-loader';

describe('prompt assembly', () => {
  it('assembles every context layer in a stable order', () => {
    const prompt = assembleSystemPrompt({
      frameworkPrompt: 'FRAMEWORK',
      agentPrompt: 'AGENT at ${workspace}',
      projectPrompt: 'PROJECT at ${workspace}',
      componentPrompt: 'COMPONENTS',
      workspaceDir: '/work/project'
    });

    const headings = [
      '## MyAgent 运行时协议',
      '## Agent 定义',
      '## 项目定义',
      '## 可用组件',
      '## 运行环境'
    ];
    const positions = headings.map(heading => prompt.indexOf(heading));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(prompt).toContain('AGENT at /work/project');
    expect(prompt).toContain('PROJECT at /work/project');
    expect(prompt).toContain('## 可用组件\n\nCOMPONENTS');
  });

  it('keeps legacy component placeholders compatible without duplicating the list', () => {
    const prompt = assembleSystemPrompt({
      frameworkPrompt: 'FRAMEWORK',
      agentPrompt: '组件：${components}',
      projectPrompt: '',
      componentPrompt: 'ONLY-COMPONENT-LIST',
      workspaceDir: ''
    });

    expect(prompt).not.toContain('${components}');
    expect(prompt).toContain('组件由运行时在下方“可用组件”章节提供');
    expect(prompt.match(/ONLY-COMPONENT-LIST/g)).toHaveLength(1);
    expect(prompt).toContain('工作目录: 未打开工作区');
  });
});

describe('project prompt loading', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-project-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads only the exact workspace root PROJECT.md and strips frontmatter', () => {
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'PROJECT.md'), [
      '---',
      'name: demo',
      '---',
      '# Demo project'
    ].join('\r\n'));

    expect(loadProjectPrompt(workspaceDir)).toBe('# Demo project');
  });

  it('returns an empty definition when the workspace file does not exist', () => {
    const workspaceDir = path.join(root, 'workspace');
    const workspaceAgentDir = path.join(workspaceDir, '.myagent');
    fs.mkdirSync(workspaceAgentDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceAgentDir, 'PROJECT.md'), 'legacy nested project');

    expect(loadProjectPrompt(workspaceDir)).toBe('');
    expect(loadProjectPrompt(null)).toBe('');
  });

  it('strips frontmatter while preserving files without frontmatter', () => {
    expect(stripMarkdownFrontmatter('plain')).toBe('plain');
    expect(stripMarkdownFrontmatter('---\r\nname: x\r\n---\r\nbody')).toBe('body');
  });
});
