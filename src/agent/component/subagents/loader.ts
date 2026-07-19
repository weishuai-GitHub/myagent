import * as path from 'path';
import * as fs from 'fs';
import { Subagent } from './types';
import { ComponentSource } from '../types';

/**
 * 从指定目录加载所有子代理
 */
export function loadSubagentsFromDir(baseDir: string, source: ComponentSource, subagentsMap: Map<string, Subagent>): void {
  const subagentsDir = path.join(baseDir, 'subagents');
  if (!fs.existsSync(subagentsDir)) return;

  const dirs = fs.readdirSync(subagentsDir);
  for (const dir of dirs) {
    const subagentPath = path.join(subagentsDir, dir);
    if (!fs.statSync(subagentPath).isDirectory()) continue;

    const agentMdPath = path.join(subagentPath, 'AGENT.md');
    if (!fs.existsSync(agentMdPath)) continue;

    try {
      const content = fs.readFileSync(agentMdPath, 'utf-8');
      const {
        name,
        description,
        body,
        model,
        maxRounds,
        tools,
        skills,
        disallowedTools,
        disallowedSkills,
        allowWorkspaceComponents
      } = parseAgentMarkdown(content);
      if (subagentsMap.has(name)) {
        console.log(`Subagent "${name}" from home overridden by workspace`);
      }
      subagentsMap.set(name, {
        name,
        description,
        agentPrompt: body,
        tools,
        skills,
        disallowedTools,
        disallowedSkills,
        model,
        maxRounds,
        allowWorkspaceComponents,
        source,
        subAgentPath: subagentPath
      });
    } catch (e) {
      console.error(`Failed to load subagent ${dir} from ${source}:`, e);
    }
  }
}

/**
 * 解析 AGENT.md：提取 YAML 元数据和正文
 */
export interface ParsedAgentMarkdown {
  name: string;
  description: string;
  body: string;
  model: string | 'inherit';
  maxRounds?: number;
  tools: string[];
  skills: string[];
  disallowedTools: string[];
  disallowedSkills: string[];
  allowWorkspaceComponents: boolean;
}

export function parseAgentMarkdown(content: string): ParsedAgentMarkdown {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return withDefaults({ body: content });
  }

  const yamlContent = match[1];
  const body = match[2];
  const meta = parseFrontmatter(yamlContent);

  return {
    ...withDefaults({
      name: toStringValue(meta.name),
      description: toStringValue(meta.description),
      body,
      model: toStringValue(meta.model) || 'inherit',
      maxRounds: toPositiveInt(meta.maxRounds, 'maxRounds'),
      tools: toStringArray(meta.tools),
      skills: toStringArray(meta.skills),
      disallowedTools: toStringArray(meta.disallowedTools),
      disallowedSkills: toStringArray(meta.disallowedSkills),
      allowWorkspaceComponents: toBoolean(meta.allowWorkspaceComponents)
    })
  };
}

function withDefaults(value: Partial<ParsedAgentMarkdown>): ParsedAgentMarkdown {
  return {
    name: value.name ?? '',
    description: value.description ?? '',
    body: value.body ?? '',
    model: value.model ?? 'inherit',
    maxRounds: value.maxRounds,
    tools: value.tools ?? [],
    skills: value.skills ?? [],
    disallowedTools: value.disallowedTools ?? [],
    disallowedSkills: value.disallowedSkills ?? [],
    allowWorkspaceComponents: value.allowWorkspaceComponents ?? false
  };
}

function parseFrontmatter(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = yaml.split(/\r?\n/);
  let currentArrayKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const itemMatch = line.match(/^\s*-\s*(.+)$/);
    if (itemMatch && currentArrayKey) {
      const existing = Array.isArray(out[currentArrayKey]) ? out[currentArrayKey] as string[] : [];
      existing.push(stripQuotes(itemMatch[1].trim()));
      out[currentArrayKey] = existing;
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!keyMatch) {
      currentArrayKey = null;
      continue;
    }

    const key = keyMatch[1];
    const rawValue = keyMatch[2].trim();
    if (!rawValue) {
      out[key] = [];
      currentArrayKey = key;
      continue;
    }

    out[key] = parseScalarOrInlineArray(rawValue);
    currentArrayKey = null;
  }

  return out;
}

function parseScalarOrInlineArray(rawValue: string): unknown {
  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    const inner = rawValue.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(item => stripQuotes(item.trim())).filter(Boolean);
  }
  return stripQuotes(rawValue);
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === 'true';
}

function toPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  const raw = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return raw;
}
