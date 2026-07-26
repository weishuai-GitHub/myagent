import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { AgentRuntime } from './agent/runtime';
import { FloatingPanelProvider } from './FloatingPanelProvider';
import { VSCodeSecretStore } from './agent/config/secret-store';
import { SqliteConversationSessionRepository } from './agent/conversation/session-repository';

let conversationRepository: SqliteConversationSessionRepository | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('MyAgent extension is activating...');
  const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const secretStore = new VSCodeSecretStore(context.secrets);

  let runtime: AgentRuntime;
  try {
    runtime = await AgentRuntime.create({
      workspaceDir,
      secretStore
    });
    conversationRepository = await SqliteConversationSessionRepository.open({
      storageDir: path.join(os.homedir(), '.myagent', 'history'),
      wasmPath: path.join(context.extensionPath, 'dist', 'sql-wasm.wasm')
    });
  } catch (e: any) {
    console.error('Failed to initialize AgentRuntime:', e);
    vscode.window.showErrorMessage(`MyAgent 初始化失败: ${e?.message ?? e}`);
    return;
  }

  const floatingPanelProvider = new FloatingPanelProvider(
    context,
    runtime,
    conversationRepository
  );

  try {
    const migrated = await runtime.config.migrateLegacyApiKeys(
      secretStore,
      async modelNames => {
        const migrate = '迁移到安全存储';
        const choice = await vscode.window.showWarningMessage(
          `检测到 ${modelNames.length} 个模型仍在 settings.json 中保存明文 API Key。是否迁移到 VS Code SecretStorage？`,
          migrate,
          '暂不'
        );
        return choice === migrate;
      }
    );
    if (migrated > 0) {
      await runtime.reload();
      vscode.window.showInformationMessage(`MyAgent 已安全迁移 ${migrated} 个 API Key`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `MyAgent API Key 迁移失败，原配置未被破坏: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('myagent-sidebar-view', floatingPanelProvider)
  );

  const importConfigCommand = vscode.commands.registerCommand('myagent.importConfig', async () => {
    console.log('Import config command triggered');
    await floatingPanelProvider.importConfig();
  });

  context.subscriptions.push(importConfigCommand);

  const clearToolApprovalsCommand = vscode.commands.registerCommand(
    'myagent.clearToolApprovals',
    () => floatingPanelProvider.clearToolApprovals()
  );
  context.subscriptions.push(clearToolApprovalsCommand);

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    // 多根工作区当前采用“第一个 folder 为活动工作区”的明确策略。
    const nextWorkspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    await floatingPanelProvider.reloadWorkspace(nextWorkspaceDir);
  }));

  console.log('MyAgent extension activated successfully');
}

export async function deactivate() {
  await conversationRepository?.close();
  conversationRepository = null;
  console.log('MyAgent extension is deactivating...');
}
