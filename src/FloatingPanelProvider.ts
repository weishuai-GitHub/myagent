import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from './agent';
import { MessageManager } from './agent/message/MessageManager';

export class FloatingPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private agentRuntime: AgentRuntime;
  private messageManager: MessageManager;
  private context: vscode.ExtensionContext;

  private static readonly MESSAGES_STATE_KEY = 'myagent_messages';

  constructor(
    context: vscode.ExtensionContext,
    agentRuntime: AgentRuntime
  ) {
    this.context = context;
    this.agentRuntime = agentRuntime;
    this.messageManager = new MessageManager();
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

    // Listen for theme changes
    vscode.window.onDidChangeActiveColorTheme(() => {
      this.postMessage({ type: 'theme-changed', theme: vscode.window.activeColorTheme.kind });
    });

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log('[FloatingPanel] Received message from webview:', message);
      await this.handleMessage(message);
    });

    // Initialize on view ready
    this.initRuntime();
    this.updateConfig();
  }

  /**
   * Handle messages from the webview
   */
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
    await this.initRuntime();
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
      await this.agentRuntime.configManager.loadSettings(uri[0].fsPath);
      await this.initRuntime();
      this.updateConfig();
    }
  }

  private async handleReloadConfig(): Promise<void> {
    const configPath = this.agentRuntime.configManager.getConfigPath();
    if (configPath) {
      console.log('[FloatingPanel] Reloading config from:', configPath);
      await this.agentRuntime.configManager.loadSettings(configPath);
      await this.initRuntime();
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
    this.messageManager.clearHistory();
  }

  private async handleCompressHistory(): Promise<void> {
    try {
      const compressed = await this.agentRuntime.compressHistory(this.messageManager);
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
    this.messageManager.setAvailableComponentsFromList(
      payload.enabledTools || [],
      payload.enabledSkills || [],
      payload.enabledSubagents || []
    );

    this.messageManager.addUserMessage(payload.content);

    // 设置工具调用状态回调，实时推送到 webview
    this.agentRuntime.setToolCallCallback((status) => {
      this.postMessage({ type: 'tool-call-status', callType: status.type, name: status.name, status: status.status, result: status.result, error: status.error });
    });

    // 设置 token 使用回调，累积到 MessageManager
    this.agentRuntime.setTokenUsageCallback((usage) => {
      this.messageManager.addTokenUsage(usage);
    });

    // 设置压缩回调：inputTokens 超阈值时自动压缩
    this.agentRuntime.setCompressCallback(async (inputTokens: number) => {
      if (!this.messageManager.needsCompression(inputTokens)) {
        return;
      }
      const compressed = await this.agentRuntime.compressHistory(this.messageManager);
      if (compressed) {
        this.postMessage({ type: 'agent-response', content: '[自动压缩] 历史消息已压缩' });
      }
    });

    this.postMessage({ type: 'agent-response', content: '处理中...' });
    try {
      const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      const result = await this.agentRuntime.execute(this.messageManager, workspaceDir);
      this.postMessage({ type: 'agent-response', content: result });
      // 推送 token 使用统计到前端
      const tokenUsage = this.messageManager.getTokenUsage();
      this.postMessage({ type: 'token-usage', inputTokens: tokenUsage.inputTokens, outputTokens: tokenUsage.outputTokens, totalTokens: tokenUsage.totalTokens });
    } catch (e: any) {
      this.messageManager.popLast();
      const errorMessage = e instanceof Error ? e.message : String(e);
      this.postMessage({ type: 'error', content: errorMessage });
    } finally {
      // 清除回调
      this.agentRuntime.setToolCallCallback(() => {});
      this.agentRuntime.setTokenUsageCallback(() => {});
      this.agentRuntime.setCompressCallback(undefined);
    }
  }

  private async handleToggleComponent(payload: any): Promise<void> {
    this.agentRuntime.configManager.setComponentEnabled(
      payload.source,
      payload.category,
      payload.name,
      payload.enabled
    );
    this.postMessage({
      type: 'config-updated',
      config: this.agentRuntime.configManager.getSettings(),
      components: this.agentRuntime.getDiscoveredComponents()
    });
  }

  private async handleSwitchModel(payload: any): Promise<void> {
    this.agentRuntime.switchModel(payload.modelName);
  }

  /**
   * Initialize AgentRuntime with system prompt and component descriptions.
   */
  private async initRuntime(): Promise<void> {
    try {
      await this.agentRuntime.initialize(this.messageManager);
    } catch (e) {
      console.error('[FloatingPanel] Failed to initialize AgentRuntime:', e);
    }
  }

  /**
   * Send updated config to the webview
   */
  private updateConfig(): void {
    this.postMessage({
      type: 'config-loaded',
      configPath: this.agentRuntime.configManager.getConfigPath(),
      config: this.agentRuntime.configManager.getSettings(),
      models: this.agentRuntime.configManager.getAvailableModels(),
      activeModel: this.agentRuntime.configManager.getActiveModel()?.name,
      components: this.agentRuntime.getDiscoveredComponents()
    });
  }

  /**
   * Post a message to the webview
   */
  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  /**
   * Generate the HTML for the webview
   */
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

  <!-- Load our app bundle (React is bundled inside) -->
  <script src="${scriptUri.toString()}"></script>

  <script>
    try {
      // Expose vscode API
      if (typeof acquireVsCodeApi === 'function') {
        window.vscode = acquireVsCodeApi();
        window.vscode.postMessage({ type: 'webview-ready' });
        console.log('[FloatingPanel] VSCode API ready');
      }
      // React rendering is done by webview.js bundle internally
    } catch(e) {
      document.getElementById('root').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
      console.error(e);
    }
  </script>
</body>
</html>`;
  }
}
