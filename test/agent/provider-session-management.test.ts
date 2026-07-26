import { FloatingPanelProvider } from '../../src/FloatingPanelProvider';
import { InMemoryConversationSessionRepository } from '../../src/agent/conversation/session-repository';

describe('FloatingPanelProvider session management', () => {
  function createProvider() {
    const postMessage = jest.fn();
    const state = new Map<string, unknown>();
    const context = {
      workspaceState: {
        get: jest.fn((key: string, fallback: unknown) => state.get(key) ?? fallback),
        update: jest.fn(async (key: string, value: unknown) => {
          state.set(key, value);
        })
      }
    } as any;
    const runtime = {
      workspaceDir: '/workspace',
      getActiveModelName: () => 'GPT',
      getConfigPath: () => '',
      getAvailableModels: () => [],
      getDiscoveredComponents: () => ({ tools: [], skills: [], subagents: [] }),
      config: {
        getConfigPath: () => '',
        getSettings: () => null,
        getDiagnostics: () => []
      }
    } as any;
    const repository = new InMemoryConversationSessionRepository();
    const provider = new FloatingPanelProvider(context, runtime, repository) as any;
    provider.view = { webview: { postMessage } };
    return { provider, repository, postMessage };
  }

  it('creates, switches, renames, and deletes workspace sessions', async () => {
    const { provider, repository, postMessage } = createProvider();
    await provider.handleMessage({ type: 'webview-ready' });
    const initial = await repository.getActiveSession('/workspace');
    expect(initial).not.toBeNull();

    await provider.handleMessage({ type: 'create-session' });
    const created = await repository.getActiveSession('/workspace');
    expect(created?.id).not.toBe(initial?.id);

    await provider.handleMessage({
      type: 'rename-session',
      sessionId: created!.id,
      title: '新的标题'
    });
    expect((await repository.getSession('/workspace', created!.id))?.title).toBe('新的标题');

    await provider.handleMessage({ type: 'switch-session', sessionId: initial!.id });
    expect((await repository.getActiveSession('/workspace'))?.id).toBe(initial!.id);

    await provider.handleMessage({ type: 'delete-session', sessionId: initial!.id });
    expect(await repository.getSession('/workspace', initial!.id)).toBeNull();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session-loaded'
    }));
  });

  it('migrates the previous workspaceState snapshot once', async () => {
    const { provider, repository } = createProvider();
    provider.context.workspaceState.get.mockImplementation((key: string, fallback: unknown) => {
      if (key === 'myagent_conversation_v1') {
        return {
          version: 1,
          items: [
            { id: 'legacy-1', createdAt: 1, role: 'user', content: '旧会话问题' },
            { id: 'legacy-2', createdAt: 2, role: 'assistant', content: '旧会话回答' }
          ]
        };
      }
      return fallback;
    });

    await provider.handleMessage({ type: 'webview-ready' });
    const active = await repository.getActiveSession('/workspace');
    expect(active?.title).toBe('旧会话问题');
    expect(active?.snapshot.items).toHaveLength(2);
  });
});
