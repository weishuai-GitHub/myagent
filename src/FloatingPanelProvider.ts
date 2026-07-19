import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from './agent/runtime';
import { Session } from './agent/session';
import { ComponentSource } from './agent/component/types';
import { ToolApprovalRequest } from './agent/component/tools/types';
import { toPublicModelConfig, toPublicSettings } from './agent/config/public-dto';
import { Message } from './agent/types';
import { ConversationSnapshot } from './agent/conversation/types';
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
  private context: vscode.ExtensionContext;
  private runtime: AgentRuntime;

  private static readonly MESSAGES_STATE_KEY = 'myagent_messages';
  private static readonly CONVERSATION_STATE_KEY = 'myagent_conversation_v1';
  private static readonly TOOL_APPROVALS_STATE_KEY = 'myagent_tool_approvals_v1';

  constructor(context: vscode.ExtensionContext, runtime: AgentRuntime) {
    this.context = context;
    this.runtime = runtime;
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
      case 'toggle-component':
        return this.handleToggleComponent(message);
      case 'switch-model':
        return this.handleSwitchModel(message.modelName);
    }
  }

  // ========== Message Handlers ==========

  private async handleWebviewReady(): Promise<void> {
    this.updateConfig();
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
      this.updateConfig();
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
    const savedConversation = this.context.workspaceState.get<ConversationSnapshot | Message[]>(
      FloatingPanelProvider.CONVERSATION_STATE_KEY,
      []
    ) ?? [];
    const hasConversation = Array.isArray(savedConversation)
      ? savedConversation.length > 0
      : savedConversation.items.length > 0;
    if (hasConversation) {
      this.postMessage({
        type: 'restore-messages',
        messages: this.projectConversationForWebview(savedConversation)
      });
      return;
    }
    const savedMessages = this.context.workspaceState.get<any[]>(FloatingPanelProvider.MESSAGES_STATE_KEY);
    this.postMessage({ type: 'restore-messages', messages: savedMessages || [] });
  }

  private async handleSaveMessages(messages: unknown[]): Promise<void> {
    await this.context.workspaceState.update(FloatingPanelProvider.MESSAGES_STATE_KEY, messages);
  }

  private async handleClearMessages(): Promise<void> {
    if (!this.ensureIdle('清空会话')) return;
    await this.context.workspaceState.update(FloatingPanelProvider.MESSAGES_STATE_KEY, []);
    await this.context.workspaceState.update(FloatingPanelProvider.CONVERSATION_STATE_KEY, []);
    this.session?.reset();
  }

  private async handleCompressHistory(): Promise<void> {
    if (!this.ensureIdle('压缩历史')) return;
    try {
      if (!this.session) {
        this.postMessage({ type: 'agent-response', content: '尚无对话历史可压缩' });
        return;
      }
      const compressed = await this.session.compressHistory();
      if (compressed) {
        await this.persistConversation(this.session);
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
    try {
      const session = this.ensureSession({
        tools: payload.enabledTools,
        skills: payload.enabledSkills,
        subagents: payload.enabledSubagents
      });
      const result = await session.execute(payload.content, payload.requestId);
      await this.persistConversation(session);
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
    } catch (e: any) {
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
      activeModel: this.runtime.getActiveModelName()
    });
  }

  // ========== Session Management ==========

  private ensureSession(enabled: { tools?: string[]; skills?: string[]; subagents?: string[] }): Session {
    if (!this.session || this.sessionStale) {
      this.session = this.runtime.createSession({
        callbacks: {
          onToolCall: (s) => this.postMessage({
            type: 'tool-call-status',
            requestId: this.activeRequestId ?? undefined,
            callType: s.type,
            name: s.name,
            status: s.status,
            result: s.result,
            error: s.error
          }),
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
              name: status.name
            });
          }
        },
        enabledTools: enabled.tools,
        enabledSkills: enabled.skills,
        enabledSubagents: enabled.subagents,
        requestToolApproval: request => this.requestToolApproval(request),
      });
      const savedConversation = this.context.workspaceState.get<ConversationSnapshot | Message[]>(
        FloatingPanelProvider.CONVERSATION_STATE_KEY,
        []
      ) ?? [];
      const hasSavedConversation = Array.isArray(savedConversation)
        ? savedConversation.length > 0
        : savedConversation.items.length > 0;
      if (hasSavedConversation) {
        this.session.restoreHistory(savedConversation);
      }
      this.sessionStale = false;
    }
    return this.session;
  }

  private async requestToolApproval(request: ToolApprovalRequest): Promise<boolean> {
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
      activeModel: this.runtime.getActiveModelName(),
      components: this.runtime.getDiscoveredComponents(),
      configErrors: this.runtime.config.getDiagnostics()
    });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.view?.webview.postMessage(message);
  }

  private async persistConversation(session: Session): Promise<void> {
    await this.context.workspaceState.update(
      FloatingPanelProvider.CONVERSATION_STATE_KEY,
      session.getHistorySnapshot()
    );
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
      if (item.role === 'tool') {
        projected.push({
          role: 'agent',
          type: 'tool',
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
        const visibleContent = parser.stripXmlTags(item.content);
        if (!visibleContent) continue;
        projected.push({ role: 'agent', content: visibleContent });
        continue;
      }
      if (item.role === 'system') {
        projected.push({ role: 'agent', content: item.content });
        continue;
      }
      projected.push({ role: 'user', content: item.content });
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
