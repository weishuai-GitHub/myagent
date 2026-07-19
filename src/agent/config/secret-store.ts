import * as vscode from 'vscode';

export interface SecretStore {
  get(reference: string): Promise<string | undefined>;
  store(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export class VSCodeSecretStore implements SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(reference: string): Promise<string | undefined> {
    return this.secrets.get(reference);
  }

  async store(reference: string, value: string): Promise<void> {
    await this.secrets.store(reference, value);
  }

  async delete(reference: string): Promise<void> {
    await this.secrets.delete(reference);
  }
}

export function defaultApiKeyReference(modelName: string, scope?: string): string {
  const scopedName = scope
    ? `${encodeURIComponent(scope)}.${encodeURIComponent(modelName)}`
    : encodeURIComponent(modelName);
  return `myagent.models.${scopedName}.apiKey`;
}
