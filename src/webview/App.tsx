import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Header } from './components/Header';
import { ChatArea } from './components/ChatArea';
import { InputArea, buildShortcutPrompt } from './components/InputArea';
import { ComponentSelector } from './components/ComponentSelector';
import {
  DiscoveredComponents,
  Model,
  RunStatus,
  ToolCallStatus,
  UIMessage,
} from './types';

declare global {
  interface Window {
    vscode?: {
      postMessage(message: unknown): void;
    };
  }
}

interface AgentConfig {
  enabledTools?: string[];
  enabledSkills?: string[];
  enabledSubagents?: string[];
}

const postMessage = (message: unknown) => {
  window.vscode?.postMessage(message);
};

const callTypeLabel: Record<ToolCallStatus['type'], string> = {
  tool: '工具',
  skill: '技能',
  subagent: '子代理',
};

const createToolMessage = (status: ToolCallStatus): UIMessage => {
  const label = callTypeLabel[status.type];
  let content = `正在调用${label} ${status.name}`;

  if (status.status === 'success') {
    content = `${label} ${status.name} 已完成${status.result ? `\n${status.result}` : ''}`;
  } else if (status.status === 'error') {
    content = `${label} ${status.name} 失败${status.error ? `\n${status.error}` : ''}`;
  }

  return {
    role: 'agent',
    type: 'tool',
    content,
    toolCallStatus: status,
  };
};

