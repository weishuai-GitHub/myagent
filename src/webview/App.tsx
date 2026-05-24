import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { Header } from './components/Header';
import { ChatArea } from './components/ChatArea';
import { InputArea, parseShortcuts, buildShortcutPrompt } from './components/InputArea';
import { ComponentSelector } from './components/ComponentSelector';

interface ToolCallStatus {
  type: 'tool' | 'skill' | 'subagent';
  name: string;
  status: 'calling' | 'success' | 'error';
  result?: string;
  error?: string;
}

interface Message {
  role: 'user' | 'agent';
  content: string;
  type?: 'text' | 'tool' | 'code';
  toolCallStatus?: ToolCallStatus;
}

interface Config {
  enabledTools: string[];
  enabledSkills: string[];
  enabledSubagents: string[];
}

interface DiscoveredComponent {
  name: string;
  description: string;
  source: 'workspace' | 'home';
  enabled: boolean;
}

interface DiscoveredComponents {
  tools: DiscoveredComponent[];
  skills: DiscoveredComponent[];
  subagents: DiscoveredComponent[];
}

interface Model {
  name: string;
}

export const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [configPath, setConfigPath] = useState('');
  const [config, setConfig] = useState<Config | null>(null);
  const [components, setComponents] = useState<DiscoveredComponents | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [activeModel, setActiveModel] = useState('');
  const [componentsExpanded, setComponentsExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'tools' | 'skills' | 'subagents'>('tools');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  const [mounted, setMounted] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{ inputTokens: number; outputTokens: number; totalTokens: number }>({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });

  useEffect(() => {
    // Set mounted flag
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      switch (data.type) {
        case 'theme-changed':
          setTheme(data.theme === 2 ? 'dark' : 'light');
          break;
        case 'config-loaded':
          setConfigPath(data.configPath);
          setConfig(data.config);
          setModels(data.models);
          setActiveModel(data.activeModel);
          if (data.components) setComponents(data.components);
          // Request restoration of saved messages
          (window as any).vscode?.postMessage({ type: 'request-messages' });
          break;
        case 'config-updated':
          setConfig(data.config);
          if (data.components) setComponents(data.components);
          break;
        case 'restore-messages':
          if (data.messages && data.messages.length > 0) {
            setMessages(data.messages);
          }
          break;
        case 'agent-response':
          setIsLoading(false);
          setMessages(prev => {
            const updatedMessages = [...prev, { role: 'agent' as const, content: data.content }];
            (window as any).vscode?.postMessage({ type: 'save-messages', messages: updatedMessages });
            return updatedMessages;
          });
          break;
        case 'error':
          setIsLoading(false);
          setMessages(prev => {
            const newMessages = [...prev, { role: 'agent' as const, content: `错误: ${data.content}`, type: 'text' as const }];
            (window as any).vscode?.postMessage({ type: 'save-messages', messages: newMessages });
            return newMessages;
          });
          break;
        case 'tool-call-status': {
          const callType = data.callType as 'tool' | 'skill' | 'subagent';
          const callStatus = data.status as 'calling' | 'success' | 'error';
          const toolCallStatus: ToolCallStatus = {
            type: callType,
            name: data.name,
            status: callStatus,
            result: data.result,
            error: data.error
          };
          const typeLabel = callType === 'tool' ? '工具' : callType === 'skill' ? '技能' : '子代理';
          let content = '';
          if (callStatus === 'calling') {
            content = `正在调用${typeLabel}: ${data.name}`;
          } else if (callStatus === 'success') {
            content = `${typeLabel} ${data.name} 完成${data.result ? ': ' + data.result : ''}`;
          } else {
            content = `${typeLabel} ${data.name} 失败: ${data.error || '未知错误'}`;
          }
          setMessages(prev => {
            const newMessages = [...prev, { role: 'agent' as const, content, type: 'tool' as const, toolCallStatus }];
            (window as any).vscode?.postMessage({ type: 'save-messages', messages: newMessages });
            return newMessages;
          });
          break;
        }
        case 'token-usage':
          setTokenUsage({
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
            totalTokens: data.totalTokens
          });
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleSend = (content: string, shortcuts: { type: 'tool' | 'skill' | 'subagent'; name: string }[]) => {
    if (!content.trim() || isLoading) return;

    // 构建带快捷指令前缀的消息
    const shortcutPrompt = buildShortcutPrompt(shortcuts);
    const userMessage = shortcutPrompt ? `${shortcutPrompt}${content}` : content;

    setInput('');
    setIsLoading(true);

    // 使用 setMessages 的函数形式确保使用最新状态
    setMessages(prev => {
      const newMessages = [...prev, { role: 'user' as const, content: userMessage }];
      // Save messages to backend for persistence
      (window as any).vscode?.postMessage({ type: 'save-messages', messages: newMessages });
      return newMessages;
    });

    // 发送消息到后端，带上当前选中的组件信息
    (window as any).vscode?.postMessage({
      type: 'execute-task',
      content: userMessage,
      enabledTools: components ? components.tools.filter(c => c.enabled).map(c => c.name) : [],
      enabledSkills: components ? components.skills.filter(c => c.enabled).map(c => c.name) : [],
      enabledSubagents: components ? components.subagents.filter(c => c.enabled).map(c => c.name) : []
    });
  };

  const handleImport = () => {
    const vscode = (window as any).vscode;
    vscode?.postMessage({ type: 'import-config' });
  };

  const handleModelChange = (modelName: string) => {
    setActiveModel(modelName);
    const vscode = (window as any).vscode;
    vscode?.postMessage({ type: 'switch-model', modelName });
  };

  const handleClear = () => {
    setMessages([]);
    setTokenUsage({
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0
          });
    (window as any).vscode?.postMessage({ type: 'clear-messages' });
  };

  const handleReload = () => {
    (window as any).vscode?.postMessage({ type: 'reload-config' });
  };

  const handleCompress = () => {
    (window as any).vscode?.postMessage({ type: 'compress-history' });
  };

  const handleToggleComponent = (category: 'tools' | 'skills' | 'subagents', name: string, source: 'workspace' | 'home', enabled: boolean) => {
    (window as any).vscode?.postMessage({
      type: 'toggle-component',
      category,
      name,
      source,
      enabled
    });
  };

  const colors = theme === 'dark'
    ? { bg: '#1E1E1E', border: '#3C3C3C', text: '#CCCCCC', secondary: '#252526' }
    : { bg: '#FFFFFF', border: '#E0E0E0', text: '#333333', secondary: '#F3F3F3' };

  return (
    <div style={{ backgroundColor: colors.bg, color: colors.text, height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {!mounted && (
        <div style={{ padding: '20px', textAlign: 'center', color: colors.text }}>
          加载中...
        </div>
      )}
      {mounted && (
        <>
          <Header configPath={configPath} tokenUsage={tokenUsage} onImport={handleImport} />

          <ChatArea messages={messages} isLoading={isLoading} colors={colors} />

          <InputArea
            input={input}
            onInputChange={setInput}
            onSend={handleSend}
            onClear={handleClear}
            onReload={handleReload}
            onCompress={handleCompress}
            isLoading={isLoading}
            models={models}
            activeModel={activeModel}
            onModelChange={handleModelChange}
            colors={colors}
            components={components}
          />

          <ComponentSelector
            expanded={componentsExpanded}
            onToggle={() => setComponentsExpanded(!componentsExpanded)}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            components={components}
            onToggleComponent={handleToggleComponent}
            colors={colors}
          />
        </>
      )}
    </div>
  );
};

// 在 bundle 内部完成 React 渲染，不依赖内联脚本中的全局 React/ReactDOM
const rootEl = document.getElementById('root');
if (rootEl) {
  const root = createRoot(rootEl);
  root.render(React.createElement(App));
}
