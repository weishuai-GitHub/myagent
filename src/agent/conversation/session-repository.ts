import { promises as fs } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js/dist/sql-wasm.js';
import { TokenUsage } from '../types';
import {
  ConversationItem,
  ConversationSnapshot,
  ConversationToolItem
} from './types';
import {
  ComponentCallRecord,
  ComponentDisplay,
  ExecutionTraceSnapshot
} from '../execution/types';

export interface ConversationSessionSummary {
  id: string;
  workspaceKey: string;
  title: string;
  titleSource: 'default' | 'generated' | 'manual';
  modelName?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokenUsage: TokenUsage & { totalTokens: number };
}

export interface StoredConversationSession extends ConversationSessionSummary {
  snapshot: ConversationSnapshot;
}

export interface ConversationSessionRepository {
  listSessions(workspaceKey: string): Promise<ConversationSessionSummary[]>;
  getSession(workspaceKey: string, sessionId: string): Promise<StoredConversationSession | null>;
  getActiveSession(workspaceKey: string): Promise<StoredConversationSession | null>;
  createSession(
    workspaceKey: string,
    options?: {
      title?: string;
      titleSource?: ConversationSessionSummary['titleSource'];
      modelName?: string;
      snapshot?: ConversationSnapshot;
      tokenUsage?: TokenUsage;
    }
  ): Promise<StoredConversationSession>;
  saveSession(
    workspaceKey: string,
    sessionId: string,
    snapshot: ConversationSnapshot,
    tokenUsage: TokenUsage,
    modelName?: string
  ): Promise<StoredConversationSession>;
  setActiveSession(workspaceKey: string, sessionId: string): Promise<void>;
  renameSession(workspaceKey: string, sessionId: string, title: string): Promise<void>;
  setGeneratedTitle(workspaceKey: string, sessionId: string, title: string): Promise<void>;
  listExecutionTraces(
    workspaceKey: string,
    sessionId: string
  ): Promise<ExecutionTraceSnapshot[]>;
  saveExecutionTrace(
    workspaceKey: string,
    sessionId: string,
    trace: ExecutionTraceSnapshot
  ): Promise<void>;
  clearExecutionTraces(workspaceKey: string, sessionId: string): Promise<void>;
  deleteSession(workspaceKey: string, sessionId: string): Promise<void>;
  close(): Promise<void>;
}

interface SessionRow {
  id: string;
  workspace_key: string;
  title: string;
  title_source: ConversationSessionSummary['titleSource'];
  model_name: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  input_tokens: number;
  output_tokens: number;
}

const EMPTY_SNAPSHOT: ConversationSnapshot = { version: 1, items: [] };

export function createEmptyConversationSnapshot(): ConversationSnapshot {
  return { version: 1, items: [] };
}

