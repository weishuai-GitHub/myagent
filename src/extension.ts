import * as vscode from 'vscode';
import { AgentRuntime } from './agent/runtime';
import { FloatingPanelProvider } from './FloatingPanelProvider';

export async function activate(context: vscode.ExtensionContext) {
  console.log('MyAgent extension is activating...');
  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  let runtime: AgentRuntime;
  try {
    runtime = await AgentRuntime.create({ workspaceDir });
  } catch (e: any) {
    console.error('Failed to initialize AgentRuntime:', e);
    vscode.window.showErrorMessage(`MyAgent 初始化失败: ${e?.message ?? e}`);
    return;
  }

  const floatingPanelProvider = new FloatingPanelProvider(context, runtime);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('myagent-sidebar-view', floatingPanelProvider)
  );

  const importConfigCommand = vscode.commands.registerCommand('myagent.importConfig', async () => {
    console.log('Import config command triggered');
    const uri = await vscode.window.showOpenDialog({
      filters: { JSON: ['json'] },
      canSelectMany: false,
      title: '选择配置文件'
    });

    if (uri && uri[0]) {
      console.log('Loading config from:', uri[0].fsPath);
      await runtime.config.loadSettings(uri[0].fsPath);
      await runtime.reload();
    }
  });

  context.subscriptions.push(importConfigCommand);

  const clearToolApprovalsCommand = vscode.commands.registerCommand(
    'myagent.clearToolApprovals',
    () => floatingPanelProvider.clearToolApprovals()
  );
  context.subscriptions.push(clearToolApprovalsCommand);

  console.log('MyAgent extension activated successfully');
}

export function deactivate() {
  console.log('MyAgent extension is deactivating...');
}
