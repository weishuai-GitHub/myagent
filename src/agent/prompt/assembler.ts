import { AgentPromptContext } from './types';

function replaceAll(value: string, token: string, replacement: string): string {
  return value.split(token).join(replacement);
}

function section(title: string, body: string): string {
  const normalized = body.trim();
  return normalized ? `## ${title}\n\n${normalized}` : '';
}

/**
 * 以固定顺序组装系统提示词：
 * Framework → Agent → Project → Components → Runtime。
 *
 * 兼容旧 AGENT.md 的 ${workspace}/${components} 占位符。组件清单统一由
 * “可用组件”分层追加，旧 ${components} 只替换为指引文本，避免打乱分层顺序。
 */
export function assembleSystemPrompt(context: AgentPromptContext): string {
  const resolve = (value: string): string => {
    let resolved = replaceAll(value, '${workspace}', context.workspaceDir);
    resolved = replaceAll(
      resolved,
      '${components}',
      '（可用组件由运行时在下方“可用组件”章节提供）'
    );
    return resolved;
  };

  const framework = resolve(context.frameworkPrompt);
  const agent = resolve(context.agentPrompt);
  const project = resolve(context.projectPrompt);
  const parts = [
    section('MyAgent 运行时协议', framework),
    section('Agent 定义', agent),
    section('项目定义', project),
    section('可用组件', context.componentPrompt)
  ];
  parts.push(section(
    '运行环境',
    `工作目录: ${context.workspaceDir || '未打开工作区'}`
  ));
  return parts.filter(Boolean).join('\n\n');
}