export class SqliteConversationSessionRepository implements ConversationSessionRepository {
  private writeQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly db: Database,
    private readonly databasePath: string
  ) {}

  static async open(options: {
    storageDir: string;
    wasmPath: string;
    databaseName?: string;
  }): Promise<SqliteConversationSessionRepository> {
    await fs.mkdir(options.storageDir, { recursive: true });
    const SQL: SqlJsStatic = await initSqlJs({
      locateFile: () => options.wasmPath
    });
    const databasePath = path.join(options.storageDir, options.databaseName ?? 'conversations.sqlite3');
    let bytes: Uint8Array | undefined;
    try {
      bytes = new Uint8Array(await fs.readFile(databasePath));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    const repository = new SqliteConversationSessionRepository(db, databasePath);
    repository.migrate();
    await repository.persist();
    return repository;
  }

  async listSessions(workspaceKey: string): Promise<ConversationSessionSummary[]> {
    this.assertOpen();
    const statement = this.db.prepare(
      `SELECT id, workspace_key, title, title_source, model_name, created_at, updated_at,
              message_count, input_tokens, output_tokens
         FROM sessions
        WHERE workspace_key = ?
        ORDER BY updated_at DESC, created_at DESC`
    );
    try {
      statement.bind([workspaceKey]);
      const sessions: ConversationSessionSummary[] = [];
      while (statement.step()) {
        sessions.push(this.rowToSummary(statement.getAsObject() as unknown as SessionRow));
      }
      return sessions;
    } finally {
      statement.free();
    }
  }

  async getSession(
    workspaceKey: string,
    sessionId: string
  ): Promise<StoredConversationSession | null> {
    this.assertOpen();
    const row = this.getSessionRow(workspaceKey, sessionId);
    if (!row) return null;
    return {
      ...this.rowToSummary(row),
      snapshot: this.readSnapshot(sessionId)
    };
  }

  async getActiveSession(workspaceKey: string): Promise<StoredConversationSession | null> {
    this.assertOpen();
    const result = this.db.exec(
      `SELECT active_session_id
         FROM workspace_session_state
        WHERE workspace_key = ?`,
      [workspaceKey]
    );
    const sessionId = result[0]?.values[0]?.[0];
    if (typeof sessionId !== 'string') return null;
    return this.getSession(workspaceKey, sessionId);
  }

  async createSession(
    workspaceKey: string,
    options: {
      title?: string;
      titleSource?: ConversationSessionSummary['titleSource'];
      modelName?: string;
      snapshot?: ConversationSnapshot;
      tokenUsage?: TokenUsage;
    } = {}
  ): Promise<StoredConversationSession> {
    this.assertOpen();
    const id = randomUUID();
    const now = Date.now();
    const snapshot = options.snapshot ?? EMPTY_SNAPSHOT;
    const usage = options.tokenUsage ?? { inputTokens: 0, outputTokens: 0 };
    await this.mutate(() => {
      this.db.run(
        `INSERT INTO sessions (
           id, workspace_key, title, title_source, model_name, created_at, updated_at,
           message_count, input_tokens, output_tokens
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          workspaceKey,
          options.title?.trim() || '新会话',
          options.titleSource ?? 'default',
          options.modelName ?? null,
          now,
          now,
          snapshot.items.length,
          usage.inputTokens,
          usage.outputTokens
        ]
      );
      this.replaceItems(id, snapshot.items);
      this.upsertActiveSession(workspaceKey, id);
    });
    return (await this.getSession(workspaceKey, id))!;
  }

  async saveSession(
    workspaceKey: string,
    sessionId: string,
    snapshot: ConversationSnapshot,
    tokenUsage: TokenUsage,
    modelName?: string
  ): Promise<StoredConversationSession> {
    this.assertOpen();
    this.requireSession(workspaceKey, sessionId);
    await this.mutate(() => {
      this.db.run(
        `UPDATE sessions
            SET updated_at = ?,
                message_count = ?,
                input_tokens = ?,
                output_tokens = ?,
                model_name = ?
          WHERE id = ? AND workspace_key = ?`,
        [
          Date.now(),
          snapshot.items.length,
          tokenUsage.inputTokens,
          tokenUsage.outputTokens,
          modelName ?? null,
          sessionId,
          workspaceKey
        ]
      );
      this.replaceItems(sessionId, snapshot.items);
    });
    return (await this.getSession(workspaceKey, sessionId))!;
  }

  async setActiveSession(workspaceKey: string, sessionId: string): Promise<void> {
    this.assertOpen();
    this.requireSession(workspaceKey, sessionId);
    await this.mutate(() => this.upsertActiveSession(workspaceKey, sessionId));
  }

  async renameSession(workspaceKey: string, sessionId: string, title: string): Promise<void> {
    this.assertOpen();
    const normalized = title.trim();
    if (!normalized) throw new Error('会话标题不能为空');
    this.requireSession(workspaceKey, sessionId);
    await this.mutate(() => {
      this.db.run(
        `UPDATE sessions
            SET title = ?, title_source = 'manual', updated_at = ?
          WHERE id = ? AND workspace_key = ?`,
        [normalized.slice(0, 120), Date.now(), sessionId, workspaceKey]
      );
    });
  }

  async setGeneratedTitle(workspaceKey: string, sessionId: string, title: string): Promise<void> {
    this.assertOpen();
    const normalized = title.trim();
    if (!normalized) return;
    this.requireSession(workspaceKey, sessionId);
    await this.mutate(() => {
      this.db.run(
        `UPDATE sessions
            SET title = ?, title_source = 'generated', updated_at = ?
          WHERE id = ? AND workspace_key = ? AND title_source = 'default'`,
        [normalized.slice(0, 120), Date.now(), sessionId, workspaceKey]
      );
    });
  }

  async listExecutionTraces(
    workspaceKey: string,
    sessionId: string
  ): Promise<ExecutionTraceSnapshot[]> {
    this.assertOpen();
    this.requireSession(workspaceKey, sessionId);
    const statement = this.db.prepare(
      `SELECT execution_id, request_id, status, started_at, completed_at, error
         FROM executions
        WHERE session_id = ?
        ORDER BY started_at ASC`
    );
    try {
      statement.bind([sessionId]);
      const traces: ExecutionTraceSnapshot[] = [];
      while (statement.step()) {
        const row = statement.getAsObject() as Record<string, unknown>;
        const executionId = String(row.execution_id);
        traces.push({
          version: 1,
          executionId,
          sessionId,
          requestId: String(row.request_id),
          status: row.status as ExecutionTraceSnapshot['status'],
          startedAt: Number(row.started_at),
          completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
          error: row.error == null ? undefined : String(row.error),
          calls: this.readComponentCalls(executionId)
        });
      }
      return traces;
    } finally {
      statement.free();
    }
  }

  async saveExecutionTrace(
    workspaceKey: string,
    sessionId: string,
    trace: ExecutionTraceSnapshot
  ): Promise<void> {
    this.assertOpen();
    this.requireSession(workspaceKey, sessionId);
    if (trace.sessionId !== sessionId) {
      throw new Error(`执行轨迹不属于当前会话：${trace.executionId}`);
    }
    await this.mutate(() => {
      this.db.run(
        `INSERT INTO executions (
           execution_id, session_id, request_id, status, started_at, completed_at, error
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(execution_id) DO UPDATE SET
           status = excluded.status,
           completed_at = excluded.completed_at,
           error = excluded.error`,
        [
          trace.executionId,
          sessionId,
          trace.requestId,
          trace.status,
          trace.startedAt,
          trace.completedAt ?? null,
          trace.error ?? null
        ]
      );
      this.replaceComponentCalls(trace.executionId, trace.calls);
    });
  }

  async clearExecutionTraces(workspaceKey: string, sessionId: string): Promise<void> {
    this.assertOpen();
    this.requireSession(workspaceKey, sessionId);
    await this.mutate(() => {
      this.db.run('DELETE FROM executions WHERE session_id = ?', [sessionId]);
    });
  }

  async deleteSession(workspaceKey: string, sessionId: string): Promise<void> {
    this.assertOpen();
    this.requireSession(workspaceKey, sessionId);
    await this.mutate(() => {
      this.db.run(
        `DELETE FROM sessions WHERE id = ? AND workspace_key = ?`,
        [sessionId, workspaceKey]
      );
      this.db.run(
        `UPDATE workspace_session_state
            SET active_session_id = NULL
          WHERE workspace_key = ? AND active_session_id = ?`,
        [workspaceKey, sessionId]
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.writeQueue;
    this.db.close();
    this.closed = true;
  }

  private migrate(): void {
    this.db.run('PRAGMA foreign_keys = ON');
    const versionResult = this.db.exec('PRAGMA user_version');
    const version = Number(versionResult[0]?.values[0]?.[0] ?? 0);
    if (version !== 0 && version !== 2) {
      throw new Error(
        `不支持当前会话数据库版本（version=${version}）。请删除旧数据库后重新启动 MyAgent。`
      );
    }
    if (version === 0) {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          workspace_key TEXT NOT NULL,
          title TEXT NOT NULL,
          title_source TEXT NOT NULL DEFAULT 'default',
          model_name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS sessions_workspace_updated
          ON sessions(workspace_key, updated_at DESC);

        CREATE TABLE IF NOT EXISTS conversation_items (
          session_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          item_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          turn_id TEXT,
          display_content TEXT,
          visibility TEXT NOT NULL DEFAULT 'visible',
          call_id TEXT,
          call_type TEXT,
          component_name TEXT,
          call_status TEXT,
          PRIMARY KEY (session_id, position),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS conversation_items_identity
          ON conversation_items(session_id, item_id);

        CREATE TABLE IF NOT EXISTS workspace_session_state (
          workspace_key TEXT PRIMARY KEY,
          active_session_id TEXT,
          FOREIGN KEY (active_session_id) REFERENCES sessions(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS executions (
          execution_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          error TEXT,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS executions_session_started
          ON executions(session_id, started_at ASC);

        CREATE TABLE IF NOT EXISTS component_calls (
          execution_id TEXT NOT NULL,
          call_id TEXT PRIMARY KEY,
          parent_call_id TEXT,
          agent_run_id TEXT NOT NULL,
          agent_name TEXT NOT NULL,
          agent_path_json TEXT NOT NULL,
          agent_depth INTEGER NOT NULL,
          call_type TEXT NOT NULL,
          component_name TEXT NOT NULL,
          call_status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          duration_ms INTEGER,
          sequence INTEGER NOT NULL,
          display_json TEXT NOT NULL,
          error TEXT,
          FOREIGN KEY (execution_id) REFERENCES executions(execution_id) ON DELETE CASCADE,
          FOREIGN KEY (parent_call_id) REFERENCES component_calls(call_id) ON DELETE CASCADE
        );

        CREATE UNIQUE INDEX IF NOT EXISTS component_calls_execution_sequence
          ON component_calls(execution_id, sequence ASC);

        CREATE INDEX IF NOT EXISTS component_calls_parent
          ON component_calls(parent_call_id);

        PRAGMA user_version = 2;
      `);
    }
  }

  private replaceItems(sessionId: string, items: readonly ConversationItem[]): void {
    this.db.run('DELETE FROM conversation_items WHERE session_id = ?', [sessionId]);
    const statement = this.db.prepare(
       `INSERT INTO conversation_items (
         session_id, position, item_id, created_at, role, content,
         turn_id, display_content, visibility,
         call_id, call_type, component_name, call_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      items.forEach((item, position) => {
        const tool = item.role === 'tool' ? item : undefined;
        statement.run([
          sessionId,
          position,
          item.id,
          item.createdAt,
          item.role,
          item.content,
          item.turnId ?? null,
          item.displayContent ?? null,
          item.visibility ?? 'visible',
          tool?.callId ?? null,
          tool?.callType ?? null,
          tool?.name ?? null,
          tool?.status ?? null
        ]);
      });
    } finally {
      statement.free();
    }
  }

  private readSnapshot(sessionId: string): ConversationSnapshot {
    const statement = this.db.prepare(
      `SELECT item_id, created_at, role, content, turn_id, display_content, visibility,
              call_id, call_type, component_name, call_status
         FROM conversation_items
        WHERE session_id = ?
        ORDER BY position ASC`
    );
    try {
      statement.bind([sessionId]);
      const items: ConversationItem[] = [];
      while (statement.step()) {
        const row = statement.getAsObject() as Record<string, unknown>;
        if (row.role === 'tool') {
          const metadata = this.readItemMetadata(row);
          items.push({
            id: String(row.item_id),
            createdAt: Number(row.created_at),
            role: 'tool',
            content: String(row.content),
            ...metadata,
            callId: String(row.call_id),
            callType: row.call_type as ConversationToolItem['callType'],
            name: String(row.component_name),
            status: row.call_status as ConversationToolItem['status']
          });
        } else {
          const metadata = this.readItemMetadata(row);
          items.push({
            id: String(row.item_id),
            createdAt: Number(row.created_at),
            role: row.role as 'user' | 'assistant' | 'system',
            content: String(row.content),
            ...metadata
          });
        }
      }
      return { version: 1, items };
    } finally {
      statement.free();
    }
  }

  private readItemMetadata(row: Record<string, unknown>): {
    turnId?: string;
    displayContent?: string;
    visibility?: 'visible' | 'hidden';
  } {
    const metadata: {
      turnId?: string;
      displayContent?: string;
      visibility?: 'visible' | 'hidden';
    } = {};
    if (row.turn_id != null) metadata.turnId = String(row.turn_id);
    if (row.display_content != null) metadata.displayContent = String(row.display_content);
    if (row.visibility === 'hidden' || metadata.turnId || metadata.displayContent) {
      metadata.visibility = row.visibility === 'hidden' ? 'hidden' : 'visible';
    }
    return metadata;
  }

  private replaceComponentCalls(
    executionId: string,
    calls: readonly ComponentCallRecord[]
  ): void {
    this.db.run('DELETE FROM component_calls WHERE execution_id = ?', [executionId]);
    const statement = this.db.prepare(
      `INSERT INTO component_calls (
         execution_id, call_id, parent_call_id, agent_run_id, agent_name,
         agent_path_json, agent_depth, call_type, component_name, call_status,
         started_at, completed_at, duration_ms, sequence, display_json, error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    try {
      for (const call of [...calls].sort((left, right) => left.sequence - right.sequence)) {
        statement.run([
          executionId,
          call.callId,
          call.parentCallId ?? null,
          call.agentRunId,
          call.agentName,
          JSON.stringify(call.agentPath),
          call.agentDepth,
          call.type,
          call.name,
          call.status,
          call.startedAt,
          call.completedAt ?? null,
          call.durationMs ?? null,
          call.sequence,
          JSON.stringify(call.display),
          call.error ?? null
        ]);
      }
    } finally {
      statement.free();
    }
  }

  private readComponentCalls(executionId: string): ComponentCallRecord[] {
    const statement = this.db.prepare(
      `SELECT call_id, parent_call_id, agent_run_id, agent_name, agent_path_json,
              agent_depth, call_type, component_name, call_status, started_at,
              completed_at, duration_ms, sequence, display_json, error
         FROM component_calls
        WHERE execution_id = ?
        ORDER BY sequence ASC`
    );
    try {
      statement.bind([executionId]);
      const calls: ComponentCallRecord[] = [];
      while (statement.step()) {
        const row = statement.getAsObject() as Record<string, unknown>;
        calls.push({
          callId: String(row.call_id),
          executionId,
          parentCallId: row.parent_call_id == null ? undefined : String(row.parent_call_id),
          agentRunId: String(row.agent_run_id),
          agentName: String(row.agent_name),
          agentPath: this.parseAgentPath(row.agent_path_json),
          agentDepth: Number(row.agent_depth),
          type: row.call_type as ComponentCallRecord['type'],
          name: String(row.component_name),
          status: row.call_status as ComponentCallRecord['status'],
          startedAt: Number(row.started_at),
          completedAt: row.completed_at == null ? undefined : Number(row.completed_at),
          durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
          sequence: Number(row.sequence),
          display: this.parseComponentDisplay(row.display_json),
          error: row.error == null ? undefined : String(row.error)
        });
      }
      return calls;
    } finally {
      statement.free();
    }
  }

  private parseAgentPath(value: unknown): string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(value));
    } catch {
      throw new Error('会话数据库中的 agent_path_json 不是合法 JSON');
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every(item => typeof item === 'string' && item.length > 0)
    ) {
      throw new Error('会话数据库中的 agent_path_json 格式无效');
    }
    return parsed;
  }

  private parseComponentDisplay(value: unknown): ComponentDisplay {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(value));
    } catch {
      throw new Error('会话数据库中的 display_json 不是合法 JSON');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('会话数据库中的 display_json 格式无效');
    }
    const display = parsed as Record<string, unknown>;
    const formats: ComponentDisplay['format'][] = ['text', 'json', 'markdown', 'code'];
    if (
      typeof display.title !== 'string' ||
      display.title.length === 0 ||
      !formats.includes(display.format as ComponentDisplay['format']) ||
      (display.subtitle !== undefined && typeof display.subtitle !== 'string') ||
      (display.input !== undefined && typeof display.input !== 'string') ||
      (display.output !== undefined && typeof display.output !== 'string') ||
      (display.truncated !== undefined && typeof display.truncated !== 'boolean')
    ) {
      throw new Error('会话数据库中的 display_json 格式无效');
    }
    return {
      title: display.title,
      subtitle: display.subtitle as string | undefined,
      input: display.input as string | undefined,
      output: display.output as string | undefined,
      format: display.format as ComponentDisplay['format'],
      truncated: display.truncated as boolean | undefined
    };
  }

  private getSessionRow(workspaceKey: string, sessionId: string): SessionRow | null {
    const statement = this.db.prepare(
      `SELECT id, workspace_key, title, title_source, model_name, created_at, updated_at,
              message_count, input_tokens, output_tokens
         FROM sessions
        WHERE id = ? AND workspace_key = ?`
    );
    try {
      statement.bind([sessionId, workspaceKey]);
      if (!statement.step()) return null;
      return statement.getAsObject() as unknown as SessionRow;
    } finally {
      statement.free();
    }
  }

  private requireSession(workspaceKey: string, sessionId: string): void {
    if (!this.getSessionRow(workspaceKey, sessionId)) {
      throw new Error(`会话不存在或不属于当前工作区：${sessionId}`);
    }
  }

  private rowToSummary(row: SessionRow): ConversationSessionSummary {
    const inputTokens = Number(row.input_tokens);
    const outputTokens = Number(row.output_tokens);
    return {
      id: String(row.id),
      workspaceKey: String(row.workspace_key),
      title: String(row.title),
      titleSource: row.title_source,
      modelName: row.model_name ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      messageCount: Number(row.message_count),
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens
      }
    };
  }

  private upsertActiveSession(workspaceKey: string, sessionId: string): void {
    this.db.run(
      `INSERT INTO workspace_session_state (workspace_key, active_session_id)
       VALUES (?, ?)
       ON CONFLICT(workspace_key)
       DO UPDATE SET active_session_id = excluded.active_session_id`,
      [workspaceKey, sessionId]
    );
  }

  private async mutate(action: () => void): Promise<void> {
    this.db.run('BEGIN IMMEDIATE');
    try {
      action();
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const bytes = this.db.export();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        const tempPath = `${this.databasePath}.tmp`;
        await fs.writeFile(tempPath, bytes);
        await fs.rename(tempPath, this.databasePath);
      });
    await this.writeQueue;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('会话数据库已经关闭');
  }
}

