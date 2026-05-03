import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager } from '../src/config/manager';
import { AgentRuntime } from '../src/agent';
import { MessageManager } from '../src/message/MessageManager';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private configManager: ConfigManager;
  private agentRuntime: AgentRuntime;
  private messageManager: MessageManager;

  constructor(
    private context: vscode.ExtensionContext,
    configManager: ConfigManager,
    agentRuntime: AgentRuntime
  ) {
    this.messageManager = new MessageManager();
    this.configManager = configManager;
    this.agentRuntime = agentRuntime;
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'out')),
        vscode.Uri.file(path.join(this.context.extensionPath, 'dist')),
      ]
    };

    webviewView.webview.html = this.getHtml(webviewView.webview, this.context.extensionUri);

    // 监听主题变化
    vscode.window.onDidChangeActiveColorTheme(() => {
      this.postMessage({ type: 'theme-changed', theme: vscode.window.activeColorTheme.kind });
    });

    // 处理webview消息
    webviewView.webview.onDidReceiveMessage(async (message) => {
      console.log('Received message from webview:', message);
      const messageType = message.type;

      if (messageType === 'webview-ready') {
        await this.initRuntime();
        this.updateConfig();
      } else if (messageType === 'import-config') {
        const uri = await vscode.window.showOpenDialog({
          filters: { JSON: ['json'] },
          canSelectMany: false,
          title: '选择配置文件'
        });

        if (uri && uri[0]) {
          console.log('Loading config from:', uri[0].fsPath);
          await this.configManager.loadSettings(uri[0].fsPath);
          await this.initRuntime();
          this.updateConfig();
        }
      } else if (messageType === 'execute-task') {
        // 根据前端传入的启用组件列表更新配置，然后重新初始化
        this.messageManager.setAvailableComponentsFromList(
          message.enabledTools || [],
          message.enabledSkills || [],
          message.enabledSubagents || []
        );

        // 将用户问题追加到 MessageManager
        this.messageManager.addUserMessage(message.content);

        this.postMessage({ type: 'agent-response', content: '处理中...' });
        try {
          const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
          const result = await this.agentRuntime.execute(this.messageManager, workspaceDir);

          this.postMessage({ type: 'agent-response', content: result });
        } catch (e: any) {
          // 出错时回滚用户消息
          this.messageManager.popLast();
          const errorMessage = e instanceof Error ? e.message : String(e);
          this.postMessage({ type: 'error', content: errorMessage });
        }
      } else if (messageType === 'toggle-component') {
        this.configManager.setComponentEnabled(
          message.source,
          message.category,
          message.name,
          message.enabled
        );
        this.postMessage({
          type: 'config-updated',
          config: this.configManager.getSettings(),
          components: this.agentRuntime.getDiscoveredComponents()
        });
      } else if (messageType === 'switch-model') {
        this.agentRuntime.switchModel(message.modelName);
      }
    });
  }

  /**
   * 初始化 AgentRuntime，将系统提示词和组件描述注入到 MessageManager。
   * 在导入配置后或首次需要时调用。
   */
  async initRuntime(): Promise<void> {
    try {
      await this.agentRuntime.initialize(this.messageManager);
    } catch (e) {
      console.error('Failed to initialize AgentRuntime:', e);
    }
  }

  updateConfig(): void {
    this.postMessage({
      type: 'config-loaded',
      configPath: this.configManager.getConfigPath(),
      config: this.configManager.getSettings(),
      models: this.configManager.getAvailableModels(),
      activeModel: this.configManager.getActiveModel()?.name,
      components: this.agentRuntime.getDiscoveredComponents()
    });
  }

  private postMessage(message: any): void {
    this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
    console.log(`[MyAgent]: webviewJs uri: "${scriptUri.toString()}"`);
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
        console.log('VSCode API ready');
      }
      // React 渲染由 webview.js bundle 内部完成，无需在此手动调用
    } catch(e) {
      document.getElementById('root').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
      console.error(e);
    }
  </script>
</body>
</html>`;
  }
}
