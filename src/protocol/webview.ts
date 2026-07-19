import { DiscoveredComponents } from '../agent/component/types';
import { PublicModelConfig, PublicSettings } from '../agent/config/public-dto';
import { ToolCallStatus } from '../agent/types';

export type ComponentCategory = 'tools' | 'skills' | 'subagents';

export type WebviewToExtensionMessage =
  | { type: 'webview-ready' }
  | { type: 'import-config' }
  | { type: 'reload-config' }
  | { type: 'request-messages' }
  | { type: 'save-messages'; messages: unknown[] }
  | { type: 'clear-messages' }
  | { type: 'compress-history' }
  | {
      type: 'execute-task';
      requestId: string;
      content: string;
      enabledTools?: string[];
      enabledSkills?: string[];
      enabledSubagents?: string[];
    }
  | { type: 'cancel-task'; requestId: string }
  | {
      type: 'toggle-component';
      source: 'workspace' | 'home';
      category: ComponentCategory;
      name: string;
      enabled: boolean;
    }
  | { type: 'switch-model'; modelName: string };

export interface ConfigDiagnosticDto {
  filePath: string;
  fieldPath: string;
  message: string;
}

export type ExtensionToWebviewMessage =
  | {
      type: 'config-loaded';
      configPath: string;
      config: PublicSettings | null;
      models: PublicModelConfig[];
      activeModel?: string;
      components: DiscoveredComponents;
      configErrors: ConfigDiagnosticDto[];
    }
  | {
      type: 'config-updated';
      config: PublicSettings | null;
      components: DiscoveredComponents;
      configErrors: ConfigDiagnosticDto[];
      configPath?: string;
      models?: PublicModelConfig[];
      activeModel?: string;
    }
  | { type: 'restore-messages'; messages: unknown[] }
  | { type: 'agent-response'; content: string; requestId?: string }
  | { type: 'error'; content: string; message?: string; requestId?: string }
  | {
      type: 'execution-status';
      phase: 'waiting-model' | 'running-component' | 'completed' | 'error' | 'cancelling' | 'cancelled';
      requestId?: string;
      callType?: ToolCallStatus['type'];
      name?: string;
      detail?: string;
    }
  | {
      type: 'tool-call-status';
      requestId?: string;
      callType: ToolCallStatus['type'];
      name: string;
      status: ToolCallStatus['status'];
      result?: string;
      error?: string;
    }
  | {
      type: 'token-usage';
      requestId?: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  | { type: 'theme-changed'; theme: number };

const inboundTypes = new Set<WebviewToExtensionMessage['type']>([
  'webview-ready',
  'import-config',
  'reload-config',
  'request-messages',
  'save-messages',
  'clear-messages',
  'compress-history',
  'execute-task',
  'cancel-task',
  'toggle-component',
  'switch-model'
]);

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as any).type !== 'string' ||
    !inboundTypes.has((value as any).type)
  ) {
    return false;
  }
  const message = value as any;
  switch (message.type as WebviewToExtensionMessage['type']) {
    case 'execute-task':
      return typeof message.requestId === 'string' &&
        message.requestId.trim() !== '' &&
        typeof message.content === 'string';
    case 'cancel-task':
      return typeof message.requestId === 'string' && message.requestId.trim() !== '';
    case 'save-messages':
      return Array.isArray(message.messages);
    case 'toggle-component':
      return (message.source === 'workspace' || message.source === 'home') &&
        ['tools', 'skills', 'subagents'].includes(message.category) &&
        typeof message.name === 'string' &&
        typeof message.enabled === 'boolean';
    case 'switch-model':
      return typeof message.modelName === 'string' && message.modelName.trim() !== '';
    default:
      return true;
  }
}
