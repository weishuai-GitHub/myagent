import { ModelConfig, Settings } from '../types';

/**
 * 仅供 Webview 展示的配置。扩展宿主中的 apiKey、env、baseUrl、
 * codexCommand 和重试细节不得跨越 Webview 信任边界。
 */
export interface PublicModelConfig {
  name: string;
  provider: ModelConfig['provider'];
  model: string;
  auth: NonNullable<ModelConfig['auth']>;
}

export interface PublicSettings {
  activeModel: string;
  enabledTools: string[];
  enabledSkills: string[];
  enabledSubagents: string[];
  maxRounds: number;
}

export function toPublicModelConfig(model: ModelConfig): PublicModelConfig {
  return {
    name: model.name,
    provider: model.provider,
    model: model.model,
    auth: model.auth ?? 'api-key'
  };
}

export function toPublicSettings(settings: Settings | null): PublicSettings | null {
  if (!settings) return null;
  return {
    activeModel: settings.activeModel,
    enabledTools: [...(settings.enabledTools ?? [])],
    enabledSkills: [...(settings.enabledSkills ?? [])],
    enabledSubagents: [...(settings.enabledSubagents ?? [])],
    maxRounds: settings.maxRounds
  };
}