/** 仅用于测试和无磁盘宿主的轻量实现；生产扩展使用 SQLite 仓储。 */
export class InMemoryConversationSessionRepository implements ConversationSessionRepository {
  private readonly sessions = new Map<string, StoredConversationSession>();
  private readonly activeByWorkspace = new Map<string, string>();
  private readonly tracesBySession = new Map<string, Map<string, ExecutionTraceSnapshot>>();

  async listSessions(workspaceKey: string): Promise<ConversationSessionSummary[]> {
    return [...this.sessions.values()]
      .filter(session => session.workspaceKey === workspaceKey)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(({ snapshot: _snapshot, ...summary }) => this.cloneSummary(summary));
  }

  async getSession(
    workspaceKey: string,
    sessionId: string
  ): Promise<StoredConversationSession | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceKey !== workspaceKey) return null;
    return this.cloneSession(session);
  }

  async getActiveSession(workspaceKey: string): Promise<StoredConversationSession | null> {
    const sessionId = this.activeByWorkspace.get(workspaceKey);
    return sessionId ? this.getSession(workspaceKey, sessionId) : null;
  }

  async createSession(
    workspaceKey: string,
    options: {
      title?: string;
      titleSource?: ConversationSessionSummary['titleSource'];
      modelName?: string;
      snapshot?: ConversationSnapshot;
      tokenUsage?: TokenUsage;
    } = {}
  ): Promise<StoredConversationSession> {
    const now = Date.now();
    const usage = options.tokenUsage ?? { inputTokens: 0, outputTokens: 0 };
    const snapshot = options.snapshot ?? createEmptyConversationSnapshot();
    const session: StoredConversationSession = {
      id: randomUUID(),
      workspaceKey,
      title: options.title?.trim() || '新会话',
      titleSource: options.titleSource ?? 'default',
      modelName: options.modelName,
      createdAt: now,
      updatedAt: now,
      messageCount: snapshot.items.length,
      tokenUsage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.inputTokens + usage.outputTokens
      },
      snapshot: this.cloneSnapshot(snapshot)
    };
    this.sessions.set(session.id, session);
    this.activeByWorkspace.set(workspaceKey, session.id);
    return this.cloneSession(session);
  }

  async saveSession(
    workspaceKey: string,
    sessionId: string,
    snapshot: ConversationSnapshot,
    tokenUsage: TokenUsage,
    modelName?: string
  ): Promise<StoredConversationSession> {
    const session = this.requireSession(workspaceKey, sessionId);
    session.snapshot = this.cloneSnapshot(snapshot);
    session.messageCount = snapshot.items.length;
    session.updatedAt = Date.now();
    session.modelName = modelName;
    session.tokenUsage = {
      inputTokens: tokenUsage.inputTokens,
      outputTokens: tokenUsage.outputTokens,
      totalTokens: tokenUsage.inputTokens + tokenUsage.outputTokens
    };
    return this.cloneSession(session);
  }

  async setActiveSession(workspaceKey: string, sessionId: string): Promise<void> {
    this.requireSession(workspaceKey, sessionId);
    this.activeByWorkspace.set(workspaceKey, sessionId);
  }

  async renameSession(workspaceKey: string, sessionId: string, title: string): Promise<void> {
    const normalized = title.trim();
    if (!normalized) throw new Error('会话标题不能为空');
    const session = this.requireSession(workspaceKey, sessionId);
    session.title = normalized.slice(0, 120);
    session.titleSource = 'manual';
    session.updatedAt = Date.now();
  }

  async setGeneratedTitle(workspaceKey: string, sessionId: string, title: string): Promise<void> {
    const session = this.requireSession(workspaceKey, sessionId);
    if (session.titleSource !== 'default' || !title.trim()) return;
    session.title = title.trim().slice(0, 120);
    session.titleSource = 'generated';
    session.updatedAt = Date.now();
  }

  async listExecutionTraces(
    workspaceKey: string,
    sessionId: string
  ): Promise<ExecutionTraceSnapshot[]> {
    this.requireSession(workspaceKey, sessionId);
    return [...(this.tracesBySession.get(sessionId)?.values() ?? [])]
      .sort((left, right) => left.startedAt - right.startedAt)
      .map(trace => this.cloneTrace(trace));
  }

  async saveExecutionTrace(
    workspaceKey: string,
    sessionId: string,
    trace: ExecutionTraceSnapshot
  ): Promise<void> {
    this.requireSession(workspaceKey, sessionId);
    if (trace.sessionId !== sessionId) {
      throw new Error(`执行轨迹不属于当前会话：${trace.executionId}`);
    }
    const traces = this.tracesBySession.get(sessionId) ?? new Map();
    traces.set(trace.executionId, this.cloneTrace(trace));
    this.tracesBySession.set(sessionId, traces);
  }

  async clearExecutionTraces(workspaceKey: string, sessionId: string): Promise<void> {
    this.requireSession(workspaceKey, sessionId);
    this.tracesBySession.delete(sessionId);
  }

  async deleteSession(workspaceKey: string, sessionId: string): Promise<void> {
    this.requireSession(workspaceKey, sessionId);
    this.sessions.delete(sessionId);
    this.tracesBySession.delete(sessionId);
    if (this.activeByWorkspace.get(workspaceKey) === sessionId) {
      this.activeByWorkspace.delete(workspaceKey);
    }
  }

  async close(): Promise<void> {}

  private requireSession(workspaceKey: string, sessionId: string): StoredConversationSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceKey !== workspaceKey) {
      throw new Error(`会话不存在或不属于当前工作区：${sessionId}`);
    }
    return session;
  }

  private cloneSession(session: StoredConversationSession): StoredConversationSession {
    return {
      ...this.cloneSummary(session),
      snapshot: this.cloneSnapshot(session.snapshot)
    };
  }

  private cloneSummary(
    session: Omit<StoredConversationSession, 'snapshot'>
  ): ConversationSessionSummary {
    return {
      ...session,
      tokenUsage: { ...session.tokenUsage }
    };
  }

  private cloneSnapshot(snapshot: ConversationSnapshot): ConversationSnapshot {
    return {
      version: 1,
      items: snapshot.items.map(item => ({ ...item }))
    };
  }

  private cloneTrace(trace: ExecutionTraceSnapshot): ExecutionTraceSnapshot {
    return {
      ...trace,
      calls: trace.calls.map(call => ({
        ...call,
        agentPath: [...call.agentPath],
        display: { ...call.display }
      }))
    };
  }
}
