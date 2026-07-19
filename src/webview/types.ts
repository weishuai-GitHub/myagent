export interface ToolCallStatus {
  type: 'tool' | 'skill' | 'subagent';
  name: string;
  status: 'calling' | 'success' | 'error';
  result?: string;
  error?: string;
}

export interface UIMessage {
  role: 'user' | 'agent';
  content: string;
  type?: 'text' | 'tool' | 'code' | 'error';
  toolCallStatus?: ToolCallStatus;
}

export type RunPhase =
  | 'idle'
  | 'waiting-model'
  | 'running-component'
  | 'completed'
  | 'error';

export interface RunStatus {
  phase: RunPhase;
  callType?: 'tool' | 'skill' | 'subagent';
  name?: string;
  detail?: string;
}

export interface DiscoveredComponent {
  name: string;
  description: string;
  source: 'workspace' | 'home';
  enabled: boolean;
}

export interface DiscoveredComponents {
  tools: DiscoveredComponent[];
  skills: DiscoveredComponent[];
  subagents: DiscoveredComponent[];
}

export interface Model {
  name: string;
}

export function getRunStatusLabel(status: RunStatus): string {
  switch (status.phase) {
    case 'waiting-model':
      return '等待模型响应';
    case 'running-component': {
      const type = status.callType === 'tool'
        ? '工具'
        : status.callType === 'skill'
          ? '技能'
          : '子代理';
      return status.name ? `${type} ${status.name} 执行中` : `${type}执行中`;
    }
    case 'completed':
      return '已完成';
    case 'error':
      return '执行失败';
    default:
      return '就绪';
  }
}
