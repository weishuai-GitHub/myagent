import { ModelConfig, Settings } from '../types';

export class SettingsValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly fieldPath: string,
    message: string
  ) {
    super(`${filePath}: ${fieldPath} ${message}`);
    this.name = 'SettingsValidationError';
  }
}

function fail(filePath: string, fieldPath: string, message: string): never {
  throw new SettingsValidationError(filePath, fieldPath, message);
}

function requireObject(value: unknown, filePath: string, fieldPath: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(filePath, fieldPath, '必须是对象');
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, filePath: string, fieldPath: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(filePath, fieldPath, '必须是非空字符串');
  }
  return value;
}

function optionalString(value: unknown, filePath: string, fieldPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    fail(filePath, fieldPath, '必须是字符串');
  }
  return value;
}

function stringArray(value: unknown, filePath: string, fieldPath: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    fail(filePath, fieldPath, '必须是字符串数组');
  }
  return [...new Set(value as string[])];
}

function parseModel(value: unknown, filePath: string, index: number): ModelConfig {
  const fieldPath = `models[${index}]`;
  const raw = requireObject(value, filePath, fieldPath);
  const provider = requireString(raw.provider, filePath, `${fieldPath}.provider`);
  if (provider !== 'anthropic' && provider !== 'openai') {
    fail(filePath, `${fieldPath}.provider`, '只能是 "anthropic" 或 "openai"');
  }

  const auth = raw.auth === undefined ? undefined : requireString(raw.auth, filePath, `${fieldPath}.auth`);
  if (auth !== undefined && auth !== 'api-key' && auth !== 'codex') {
    fail(filePath, `${fieldPath}.auth`, '只能是 "api-key" 或 "codex"');
  }
  if (auth === 'codex' && provider !== 'openai') {
    fail(filePath, `${fieldPath}.auth`, '只有 openai provider 支持 codex 认证');
  }

  let retry: ModelConfig['retry'];
  if (raw.retry !== undefined) {
    const retryRaw = requireObject(raw.retry, filePath, `${fieldPath}.retry`);
    retry = {};
    for (const key of ['maxAttempts', 'baseDelayMs', 'maxDelayMs', 'requestTimeoutMs'] as const) {
      const numberValue = retryRaw[key];
      if (numberValue === undefined) continue;
      if (!Number.isInteger(numberValue) || (numberValue as number) < (key === 'maxAttempts' ? 1 : 0)) {
        fail(filePath, `${fieldPath}.retry.${key}`, '必须是有效的非负整数');
      }
      retry[key] = numberValue as number;
    }
  }

  return {
    name: requireString(raw.name, filePath, `${fieldPath}.name`),
    provider,
    model: requireString(raw.model, filePath, `${fieldPath}.model`),
    apiKey: optionalString(raw.apiKey, filePath, `${fieldPath}.apiKey`),
    apiKeyRef: optionalString(raw.apiKeyRef, filePath, `${fieldPath}.apiKeyRef`),
    baseUrl: optionalString(raw.baseUrl, filePath, `${fieldPath}.baseUrl`),
    auth: auth as ModelConfig['auth'],
    codexCommand: optionalString(raw.codexCommand, filePath, `${fieldPath}.codexCommand`),
    retry
  };
}

/**
 * 将不可信 JSON 输入转换为规范化 Settings。所有诊断均包含配置文件路径和字段路径。
 */
export function parseSettings(value: unknown, filePath: string): Settings {
  const raw = requireObject(value, filePath, '$');
  if (!Array.isArray(raw.models) || raw.models.length === 0) {
    fail(filePath, 'models', '必须是非空数组');
  }
  const models = raw.models.map((model, index) => parseModel(model, filePath, index));
  const names = new Set<string>();
  for (let index = 0; index < models.length; index++) {
    if (names.has(models[index].name)) {
      fail(filePath, `models[${index}].name`, `模型名称 "${models[index].name}" 重复`);
    }
    names.add(models[index].name);
  }

  const activeModel = requireString(raw.activeModel, filePath, 'activeModel');
  // 兼容旧行为：activeModel 暂时允许引用已删除的模型，ConfigManager 会回退到
  // models[0]。后续持久化阶段会把该兼容情况作为可恢复诊断展示并修正到磁盘。

  const maxRounds = raw.maxRounds === undefined ? 10 : raw.maxRounds;
  if (!Number.isInteger(maxRounds) || (maxRounds as number) < 1 || (maxRounds as number) > 100) {
    fail(filePath, 'maxRounds', '必须是 1 到 100 之间的整数');
  }

  const envRaw = raw.env === undefined ? {} : requireObject(raw.env, filePath, 'env');
  const env: Record<string, string> = {};
  for (const [key, envValue] of Object.entries(envRaw)) {
    if (typeof envValue !== 'string') {
      fail(filePath, `env.${key}`, '必须是字符串');
    }
    env[key] = envValue;
  }

  return {
    models,
    activeModel,
    enabledTools: stringArray(raw.enabledTools, filePath, 'enabledTools'),
    enabledSkills: stringArray(raw.enabledSkills, filePath, 'enabledSkills'),
    enabledSubagents: stringArray(raw.enabledSubagents, filePath, 'enabledSubagents'),
    maxRounds: maxRounds as number,
    env
  };
}
