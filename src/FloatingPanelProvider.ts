import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from './agent/runtime';
import { Session } from './agent/session';
import { ComponentSource } from './agent/component/types';
import { ToolApprovalRequest } from './agent/component/tools/types';

export class FloatingPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private session: Session | null = null;
  private sessionStale = false;
  private context: vscode.ExtensionContext;
  private runtime: AgentRuntime;

  private static readonly MESSAGES_STATE_KEY = 'myagent_messages';
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
      console.log('[FloatingPanel] Received message from webview:', message);
      await this.handleMessage(message);
    });

    this.updateConfig();
  }

  private async handleMessage(message: any): Promise<void> {
    const { type, ...payload } = message;

    const handlers: Record<string, (payload: any) => Promise<void>> = {
      'webview-ready': () => this.handleWebviewReady(),
      'import-config': () => this.handleImportConfig(),
      'reload-config': () => this.handleReloadConfig(),
      'request-messages': () => this.handleRequestMessages(),
      'save-messages': () => this.handleSaveMessages(payload),
      'clear-messages': () => this.handleClearMessages(),
      'compress-history': () => this.handleCompressHistory(),
      'execute-task': () => this.handleExecuteTask(payload),
      'toggle-component': () => this.handleToggleComponent(payload),
      'switch-model': () => this.handleSwitchModel(payload),
    };

    const handler = handlers[type];
    if (handler) {
      await handler(payload);
    } else {
      console.warn('[FloatingPanel] Unknown message type:', type);
    }
  }

  // ========== Message Handlers ==========

  private async handleWebviewReady(): Promise<void> {
    this.updateConfig();
  }

  private async handleImportConfig(): Promise<void> {
    const uri = await vscode.window.showOpenDialog({
      filters: { JSON: ['json'] },
      canSelectMany: false,
      title: '选择配置文件'
    });

    if (uri && uri[0]) {
      console.log('[FloatingPanel] Loading config from:', uri[0].fsPath);
      await this.runtime.config.loadSettings(uri[0].fsPath);
      await this.runtime.reload();
      this.session = null;
      this.updateConfig();
    }
  }

  private async handleReloadConfig(): Promise<void> {
    const configPath = this.runtime.config.getConfigPath();
    if (configPath) {
      console.log('[FloatingPanel] Reloading config from:', configPath);
      await this.runtime.config.loadSettings(configPath);
      await this.runtime.reload();
      this.session = null;
      this.updateConfig();
    }
  }

  private async handleRequestMessages(): Promise<void> {
    const savedMessages = this.context.workspaceState.get<any[]>(FloatingPanelProvider.MESSAGES_STATE_KEY);
    this.postMessage({ type: 'restore-messages', messages: savedMessages || [] });
  }

  private async handleSaveMessages(payload: any): Promise<void> {
    await this.context.workspaceState.update(FloatingPanelProvider.MESSAGES_STATE_KEY, payload.messages);
  }

  private async handleClearMessages(): Promise<void> {
    await this.context.workspaceState.update(FloatingPanelProvider.MESSAGES_STATE_KEY, []);
    this.session?.reset();
  }

  private async handleCompressHistory(): Promise<void> {
    try {
      if (!this.session) {
        this.postMessage({ type: 'agent-response', content: '尚无对话历史可压缩' });
        return;
      }
      const compressed = await this.session.compressHistory();
      if (compressed) {
        this.postMessage({ type: 'agent-response', content: '历史消息已压缩' });
      } else {
        this.postMessage({ type: 'agent-response', content: '消息数量不足，无需压缩' });
      }
    } catch (e: any) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.postMessage({ type: 'error', content: `压缩失败: ${errorMessage}` });
    }
  }

  private async handleExecuteTask(payload: any): Promise<void> {
    const session = this.ensureSession({
      tools: payload.enabledTools,
      skills: payload.enabledSkills,
      subagents: payload.enabledSubagents
    });

    this.postMessage({ type: 'execution-status', phase: 'waiting-model' });
    try {
      const result = await session.execute(payload.content);
      this.postMessage({ type: 'agent-response', content: result });
      this.postMessage({ type: 'execution-status', phase: 'completed' });
      const tokenUsage = session.getTokenUsage();
      this.postMessage({
        type: 'token-usage',
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        totalTokens: tokenUsage.totalTokens
      });
    } catch (e: any) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.postMessage({ type: 'error', content: errorMessage });
      this.postMessage({ type: 'execution-status', phase: 'error', detail: errorMessage });
    }
  }

  private async handleToggleComponent(payload: any): Promise<void> {
    this.runtime.toggleComponent(
      payload.source as ComponentSource,
      payload.category,
      payload.name,
      payload.enabled
    );
    this.sessionStale = true;
    this.postMessage({
      type: 'config-updated',
      config: this.runtime.config.getSettings(),
      components: this.runtime.getDiscoveredComponents()
    });
  }

  private async handleSwitchModel(payload: any): Promise<void> {
    this.runtime.switchModel(payload.modelName);
    // Session/Executor 会持有创建时的 LLMClient；切换 provider 后必须重建。
    this.session = null;
  }

  // ========== Session Management ==========

  private ensureSession(enabled: { tools?: string[]; skills?: string[]; subagents?: string[] }): Session {
    if (!this.session || this.sessionStale) {
      this.session = this.runtime.createSession({
        callbacks: {
          onToolCall: (s) => this.postMessage({
            type: 'tool-call-status',
            callType: s.type,
            name: s.name,
            status: s.status,
            result: s.result,
            error: s.error
          }),
          onTokenUsage: (u) => this.postMessage({
            type: 'token-usage',
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            totalTokens: (u.inputTokens || 0) + (u.outputTokens || 0)
          }),
          onCompress: async (_inputTokens: number) => {
            // Session 内部的 MessageManager 已经处理阈值；这里直接尝试压缩并通知前端
            const compressed = await this.session?.compressHistory();
            if (compressed) {
              this.postMessage({ type: 'agent-response', content: '[自动压缩] 历史消息已压缩' });
            }
          },
          onExecutionStatus: status => {
            this.postMessage({
              type: 'execution-status',
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
      config: this.runtime.config.getSettings(),
      models: this.runtime.getAvailableModels(),
      activeModel: this.runtime.getActiveModelName(),
      components: this.runtime.getDiscoveredComponents()
    });
  }

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    console.log(`[FloatingPanel] webview.js uri: "${scriptUri.toString()}"`);

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
