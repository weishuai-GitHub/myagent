import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SqliteConversationSessionRepository
} from '../../src/agent/conversation/session-repository';
import { ConversationSnapshot } from '../../src/agent/conversation/types';

describe('SqliteConversationSessionRepository', () => {
  let storageDir: string;
  const wasmPath = path.resolve(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm');

  beforeEach(async () => {
    storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myagent-sessions-'));
  });

  afterEach(async () => {
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it('persists normalized conversation items and active session across reopen', async () => {
    const snapshot: ConversationSnapshot = {
      version: 1,
      items: [
        { id: 'm1', createdAt: 1, role: 'user', content: '读取文件' },
        {
          id: 'm2',
          createdAt: 2,
          role: 'tool',
          callId: 'call-1',
          callType: 'tool',
          name: 'fileRead',
          status: 'success',
          content: 'contents'
        },
        { id: 'm3', createdAt: 3, role: 'assistant', content: '完成' }
      ]
    };

    const repository = await SqliteConversationSessionRepository.open({
      storageDir,
      wasmPath
    });
    const created = await repository.createSession('/workspace', {
      title: '读取文件',
      titleSource: 'generated',
      modelName: 'GPT',
      snapshot,
      tokenUsage: { inputTokens: 12, outputTokens: 4 }
    });
    await repository.close();

    const reopened = await SqliteConversationSessionRepository.open({
      storageDir,
      wasmPath
    });
    const restored = await reopened.getActiveSession('/workspace');

    expect(restored).toEqual(expect.objectContaining({
      id: created.id,
      title: '读取文件',
      modelName: 'GPT',
      messageCount: 3,
      tokenUsage: {
        inputTokens: 12,
        outputTokens: 4,
        totalTokens: 16
      },
      snapshot
    }));
    await reopened.close();
  });

  it('isolates workspaces and supports create, rename, switch, and delete', async () => {
    const repository = await SqliteConversationSessionRepository.open({
      storageDir,
      wasmPath
    });
    const first = await repository.createSession('/workspace-a');
    const second = await repository.createSession('/workspace-a');
    await repository.createSession('/workspace-b', { title: '其他项目' });

    expect((await repository.listSessions('/workspace-a')).map(session => session.id))
      .toEqual(expect.arrayContaining([first.id, second.id]));
    expect(await repository.listSessions('/workspace-b')).toHaveLength(1);

    await repository.renameSession('/workspace-a', first.id, '手动标题');
    await repository.setActiveSession('/workspace-a', first.id);
    expect((await repository.getActiveSession('/workspace-a'))?.title).toBe('手动标题');

    await repository.deleteSession('/workspace-a', first.id);
    expect(await repository.getActiveSession('/workspace-a')).toBeNull();
    expect(await repository.getSession('/workspace-a', first.id)).toBeNull();
    await repository.close();
  });

  it('persists display metadata and nested execution traces across reopen', async () => {
    const repository = await SqliteConversationSessionRepository.open({
      storageDir,
      wasmPath
    });
    const session = await repository.createSession('/workspace', {
      snapshot: {
        version: 1,
        items: [{
          id: 'message-1',
          createdAt: 1,
          role: 'user',
          content: '/tool:fileRead README',
          displayContent: 'README',
          turnId: 'execution-1',
          visibility: 'visible'
        }]
      }
    });
    await repository.saveExecutionTrace('/workspace', session.id, {
      version: 1,
      executionId: 'execution-1',
      sessionId: session.id,
      requestId: 'request-1',
      status: 'completed',
      startedAt: 10,
      completedAt: 20,
      calls: [{
        callId: 'call-parent',
        executionId: 'execution-1',
        agentRunId: 'agent-main',
        agentName: 'main',
        agentPath: ['main'],
        agentDepth: 0,
        type: 'subagent',
        name: 'reviewer',
        status: 'success',
        startedAt: 11,
        completedAt: 19,
        durationMs: 8,
        sequence: 0,
        display: { title: '子 Agent · reviewer', format: 'markdown', output: '完成' }
      }, {
        callId: 'call-child',
        executionId: 'execution-1',
        parentCallId: 'call-parent',
        agentRunId: 'agent-child',
        agentName: 'reviewer',
        agentPath: ['main', 'reviewer'],
        agentDepth: 1,
        type: 'tool',
        name: 'fileRead',
        status: 'success',
        startedAt: 12,
        completedAt: 13,
        durationMs: 1,
        sequence: 1,
        display: { title: '工具 · fileRead', format: 'text', output: 'README' }
      }]
    });
    await repository.close();

    const reopened = await SqliteConversationSessionRepository.open({
      storageDir,
      wasmPath
    });
    const restored = await reopened.getSession('/workspace', session.id);
    const traces = await reopened.listExecutionTraces('/workspace', session.id);

    expect(restored?.snapshot.items[0]).toEqual(expect.objectContaining({
      displayContent: 'README',
      turnId: 'execution-1',
      visibility: 'visible'
    }));
    expect(traces).toEqual([
      expect.objectContaining({
        executionId: 'execution-1',
        status: 'completed',
        calls: [
          expect.objectContaining({ callId: 'call-parent' }),
          expect.objectContaining({
            callId: 'call-child',
            parentCallId: 'call-parent',
            agentPath: ['main', 'reviewer']
          })
        ]
      })
    ]);
    await reopened.close();
  });
});
