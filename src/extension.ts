import * as vscode from 'vscode';
import * as path from 'path';
import { AgentRuntime } from './agent';
import { FloatingPanelProvider } from './FloatingPanelProvider';

export async function activate(context: vscode.ExtensionContext) {
  console.log('MyAgent extension is activating...');
  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const myagentDir = path.join(workspaceDir || '', '.myagent');
  const agentRuntime = new AgentRuntime(myagentDir);
  const floatingPanelProvider = new FloatingPanelProvider(context, agentRuntime);

  // 注册 webview provider - 固定在 sidebar
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('myagent-sidebar-view', floatingPanelProvider)
  );

  // 注册导入配置命令
  const importConfigCommand = vscode.commands.registerCommand('myagent.importConfig', async () => {
    console.log('Import config command triggered');
    const uri = await vscode.window.showOpenDialog({
      filters: { JSON: ['json'] },
      canSelectMany: false,
      title: '选择配置文件'
    });

    if (uri && uri[0]) {
      console.log('Loading config from:', uri[0].fsPath);
      await agentRuntime.configManager.loadSettings(uri[0].fsPath);
    }
  });

  context.subscriptions.push(importConfigCommand);

  console.log('MyAgent extension activated successfully');
}

export function deactivate() {
  console.log('MyAgent extension is deactivating...');
}