export const App: React.FC = () => {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState('');
  const [runStatus, setRunStatus] = useState<RunStatus>({ phase: 'idle' });
  const [configPath, setConfigPath] = useState('');
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [components, setComponents] = useState<DiscoveredComponents | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [activeModel, setActiveModel] = useState('');
  const [componentsExpanded, setComponentsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'tools' | 'skills' | 'subagents'>('tools');
  const [tokenUsage, setTokenUsage] = useState({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

  const isLoading = runStatus.phase === 'waiting-model' || runStatus.phase === 'running-component';
  const inputHistory = useMemo(
    () => messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .filter(Boolean),
    [messages],
  );

  useEffect(() => {
    const saveMessages = (nextMessages: UIMessage[]) => {
      postMessage({ type: 'save-messages', messages: nextMessages });
    };

    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data.type !== 'string') {
        return;
      }

      switch (data.type) {
        case 'config-loaded':
          setConfigPath(data.configPath ?? '');
          setConfig(data.config ?? null);
          setComponents(data.components ?? null);
          setModels(data.models ?? []);
          setActiveModel(data.activeModel ?? '');
          break;
        case 'config-updated':
          setConfig(data.config ?? null);
          setComponents(data.components ?? null);
          if (data.configPath !== undefined) setConfigPath(data.configPath);
          if (data.models !== undefined) setModels(data.models);
          if (data.activeModel !== undefined) setActiveModel(data.activeModel);
          break;
        case 'restore-messages': {
          const restored = Array.isArray(data.messages)
            ? data.messages.filter(
              (message: UIMessage) => !(message.role === 'agent' && message.content === '处理中...'),
            )
            : [];
          setMessages(restored);
          break;
        }
        case 'execution-status':
          setRunStatus({
            phase: data.phase,
            callType: data.callType,
            name: data.name,
            detail: data.detail,
          });
          break;
        case 'agent-response':
          setMessages((previous) => {
            const next = [...previous, { role: 'agent', content: data.content ?? '' } as UIMessage];
            saveMessages(next);
            return next;
          });
          break;
        case 'error':
          setRunStatus({ phase: 'error', detail: data.message ?? data.content });
          setMessages((previous) => {
            const next = [
              ...previous,
              {
                role: 'agent',
                type: 'error',
                content: data.message ?? data.content ?? '发生未知错误',
              } as UIMessage,
            ];
            saveMessages(next);
            return next;
          });
          break;
        case 'tool-call-status': {
          const status: ToolCallStatus = {
            type: data.callType,
            name: data.name,
            status: data.status,
            result: data.result,
            error: data.error,
          };
          const message = createToolMessage(status);

          setMessages((previous) => {
            const next = [...previous];

            if (status.status !== 'calling') {
              let pendingIndex = -1;
              for (let index = next.length - 1; index >= 0; index -= 1) {
                const pending = next[index];
                if (
                  pending.type === 'tool'
                  && pending.toolCallStatus?.status === 'calling'
                  && pending.toolCallStatus.type === status.type
                  && pending.toolCallStatus.name === status.name
                ) {
                  pendingIndex = index;
                  break;
                }
              }

              if (pendingIndex >= 0) {
                next[pendingIndex] = message;
              } else {
                next.push(message);
              }
            } else {
              next.push(message);
            }

            saveMessages(next);
            return next;
          });
          break;
        }
        case 'token-usage':
          setTokenUsage({
            inputTokens: data.inputTokens ?? 0,
            outputTokens: data.outputTokens ?? 0,
            totalTokens: data.totalTokens ?? 0,
          });
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    postMessage({ type: 'webview-ready' });
    postMessage({ type: 'request-messages' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSend = (
    content: string,
    shortcuts: Array<{ type: 'tool' | 'skill' | 'subagent'; name: string }>,
  ) => {
    if (isLoading) {
      return;
    }

    const originalInput = input.trim();
    if (!content.trim() && shortcuts.length === 0) {
      return;
    }

    const shortcutPrompt = buildShortcutPrompt(shortcuts);
    const userMessage = `${shortcutPrompt}${content.trim()}`;
    const visibleMessage = originalInput;

    setInput('');
    setRunStatus({ phase: 'waiting-model' });
    setMessages((previous) => {
      const next = [...previous, { role: 'user', content: visibleMessage } as UIMessage];
      postMessage({ type: 'save-messages', messages: next });
      return next;
    });

    postMessage({
      type: 'execute-task',
      content: userMessage,
      enabledTools: components?.tools
        .filter((component) => component.enabled)
        .map((component) => component.name),
      enabledSkills: components?.skills
        .filter((component) => component.enabled)
        .map((component) => component.name),
      enabledSubagents: components?.subagents
        .filter((component) => component.enabled)
        .map((component) => component.name),
    });
  };

  const handleClear = () => {
    setMessages([]);
    setTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    setRunStatus({ phase: 'idle' });
    postMessage({ type: 'clear-messages' });
  };

  const handleCompress = () => {
    postMessage({ type: 'compress-history' });
  };

  const handleModelChange = (modelName: string) => {
    setActiveModel(modelName);
    postMessage({ type: 'switch-model', modelName });
  };

  const handleToggleComponent = (
    source: 'workspace' | 'home',
    category: 'tools' | 'skills' | 'subagents',
    name: string,
    enabled: boolean,
  ) => {
    postMessage({
      type: 'toggle-component',
      source,
      category,
      name,
      enabled,
    });
  };

  return (
    <main className="app-shell">
      <Header
        configPath={configPath}
        tokenUsage={tokenUsage}
        runStatus={runStatus}
        onImport={() => postMessage({ type: 'import-config' })}
      />
      <ChatArea messages={messages} runStatus={runStatus} />
      <InputArea
        input={input}
        history={inputHistory}
        models={models}
        activeModel={activeModel}
        components={components}
        isLoading={isLoading}
        onInputChange={setInput}
        onSend={handleSend}
        onClear={handleClear}
        onCompress={handleCompress}
        onModelChange={handleModelChange}
        onReload={() => postMessage({ type: 'reload-config' })}
      />
      <ComponentSelector
        expanded={componentsExpanded}
        onToggle={() => setComponentsExpanded((expanded) => !expanded)}
        activeTab={activeTab}
        components={components}
        onTabChange={setActiveTab}
        onToggleComponent={(category, name, source, enabled) => (
          handleToggleComponent(source, category, name, enabled)
        )}
      />
    </main>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
