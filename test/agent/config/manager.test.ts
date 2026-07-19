import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConfigManager } from '../../../src/agent/config/manager';

jest.mock('fs');
jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: jest.fn(() => '/home/u')
  };
});

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedOs = os as jest.Mocked<typeof os>;

const HOME_DIR = '/home/u';
const WORKSPACE_DIR = '/workspace';
const HOME_MYAGENT = path.join(HOME_DIR, '.myagent');
const HOME_SETTINGS_PATH = path.join(HOME_MYAGENT, 'settings.json');
const WORKSPACE_MYAGENT = path.join(WORKSPACE_DIR, '.myagent');
const WORKSPACE_SETTINGS_PATH = path.join(WORKSPACE_MYAGENT, 'settings.json');

const makeSettings = (overrides: Partial<any> = {}) => ({
  models: [
    { name: 'm1', provider: 'anthropic', model: 'claude-x', apiKey: 'k', baseUrl: 'u' }
  ],
  activeModel: 'm1',
  enabledTools: [],
  enabledSkills: [],
  enabledSubagents: [],
  maxRounds: 10,
  env: {},
  ...overrides
});

describe('ConfigManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedOs.homedir.mockReturnValue(HOME_DIR);
  });

  /**
   * 配置 fs mock：传入指定路径 → 文件内容的 map。
   * existsSync 命中 true，readFileSync 返回 JSON 字符串。
   */
  const setupFs = (filesMap: Record<string, any>) => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => p.toString() in filesMap);
    mockedFs.readFileSync.mockImplementation((p: any) => {
      const key = p.toString();
      if (key in filesMap) {
        return JSON.stringify(filesMap[key]) as any;
      }
      throw new Error(`unexpected readFileSync(${key})`);
    });
  };

  describe('getActiveModel', () => {
    it('当 workspace settings 存在时优先返回 workspace 的 activeModel', () => {
      setupFs({
        [WORKSPACE_SETTINGS_PATH]: makeSettings({
          models: [
            { name: 'ws-model', provider: 'anthropic', model: 'claude-w', apiKey: 'k', baseUrl: 'u' }
          ],
          activeModel: 'ws-model'
        }),
        [HOME_SETTINGS_PATH]: makeSettings({
          models: [
            { name: 'home-model', provider: 'anthropic', model: 'claude-h', apiKey: 'k', baseUrl: 'u' }
          ],
          activeModel: 'home-model'
        })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      const active = cm.getActiveModel();
      expect(active?.name).toBe('ws-model');
    });
  });

  describe('getWorkspaceMyAgentDir', () => {
    it('在传入的工作区根目录下拼接 .myagent，与 home 对称', () => {
      setupFs({});
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(cm.getWorkspaceMyAgentDir()).toBe(WORKSPACE_MYAGENT);
    });

    it('homeOnly 时返回 null', () => {
      setupFs({});
      const cm = new ConfigManager(WORKSPACE_DIR, { homeOnly: true });
      expect(cm.getWorkspaceMyAgentDir()).toBeNull();
    });

    it('reloadBaseDir 未传参数时保留当前工作区', () => {
      setupFs({});
      const cm = new ConfigManager(WORKSPACE_DIR);

      cm.reloadBaseDir();

      expect(cm.getWorkspaceMyAgentDir()).toBe(WORKSPACE_MYAGENT);
    });
  });

  describe('getMaxRounds', () => {
    it('在 settings 缺失时默认 10', () => {
      setupFs({}); // 两个目录都不存在
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(cm.getMaxRounds()).toBe(10);
    });
  });

  describe('getEnv', () => {
    it('透传 primarySettings.env', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ env: { FOO: 'bar' } })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(cm.getEnv()).toEqual({ FOO: 'bar' });
    });
  });

  describe('getEnabledList', () => {
    it("返回 home settings 的 enabledTools", () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['t1', 't2'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(cm.getEnabledList('home', 'tools')).toEqual(['t1', 't2']);
    });
  });

  describe('isEnabledInSource', () => {
    it('空列表 → false', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: [] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(cm.isEnabledInSource('home', 'tools', 'a')).toBe(false);
    });

    it('["*"] → true', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['*'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(cm.isEnabledInSource('home', 'tools', 'anything')).toBe(true);
    });

    it('显式包含 → true', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['a'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(cm.isEnabledInSource('home', 'tools', 'a')).toBe(true);
    });

    it('不包含 → false', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['a'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(cm.isEnabledInSource('home', 'tools', 'b')).toBe(false);
    });
  });

  describe('setComponentEnabled', () => {
    it('enable name：list 为 [] 时 push 进去', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: [] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      cm.setComponentEnabled('home', 'tools', 'a', true);
      expect(cm.getEnabledList('home', 'tools')).toEqual(['a']);
    });

    it('enable name：list 为 ["*"] 时不变（已经全启用）', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['*'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      cm.setComponentEnabled('home', 'tools', 'a', true);
      expect(cm.getEnabledList('home', 'tools')).toEqual(['*']);
    });

    it('disable name：list 为 ["*"] 时抛错', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['*'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      expect(() => cm.setComponentEnabled('home', 'tools', 'a', false))
        .toThrow('Cannot disable a single component when wildcard "*" is active; expand the list first');
    });

    it('disable name：list 为 ["a","b"] 时变成 ["b"]', () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['a', 'b'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      cm.setComponentEnabled('home', 'tools', 'a', false);
      expect(cm.getEnabledList('home', 'tools')).toEqual(['b']);
    });
  });

  describe('expandWildcard', () => {
    it("把含 '*' 的列表替换为完整名字列表", () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['*'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      cm.expandWildcard('home', 'tools', ['a', 'b', 'c']);
      expect(cm.getEnabledList('home', 'tools')).toEqual(['a', 'b', 'c']);
    });
  });

  describe('loadSettings', () => {
    it('当 path 在 workspaceMyAgentDir 下时写入 workspaceSettings', async () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['home-t'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);
      // 此时 primary = home
      expect(cm.getEnabledList('workspace', 'tools')).toEqual([]);

      // 模拟 workspace settings 文件可读
      const wsSettings = makeSettings({ enabledTools: ['ws-t'] });
      mockedFs.readFileSync.mockImplementationOnce(() => JSON.stringify(wsSettings) as any);

      await cm.loadSettings(WORKSPACE_SETTINGS_PATH);
      expect(cm.getEnabledList('workspace', 'tools')).toEqual(['ws-t']);
      expect(cm.getConfigPath()).toBe(WORKSPACE_SETTINGS_PATH);
    });

    it('当 path 在 homeMyAgentDir 下时写入 homeSettings', async () => {
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings({ enabledTools: ['old'] })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);

      const newHomeSettings = makeSettings({ enabledTools: ['new'] });
      mockedFs.readFileSync.mockImplementationOnce(() => JSON.stringify(newHomeSettings) as any);

      await cm.loadSettings(HOME_SETTINGS_PATH);
      expect(cm.getEnabledList('home', 'tools')).toEqual(['new']);
      expect(cm.getConfigPath()).toBe(HOME_SETTINGS_PATH);
    });

    it('显式导入无效配置时返回包含文件与字段路径的诊断', async () => {
      setupFs({});
      const cm = new ConfigManager(WORKSPACE_DIR);
      mockedFs.readFileSync.mockImplementationOnce(() => JSON.stringify(
        makeSettings({ maxRounds: 0 })
      ) as any);

      await expect(cm.loadSettings('/tmp/broken-settings.json'))
        .rejects.toThrow('/tmp/broken-settings.json: maxRounds');
    });

    it('reloadBaseDir 后继续使用工作区外显式导入的配置', async () => {
      const importedPath = '/tmp/imported-settings.json';
      setupFs({
        [HOME_SETTINGS_PATH]: makeSettings(),
        [importedPath]: makeSettings({
          models: [{
            name: 'imported',
            provider: 'openai',
            model: 'gpt-imported',
            apiKey: 'k',
            baseUrl: 'u'
          }],
          activeModel: 'imported'
        })
      });
      const cm = new ConfigManager(WORKSPACE_DIR);

      await cm.loadSettings(importedPath);
      cm.reloadBaseDir();

      expect(cm.getConfigPath()).toBe(importedPath);
      expect(cm.getActiveModel()?.name).toBe('imported');
    });
  });

  it('启动加载遇到损坏配置时保留诊断而不是阻止运行时恢复', () => {
    setupFs({
      [WORKSPACE_SETTINGS_PATH]: makeSettings({ enabledTools: 'not-an-array' })
    });

    const cm = new ConfigManager(WORKSPACE_DIR);

    expect(cm.getSettings()).toBeNull();
    expect(cm.getDiagnostics()).toEqual([
      expect.objectContaining({
        filePath: WORKSPACE_SETTINGS_PATH,
        fieldPath: 'enabledTools'
      })
    ]);
  });

  it('activeModel 引用缺失模型时记录可恢复诊断并回退首个模型', () => {
    setupFs({
      [WORKSPACE_SETTINGS_PATH]: makeSettings({ activeModel: 'removed-model' })
    });

    const cm = new ConfigManager(WORKSPACE_DIR);

    expect(cm.getActiveModel()?.name).toBe('m1');
    expect(cm.getDiagnostics()).toEqual([
      expect.objectContaining({
        fieldPath: 'activeModel',
        message: expect.stringContaining('removed-model')
      })
    ]);
  });

  it('通过 SecretStore 引用为运行时模型补齐 apiKey', async () => {
    setupFs({
      [WORKSPACE_SETTINGS_PATH]: makeSettings({
        models: [{
          name: 'm1',
          provider: 'openai',
          model: 'gpt-test',
          apiKeyRef: 'myagent.models.m1.apiKey',
          baseUrl: 'https://api.example.test/v1'
        }]
      })
    });
    const cm = new ConfigManager(WORKSPACE_DIR);
    const secretStore = {
      get: jest.fn().mockResolvedValue('resolved-secret'),
      store: jest.fn(),
      delete: jest.fn()
    };

    await cm.hydrateSecrets(secretStore);

    expect(secretStore.get).toHaveBeenCalledWith('myagent.models.m1.apiKey');
    expect(cm.getActiveModel()?.apiKey).toBe('resolved-secret');
  });

  it('经确认后把旧 apiKey 迁移到 SecretStorage 且不再写回明文', async () => {
    setupFs({
      [WORKSPACE_SETTINGS_PATH]: makeSettings({
        models: [{
          name: 'm1',
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'plain-text-secret',
          baseUrl: 'https://api.example.test/v1'
        }]
      })
    });
    const cm = new ConfigManager(WORKSPACE_DIR);
    const secretStore = {
      get: jest.fn(),
      store: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn()
    };
    const confirm = jest.fn().mockResolvedValue(true);

    await expect(cm.migrateLegacyApiKeys(secretStore, confirm)).resolves.toBe(1);

    expect(secretStore.store).toHaveBeenCalledWith(
      `myagent.models.${encodeURIComponent(WORKSPACE_SETTINGS_PATH)}.m1.apiKey`,
      'plain-text-secret'
    );
    const written = String(mockedFs.writeFileSync.mock.calls[0][1]);
    expect(written).toContain(
      `"apiKeyRef": "myagent.models.${encodeURIComponent(WORKSPACE_SETTINGS_PATH)}.m1.apiKey"`
    );
    expect(written).not.toContain('plain-text-secret');
    expect(mockedFs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining(`${WORKSPACE_SETTINGS_PATH}.tmp-`),
      WORKSPACE_SETTINGS_PATH
    );
  });

  it('切换活动模型时使用临时文件原子写回主配置', () => {
    setupFs({
      [WORKSPACE_SETTINGS_PATH]: makeSettings({
        models: [
          { name: 'm1', provider: 'anthropic', model: 'a', apiKey: 'k', baseUrl: 'u' },
          { name: 'm2', provider: 'openai', model: 'b', apiKey: 'k', baseUrl: 'u' }
        ]
      })
    });
    const cm = new ConfigManager(WORKSPACE_DIR);

    cm.setActiveModel('m2');

    const written = JSON.parse(String(mockedFs.writeFileSync.mock.calls[0][1]));
    expect(written.activeModel).toBe('m2');
    expect(mockedFs.renameSync).toHaveBeenCalled();
  });
});
