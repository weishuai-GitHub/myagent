import {
  ComponentCallType,
  ComponentDisplay,
  ComponentExecutionResult
} from './types';

const DISPLAY_LIMIT = 4_000;
const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token|env)/i;

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map(item => redact(item, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item, seen);
  }
  return output;
}

function stableStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(redact(value), null, 2);
  } catch {
    try {
      return String(value);
    } catch {
      return '[无法展示结果]';
    }
  }
}

function modelStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(value: string): { value: string; truncated: boolean } {
  if (value.length <= DISPLAY_LIMIT) return { value, truncated: false };
  return {
    value: `${value.slice(0, DISPLAY_LIMIT)}\n…[展示内容已截断]`,
    truncated: true
  };
}

function label(type: ComponentCallType, name: string): string {
  const prefix = type === 'tool' ? '工具' : type === 'skill' ? '技能' : '子 Agent';
  return `${prefix} · ${name}`;
}

function formatFor(value: unknown): ComponentDisplay['format'] {
  return typeof value === 'object' && value !== null ? 'json' : 'text';
}

export class ComponentResultPresenter {
  presentInvocation(input: {
    type: ComponentCallType;
    name: string;
    argsOrQuestion?: unknown;
  }): ComponentDisplay {
    const rendered = input.argsOrQuestion === undefined
      ? undefined
      : truncate(stableStringify(input.argsOrQuestion));
    return {
      title: label(input.type, input.name),
      input: rendered?.value,
      format: formatFor(input.argsOrQuestion),
      truncated: rendered?.truncated
    };
  }

  presentTool(input: {
    name: string;
    args: unknown;
    rawResult: unknown;
  }): ComponentExecutionResult {
    const renderedInput = truncate(stableStringify(input.args));
    const renderedOutput = truncate(stableStringify(input.rawResult));
    return {
      modelContent: modelStringify(input.rawResult),
      display: {
        title: label('tool', input.name),
        input: renderedInput.value,
        output: renderedOutput.value,
        format: formatFor(input.rawResult),
        truncated: renderedInput.truncated || renderedOutput.truncated
      }
    };
  }

  presentSkill(input: { name: string; content: string }): ComponentExecutionResult {
    return {
      modelContent: input.content,
      display: {
        title: label('skill', input.name),
        output: '技能内容已加载到当前 Agent 上下文',
        format: 'text'
      }
    };
  }

  presentSubagent(input: {
    name: string;
    question: string;
    answer: string;
  }): ComponentExecutionResult {
    const question = truncate(input.question);
    const answer = truncate(input.answer);
    return {
      modelContent: input.answer,
      display: {
        title: label('subagent', input.name),
        input: question.value,
        output: answer.value,
        format: 'markdown',
        truncated: question.truncated || answer.truncated
      }
    };
  }

  presentError(input: {
    type: ComponentCallType;
    name: string;
    error: unknown;
    argsOrQuestion?: unknown;
  }): ComponentExecutionResult {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const renderedInput = input.argsOrQuestion === undefined
      ? undefined
      : truncate(stableStringify(input.argsOrQuestion));
    const renderedError = truncate(message);
    return {
      modelContent: JSON.stringify({
        ok: false,
        error: { code: 'COMPONENT_EXECUTION_ERROR', message }
      }),
      display: {
        title: label(input.type, input.name),
        input: renderedInput?.value,
        output: renderedError.value,
        format: 'text',
        truncated: Boolean(renderedInput?.truncated || renderedError.truncated)
      }
    };
  }
}
