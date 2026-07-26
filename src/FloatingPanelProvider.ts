import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from './agent/runtime';
import { Session } from './agent/session';
import { ComponentSource } from './agent/component/types';
import { ToolApprovalRequest } from './agent/component/tools/types';
import { toPublicModelConfig, toPublicSettings } from './agent/config/public-dto';
import { Message } from './agent/types';
import { ConversationSnapshot } from './agent/conversation/types';
import {
  ConversationSessionRepository,
  ConversationSessionSummary,
  InMemoryConversationSessionRepository,
  StoredConversationSession
} from './agent/conversation/session-repository';
import { XMLParser } from './agent/xml-parser';
import {
  ExtensionToWebviewMessage,
  isWebviewToExtensionMessage,
  WebviewToExtensionMessage
} from './protocol/webview';

export class FloatingPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private session: Session | null = null;
  private sessionStale = false;
  private cancelRequested = false;
  private activeRequestId: string | null = null;
  private pendingWorkspaceReload: { workspaceDir?: string } | null = null;
  private toolApprovalQueue: Promise<void> = Promise.resolve();
  private activeConversation: StoredConversationSession | null = null;
  private workspaceKey: string;
  private context: vscode.ExtensionContext;
  private runtime: AgentRuntime;

  private static readonly MESSAGES_STATE_KEY = 'myagent_messages';
  private static readonly CONVERSATION_STATE_KEY = 'myagent_conversation_v1';
  private static readonly CONVERSATION_MIGRATION_KEY_PREFIX = 'myagent_conversation_sqlite_migrated_v1:';
  private static readonly TOOL_APPROVALS_STATE_KEY = 'myagent_tool_approvals_v1';

  constructor(
    context: vscode.ExtensionContext,
    runtime: AgentRuntime,
    private readonly conversations: ConversationSessionRepository =
      new InMemoryConversationSessionRepository()
  ) {
    this.context = context;
    this.runtime = runtime;
    this.workspaceKey = this.createWorkspaceKey(runtime.workspaceDir);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'out')),
        vscode.Uri.file(path.join(this.context.extensionPath, 'dist'))
      ]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview, this.context.extensionUri);

    vscode.window.onDidChangeActiveColorTheme(() => {
      this.postMessage({ type: 'theme-changed', theme: vscode.window.activeColorTheme.kind });
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        await this.handleMessage(message);
      } catch (error) {
        this.postMessage({
          type: 'error',
          content: error instanceof Error ? error.message : String(error)
        });
      }
    });

    this.updateConfig();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isWebviewToExtensionMessage(message)) {
      console.warn('[FloatingPanel] Ignoring malformed webview message');
      return;
    }
    switch (message.type) {
      case 'webview-ready':
        return this.handleWebviewReady();
      case 'import-config':
        return this.importConfig();
      case 'reload-config':
        return this.handleReloadConfig();
      case 'request-messages':
        return this.handleRequestMessages();
      case 'save-messages':
        return this.handleSaveMessages(message.messages);
      case 'clear-messages':
        return this.handleClearMessages();
      case 'compress-history':
        return this.handleCompressHistory();
      case 'execute-task':
        return this.handleExecuteTask(message);
      case 'cancel-task':
        return this.handleCancelTask(message.requestId);
      case 'create-session':
        return this.handleCreateSession();
      case 'switch-session':
        return this.handleSwitchSession(message.sessionId);
      case 'rename-session':
        return this.handleRenameSession(message.sessionId, message.title);
      case 'delete-session':
        return this.handleDeleteSession(message.sessionId);
      case 'toggle-component':
        return this.handleToggleComponent(message);
      case 'switch-model':
        return this.handleSwitchModel(message.modelName);
    }
  }

  // ========== Message Handlers ==========

  private async handleWebviewReady(): Promise<void> {
    this.updateConfig();
    await this.ensureActiveConversation();
    await this.postSessionState(true);
  }

  async importConfig(): Promise<void> {
    if (!this.ensureIdle('导入配置')) return;
    const uri = await vscode.window.showOpenDialog({
      filters: { JSON: ['json'] },
      canSelectMany: false,
      title: '选择配置文件'
    });

    if (uri && uri[0]) {
      try {
        console.log('[FloatingPanel] Loading config from:', uri[0].fsPath);
        await this.runtime.config.loadSettings(uri[0].fsPath);
        await this.runtime.reload();
        this.session = null;
        this.updateConfig();
      } catch (error) {
        this.postMessage({
          type: 'error',
          content: `配置导入失败: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  async reloadWorkspace(workspaceDir?: string): Promise<void> {
    if (this.activeRequestId) {
      this.pendingWorkspaceReload = { workspaceDir };
      this.cancelRequested = this.session?.cancel() ?? false;
      if (this.cancelRequested) {
        this.postMessage({
          type: 'execution-status',
          requestId: this.activeRequestId,
          phase: 'cancelling',
          detail: '工作区已变化，正在停止当前任务'
        });
      }
      return;
    }
    try {
      await this.runtime.reload(workspaceDir ?? null);
      this.session = null;
      this.sessionStale = false;
      this.workspaceKey = this.createWorkspaceKey(workspaceDir);
      this.activeConversation = null;
      await this.ensureActiveConversation();
      this.updateConfig();
      await this.postSessionState(true);
    } catch (error) {
      this.postMessage({
        type: 'error',
        content: `工作区配置加载失败: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  private async handleReloadConfig(): Promise<void> {
    if (!this.ensureIdle('重载配置')) return;
    const configPath = this.runtime.config.getConfigPath();
    if (configPath) {
      try {
        console.log('[FloatingPanel] Reloading config from:', configPath);
        await this.runtime.config.loadSettings(configPath);
        await this.runtime.reload();
        this.session = null;
        this.updateConfig();
      } catch (error) {
        this.postMessage({
          type: 'error',
          content: `配置重载失败: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  private async handleRequestMessages(): Promise<void> {
    const active = await this.ensureActiveConversation();
    this.postMessage({
      type: 'restore-messages',
      messages: this.projectConversationForWebview(active.snapshot)
    });
  }

  private async handleSaveMessages(_messages: unknown[]): Promise<void> {
    // 兼容旧 Webview。权威会话历史只由 Extension Host 写入 SQLite。
  }

  private async handleClearMessages(): Promise<void> {
    if (!this.ensureIdle('清空会话')) return;
    const active = await this.ensureActiveConversation();
    if (this.session) {
      this.session.reset();
      this.activeConversation = await this.conversations.saveSession(
        this.workspaceKey,
        active.id,
        this.normalizeSnapshot(this.session.getHistorySnapshot()),
        this.session.getTokenUsage(),
        this.getActiveModelName()
      );
    } else {
      this.activeConversation = await this.conversations.saveSession(
        this.workspaceKey,
        active.id,
        { version: 1, items: [] },
        { inputTokens: 0, outputTokens: 0 },
        this.getActiveModelName()
      );
    }
    await this.conversations.clearExecutionTraces(this.workspaceKey, active.id);
    await this.postSessionState(true);
  }

  private async handleCompressHistory(): Promise<void> {
    if (!this.ensureIdle('压缩历史')) return;
    try {
      const active = await this.ensureActiveConversation();
      if (active.snapshot.items.length === 0) {
        this.postMessage({ type: 'agent-response', content: '尚无对话历史可压缩' });
        return;
      }
      const session = this.session ?? this.ensureSession({});
      const compressed = await session.compressHistory();
      if (compressed) {
        await this.persistConversation(session);
        this.postMessage({ type: 'agent-response', content: '历史消息已压缩' });
      } else {
        this.postMessage({ type: 'agent-response', content: '消息数量不足，无需压缩' });
      }
    } catch (e: any) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.postMessage({ type: 'error', content: `压缩失败: ${errorMessage}` });
    }
  }

  private async handleExecuteTask(
    payload: Extract<WebviewToExtensionMessage, { type: 'execute-task' }>
  ): Promise<void> {
    if (this.activeRequestId) {
      this.postMessage({
        type: 'error',
        requestId: payload.requestId,
        content: `已有任务正在执行（requestId=${this.activeRequestId}）`
      });
      this.postMessage({
        type: 'execution-status',
        requestId: payload.requestId,
        phase: 'error',
        detail: '当前会话不允许并发执行'
      });
      return;
    }
    this.activeRequestId = payload.requestId;
    this.cancelRequested = false;
    this.postMessage({
      type: 'execution-status',
      requestId: payload.requestId,
      phase: 'waiting-model'
    });
    let executingSession: Session | null = null;
    try {
      await this.ensureActiveConversation();
      const session = this.ensureSession({
        tools: payload.enabledTools,
        skills: payload.enabledSkills,
        subagents: payload.enabledSubagents
      });
      executingSession = session;
      const result = payload.displayContent === undefined
        ? await session.execute(payload.content, payload.requestId)
        : await session.execute(
            payload.content,
            payload.requestId,
            payload.displayContent
          );
      await this.persistConversation(session);
      await this.persistExecutionTrace(session);
      if (this.activeConversation?.titleSource === 'default') {
        await this.conversations.setGeneratedTitle(
          this.workspaceKey,
          this.activeConversation.id,
          this.deriveSessionTitle(payload.displayContent ?? payload.content)
        );
        this.activeConversation = await this.conversations.getSession(
          this.workspaceKey,
          this.activeConversation.id
        );
      }
      this.postMessage({ type: 'agent-response', requestId: payload.requestId, content: result });
      this.postMessage({
        type: 'execution-status',
        requestId: payload.requestId,
        phase: 'completed'
      });
      const tokenUsage = session.getTokenUsage();
      this.postMessage({
        type: 'token-usage',
        requestId: payload.requestId,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        totalTokens: tokenUsage.totalTokens
      });
      await this.postSessionList();
    } catch (e: any) {
      if (executingSession) {
        await this.persistExecutionTrace(executingSession);
      }
      const errorMessage = e instanceof Error ? e.message : String(e);
      if (this.cancelRequested) {
        this.postMessage({
          type: 'execution-status',
          requestId: payload.requestId,
          phase: 'cancelled',
          detail: '任务已取消'
        });
      } else {
        this.postMessage({ type: 'error', requestId: payload.requestId, content: errorMessage });
        this.postMessage({
          type: 'execution-status',
          requestId: payload.requestId,
          phase: 'error',
          detail: errorMessage
        });
      }
    } finally {
      this.cancelRequested = false;
      if (this.activeRequestId === payload.requestId) {
        this.activeRequestId = null;
      }
      const pendingReload = this.pendingWorkspaceReload;
      this.pendingWorkspaceReload = null;
      if (pendingReload) {
        await this.reloadWorkspace(pendingReload.workspaceDir);
      }
    }
  }

  private async handleCancelTask(requestId: string): Promise<void> {
    if (this.activeRequestId !== requestId) return;
    if (this.session?.cancel()) {
      this.cancelRequested = true;
      this.postMessage({ type: 'execution-status', requestId, phase: 'cancelling' });
    }
  }

  private async handleCreateSession(): Promise<void> {
    if (!this.ensureIdle('新建会话')) return;
    this.activeConversation = await this.conversations.createSession(this.workspaceKey, {
      modelName: this.getActiveModelName()
    });
    this.session = null;
    this.sessionStale = false;
    await this.postSessionState(true);
  }

  private async handleSwitchSession(sessionId: string): Promise<void> {
    if (!this.ensureIdle('切换会话')) return;
    const target = await this.conversations.getSession(this.workspaceKey, sessionId);
    if (!target) throw new Error('目标会话不存在或不属于当前工作区');
    await this.conversations.setActiveSession(this.workspaceKey, sessionId);
    this.activeConversation = target;
    this.session = null;
    this.sessionStale = false;
    await this.postSessionState(true);
  }

  private async handleRenameSession(sessionId: string, title: string): Promise<void> {
    if (!this.ensureIdle('重命名会话')) return;
    await this.conversations.renameSession(this.workspaceKey, sessionId, title);
    if (this.activeConversation?.id === sessionId) {
      this.activeConversation = await this.conversations.getSession(this.workspaceKey, sessionId);
    }
    await this.postSessionList();
  }

  private async handleDeleteSession(sessionId: string): Promise<void> {
    if (!this.ensureIdle('删除会话')) return;
    const deletingActive = this.activeConversation?.id === sessionId;
    await this.conversations.deleteSession(this.workspaceKey, sessionId);
    if (deletingActive) {
      this.session = null;
      this.sessionStale = false;
      this.activeConversation = null;
      await this.ensureActiveConversation();
      await this.postSessionState(true);
      return;
    }
    await this.postSessionList();
  }

  private async handleToggleComponent(
    payload: Extract<WebviewToExtensionMessage, { type: 'toggle-component' }>
  ): Promise<void> {
    if (!this.ensureIdle('切换组件')) return;
    this.runtime.toggleComponent(
      payload.source as ComponentSource,
      payload.category,
      payload.name,
      payload.enabled
    );
    this.sessionStale = true;
    this.postMessage({
      type: 'config-updated',
      config: toPublicSettings(this.runtime.config.getSettings()),
      components: this.runtime.getDiscoveredComponents(),
      configErrors: this.runtime.config.getDiagnostics()
    });
  }

  private async handleSwitchModel(modelName: string): Promise<void> {
    if (!this.ensureIdle('切换模型')) return;
    this.runtime.switchModel(modelName);
    // Session/Executor 会持有创建时的 LLMClient；切换 provider 后必须重建。
    this.session = null;
    this.postMessage({
      type: 'config-updated',
      config: toPublicSettings(this.runtime.config.getSettings()),
      components: this.runtime.getDiscoveredComponents(),
      configErrors: this.runtime.config.getDiagnostics(),
      activeModel: this.getActiveModelName()
    });
  }

  // ========== Session Management ==========

  private ensureSession(enabled: { tools?: string[]; skills?: string[]; subagents?: string[] }): Session {
    if (!this.session || this.sessionStale) {
      this.session = this.runtime.createSession({
        callbacks: {
          onTokenUsage: (u) => this.postMessage({
            type: 'token-usage',
            requestId: this.activeRequestId ?? undefined,
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            totalTokens: (u.inputTokens || 0) + (u.outputTokens || 0)
          }),
          onCompress: async (_inputTokens: number) => {
            // Session 内部的 MessageManager 已经处理阈值；这里直接尝试压缩并通知前端
            const compressed = await this.session?.compressHistory();
            if (compressed) {
              this.postMessage({
                type: 'agent-response',
                requestId: this.activeRequestId ?? undefined,
                content: '[自动压缩] 历史消息已压缩'
              });
            }
          },
          onExecutionStatus: status => {
            this.postMessage({
              type: 'execution-status',
              requestId: this.activeRequestId ?? undefined,
              phase: status.phase,
              callType: status.callType,
              name: status.name,
              executionId: status.executionId,
              callId: status.callId,
              parentCallId: status.parentCallId,
              agentRunId: status.agentRunId,
              agentName: status.agentName,
              agentPath: status.agentPath,
              agentDepth: status.agentDepth
            });
          },
          onComponentCall: call => this.postMessage({
            type: 'component-call-status',
            call
          }),
          onExecutionTraceStarted: trace => this.postMessage({
            type: 'execution-trace-started',
            trace
          }),
          onExecutionTraceFinished: trace => this.postMessage({
            type: 'execution-trace-finished',
            trace
          })
        },
        enabledTools: enabled.tools,
        enabledSkills: enabled.skills,
        enabledSubagents: enabled.subagents,
        requestToolApproval: request => this.requestToolApproval(request),
        sessionId: this.activeConversation?.id,
      });
      if (this.activeConversation) {
        if (this.activeConversation.snapshot.items.length > 0) {
          this.session.restoreHistory(this.activeConversation.snapshot);
        }
        if (typeof (this.session as any).restoreTokenUsage === 'function') {
          this.session.restoreTokenUsage(this.activeConversation.tokenUsage);
        }
      }
      this.sessionStale = false;
    }
    return this.session;
  }

  private async requestToolApproval(request: ToolApprovalRequest): Promise<boolean> {
    const pending = this.toolApprovalQueue.then(() => this.showToolApproval(request));
    this.toolApprovalQueue = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  private async showToolApproval(request: ToolApprovalRequest): Promise<boolean> {
    const approvalKey = JSON.stringify([request.toolName, request.approvalId]);
    const saved = this.context.workspaceState.get<string[]>(
      FloatingPanelProvider.TOOL_APPROVALS_STATE_KEY,
      []
    );
    if (saved.includes(approvalKey)) return true;

    const allowOnce = '允许一次';
    const allowAlways = '一直允许';
    const deny = '拒绝';
    const detail = [
      request.reason,
      `工具：${request.toolName}`,
      `参数预览：${request.argsPreview}`,
      request.rememberable === false
        ? ''
        : '选择“一直允许”后，此工作区内相同工具的同类权限将不再询问。'
    ].filter(Boolean).join('\n');
    const selected = await vscode.window.showWarningMessage(
      detail,
      { modal: true },
      allowOnce,
      ...(request.rememberable === false ? [] : [allowAlways]),
      deny
    );

    if (selected === allowAlways) {
      await this.context.workspaceState.update(
        FloatingPanelProvider.TOOL_APPROVALS_STATE_KEY,
        [...new Set([...saved, approvalKey])]
      );
      return true;
    }
    return selected === allowOnce;
  }

  async clearToolApprovals(): Promise<void> {
    await this.context.workspaceState.update(
      FloatingPanelProvider.TOOL_APPROVALS_STATE_KEY,
      []
    );
    vscode.window.showInformationMessage('MyAgent 已清除当前工作区的始终允许权限');
  }

  // ========== Webview I/O ==========

  private updateConfig(): void {
    this.postMessage({
      type: 'config-loaded',
      configPath: this.runtime.config.getConfigPath(),
      config: toPublicSettings(this.runtime.config.getSettings()),
      models: this.runtime.getAvailableModels().map(toPublicModelConfig),
      activeModel: this.getActiveModelName(),
      components: this.runtime.getDiscoveredComponents(),
      configErrors: this.runtime.config.getDiagnostics()
    });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

  private async persistConversation(session: Session): Promise<void> {
    const active = await this.ensureActiveConversation();
    this.activeConversation = await this.conversations.saveSession(
      this.workspaceKey,
      active.id,
      this.normalizeSnapshot(session.getHistorySnapshot()),
      session.getTokenUsage(),
      this.getActiveModelName()
    );
  }

  private async persistExecutionTrace(session: Session): Promise<void> {
    if (typeof (session as any).getLastExecutionTrace !== 'function') return;
    const trace = session.getLastExecutionTrace();
    if (!trace) return;
    const active = await this.ensureActiveConversation();
    if (typeof (this.conversations as any).saveExecutionTrace !== 'function') return;
    await this.conversations.saveExecutionTrace(
      this.workspaceKey,
      active.id,
      trace
    );
  }

  private async ensureActiveConversation(): Promise<StoredConversationSession> {
    if (this.activeConversation?.workspaceKey === this.workspaceKey) {
      return this.activeConversation;
    }

    const active = await this.conversations.getActiveSession(this.workspaceKey);
    if (active) {
      this.activeConversation = active;
      await this.markLegacyConversationMigrated();
      return active;
    }

    const existing = await this.conversations.listSessions(this.workspaceKey);
    if (existing.length > 0) {
      await this.conversations.setActiveSession(this.workspaceKey, existing[0].id);
      this.activeConversation = await this.conversations.getSession(
        this.workspaceKey,
        existing[0].id
      );
      await this.markLegacyConversationMigrated();
      return this.activeConversation!;
    }

    const legacy = this.isLegacyConversationMigrated()
      ? null
      : this.readLegacyConversation();
    this.activeConversation = await this.conversations.createSession(this.workspaceKey, {
      title: legacy ? this.deriveTitleFromSnapshot(legacy) : '新会话',
      titleSource: legacy ? 'generated' : 'default',
      modelName: this.getActiveModelName(),
      snapshot: legacy ?? undefined
    });
    await this.markLegacyConversationMigrated();
    return this.activeConversation;
  }

  private async postSessionList(): Promise<void> {
    const active = await this.ensureActiveConversation();
    const sessions = await this.conversations.listSessions(this.workspaceKey);
    this.postMessage({
      type: 'session-list',
      sessions: sessions.map(session => this.toSessionDto(session)),
      activeSessionId: active.id
    });
  }

  private async postSessionState(includeMessages: boolean): Promise<void> {
    const active = await this.ensureActiveConversation();
    await this.postSessionList();
    if (includeMessages) {
      const traces = await this.conversations.listExecutionTraces(
        this.workspaceKey,
        active.id
      );
      this.postMessage({
        type: 'session-loaded',
        session: this.toSessionDto(active),
        messages: this.projectConversationForWebview(active.snapshot),
        traces
      });
    }
  }

  private toSessionDto(session: ConversationSessionSummary) {
    return {
      id: session.id,
      title: session.title,
      modelName: session.modelName,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      tokenUsage: { ...session.tokenUsage }
    };
  }

  private createWorkspaceKey(workspaceDir?: string): string {
    return workspaceDir ? path.resolve(workspaceDir) : '__no_workspace__';
  }

  private getActiveModelName(): string | undefined {
    return typeof (this.runtime as any).getActiveModelName === 'function'
      ? this.runtime.getActiveModelName()
      : undefined;
  }

  private deriveSessionTitle(content: string): string {
    const normalized = content
      .replace(/使用(?:tool|skill|subagent):[^。]+回答用户问题[，。]?/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!normalized) return '新会话';
    return normalized.length > 36 ? `${normalized.slice(0, 36)}…` : normalized;
  }

  private deriveTitleFromSnapshot(snapshot: ConversationSnapshot): string {
    const firstUser = snapshot.items.find(item => item.role === 'user');
    return firstUser ? this.deriveSessionTitle(firstUser.content) : '已迁移的会话';
  }

  private normalizeSnapshot(snapshot: ConversationSnapshot | Message[]): ConversationSnapshot {
    if (!Array.isArray(snapshot)) {
      return snapshot;
    }
    const now = Date.now();
    return {
      version: 1,
      items: snapshot.map((message, index) => ({
        id: `compat-message-${now}-${index}`,
        createdAt: now + index,
        role: message.role,
        content: message.content
      }))
    };
  }

  private readLegacyConversation(): ConversationSnapshot | null {
    const saved = this.context.workspaceState.get<ConversationSnapshot | Message[]>(
      FloatingPanelProvider.CONVERSATION_STATE_KEY,
      []
    ) ?? [];
    if (Array.isArray(saved)) {
      if (saved.length === 0) return this.migrateLegacyUiMessages();
      return {
        version: 1,
        items: saved.map((message, index) => ({
          id: `legacy-message-${index}`,
          createdAt: Date.now() + index,
          role: message.role,
          content: message.content
        }))
      };
    }
    if (saved.version === 1 && Array.isArray(saved.items) && saved.items.length > 0) {
      return {
        version: 1,
        items: saved.items.map(item => ({ ...item }))
      };
    }
    return this.migrateLegacyUiMessages();
  }

  private isLegacyConversationMigrated(): boolean {
    return this.context.workspaceState.get<boolean>(
      `${FloatingPanelProvider.CONVERSATION_MIGRATION_KEY_PREFIX}${this.workspaceKey}`,
      false
    ) ?? false;
  }

  private async markLegacyConversationMigrated(): Promise<void> {
    const key = `${FloatingPanelProvider.CONVERSATION_MIGRATION_KEY_PREFIX}${this.workspaceKey}`;
    if (!this.context.workspaceState.get<boolean>(key, false)) {
      await this.context.workspaceState.update(key, true);
    }
  }

  private migrateLegacyUiMessages(): ConversationSnapshot | null {
    const messages = this.context.workspaceState.get<any[]>(
      FloatingPanelProvider.MESSAGES_STATE_KEY,
      []
    ) ?? [];
    if (messages.length === 0) return null;
    const now = Date.now();
    return {
      version: 1,
      items: messages
        .filter(message => message && typeof message.content === 'string')
        .map((message, index) => {
          const base = {
            id: `legacy-ui-${index}`,
            createdAt: now + index,
            content: message.content
          };
          if (message.type === 'tool' && message.toolCallStatus) {
            return {
              ...base,
              role: 'tool' as const,
              callId: `legacy-call-${index}`,
              callType: message.toolCallStatus.type,
              name: message.toolCallStatus.name,
              status: message.toolCallStatus.status === 'error' ? 'error' as const : 'success' as const
            };
          }
          return {
            ...base,
            role: message.role === 'user' ? 'user' as const : 'assistant' as const
          };
        })
    };
  }

  private ensureIdle(action: string): boolean {
    if (!this.activeRequestId) return true;
    vscode.window.showWarningMessage(
      `MyAgent 正在执行任务，暂时不能${action}。请先停止或等待任务完成。`
    );
    return false;
  }

  private projectConversationForWebview(
    snapshot: ConversationSnapshot | Message[]
  ): Array<Record<string, unknown>> {
    if (Array.isArray(snapshot)) {
      return snapshot.map(message => ({
        role: message.role === 'assistant' ? 'agent' : message.role,
        content: message.content
      }));
    }

    const parser = new XMLParser();
    const projected: Array<Record<string, unknown>> = [];
    for (const item of snapshot.items) {
      if (item.visibility === 'hidden') continue;
      if (item.role === 'tool') {
        projected.push({
          role: 'agent',
          type: 'tool',
          turnId: item.turnId,
          content: item.status === 'success'
            ? `${item.callType} ${item.name} 已完成\n${item.content}`
            : `${item.callType} ${item.name} 失败\n${item.content}`,
          toolCallStatus: {
            type: item.callType,
            name: item.name,
            status: item.status,
            result: item.status === 'success' ? item.content : undefined,
            error: item.status === 'error' ? item.content : undefined
          }
        });
        continue;
      }

      if (item.role === 'assistant') {
        const visibleContent = item.displayContent ?? parser.stripXmlTags(item.content);
        if (!visibleContent) continue;
        projected.push({ role: 'agent', content: visibleContent, turnId: item.turnId });
        continue;
      }
      if (item.role === 'system') {
        projected.push({
          role: 'agent',
          content: item.displayContent ?? item.content,
          turnId: item.turnId
        });
        continue;
      }
      projected.push({
        role: 'user',
        content: item.displayContent ?? item.content,
        turnId: item.turnId
      });
    }
    return projected;
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline';">
    <title>MyAgent</title>
  <style>
    body { font-family: system-ui; margin: 0; padding: 0; }
    #root { height: 100vh; width: 100%; overflow: auto; }
    .loading { color: #666; font-size: 14px; padding: 20px; }
    .error { color: #f00; font-size: 14px; padding: 20px; }
  </style>
</head>
<body>
  <div id="root"><div class="loading">加载中...</div></div>

  <script>
    try {
      if (typeof acquireVsCodeApi === 'function') {
        window.vscode = acquireVsCodeApi();
      }
    } catch(e) {
      document.getElementById('root').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
      console.error(e);
    }
  </script>

  <!-- Load after the VS Code API is available. React is bundled inside. -->
  <script src="${scriptUri.toString()}"></script>
</body>
</html>`;
  }
}
