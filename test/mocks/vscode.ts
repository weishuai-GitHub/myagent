export const window = {
  activeColorTheme: { kind: 2 },
  onDidChangeActiveColorTheme: jest.fn(),
  showOpenDialog: jest.fn(),
  showWarningMessage: jest.fn(),
  showInformationMessage: jest.fn(),
  registerWebviewViewProvider: jest.fn(),
  registerCommand: jest.fn(),
  workspaceFolders: [
    {
      uri: { fsPath: '/workspace' }
    }
  ]
};

export const commands = {
  registerCommand: jest.fn()
};

export const workspace = {
  workspaceFolders: [
    {
      uri: { fsPath: '/workspace' }
    }
  ]
};
