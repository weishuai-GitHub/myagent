import React, { useState, useRef, useEffect } from 'react';

interface Model {
  name: string;
}

interface Shortcut {
  type: 'tool' | 'skill' | 'subagent';
  name: string;
}

// 建议项类型
interface SuggestionItem {
  label: string;  // 显示文本
  insertText: string;  // 插入的文本
  type: 'component' | 'special';
  componentType?: 'tool' | 'skill' | 'subagent';
  isSpecial?: boolean;
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

type SpecialCommand = 'clear' | 'reload';

interface InputAreaProps {
  input: string;
  onInputChange: (value: string) => void;
  onSend: (processedContent: string, shortcuts: Shortcut[]) => void;
  onClear: () => void;
  onReload: () => void;
  isLoading: boolean;
  models: Model[];
  activeModel: string;
  onModelChange: (modelName: string) => void;
  colors: { bg: string; border: string; text: string; secondary: string };
  components: DiscoveredComponents | null;
}

/**
 * 解析输入中的快捷指令
 * 支持格式: /tool:xxx, /skill:xxx, /subagent:xxx
 * 也支持特殊指令: /clear, /reload
 * 返回快捷指令列表、特殊命令和去掉快捷指令后的内容
 */
export function parseShortcuts(input: string): { shortcuts: Shortcut[]; specialCommand: SpecialCommand | null; content: string } {
  const trimmed = input.trim();

  // 检查特殊指令
  if (trimmed === '/clear') {
    return { shortcuts: [], specialCommand: 'clear', content: '' };
  }
  if (trimmed === '/reload') {
    return { shortcuts: [], specialCommand: 'reload', content: '' };
  }

  const shortcuts: Shortcut[] = [];
  const shortcutRegex = /\/(tool|skill|subagent):(\S+)/g;
  let match;
  let content = input;

  while ((match = shortcutRegex.exec(input)) !== null) {
    shortcuts.push({ type: match[1] as 'tool' | 'skill' | 'subagent', name: match[2] });
  }

  // 去掉所有快捷指令，保留其余内容
  content = input.replace(shortcutRegex, '').trim();

  return { shortcuts, specialCommand: null, content };
}

/**
 * 根据快捷指令生成前置句子
 */
export function buildShortcutPrompt(shortcuts: Shortcut[]): string {
  if (shortcuts.length === 0) return '';
  const parts = shortcuts.map(s => `使用${s.type}:${s.name}回答用户问题`);
  return parts.join('，') + '。';
}

type SuggestionMode = 'type' | 'name' | null;

export const InputArea: React.FC<InputAreaProps> = ({
  input,
  onInputChange,
  onSend,
  onClear,
  onReload,
  isLoading,
  models,
  activeModel,
  onModelChange,
  colors,
  components
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 获取特定类型的快捷指令（只返回已勾选的）
  const getSuggestionsByType = (type: 'tool' | 'skill' | 'subagent'): Shortcut[] => {
    if (!components) return [];
    switch (type) {
      case 'tool': return components.tools.filter(t => t.enabled).map(t => ({ type: 'tool' as const, name: t.name }));
      case 'skill': return components.skills.filter(s => s.enabled).map(s => ({ type: 'skill' as const, name: s.name }));
      case 'subagent': return components.subagents.filter(s => s.enabled).map(s => ({ type: 'subagent' as const, name: s.name }));
    }
  };

  // 解析当前输入状态
  const parseInputState = (value: string): { mode: SuggestionMode; type?: 'tool' | 'skill' | 'subagent'; filter?: string } => {
    const lastSlash = value.lastIndexOf('/');
    if (lastSlash === -1) return { mode: null };

    const afterSlash = value.slice(lastSlash + 1);

    // 格式: /tool:xxx 或 /skill:xxx 或 /subagent:xxx
    const fullMatch = afterSlash.match(/^(tool|skill|subagent):(\S*)$/);
    if (fullMatch) {
      return { mode: 'name', type: fullMatch[1] as 'tool' | 'skill' | 'subagent', filter: fullMatch[2] };
    }

    // 格式: /tool 或 /skill 或 /subagent (等待输入 :)
    const typeOnlyMatch = afterSlash.match(/^(tool|skill|subagent)$/);
    if (typeOnlyMatch) {
      return { mode: 'type', type: typeOnlyMatch[1] as 'tool' | 'skill' | 'subagent' };
    }

    // 检查是否正在输入类型名或特殊命令（支持前缀匹配）
    // 例如: /cle -> 应该匹配 /clear, /cl -> /clear, /sk -> /skill:xxx
    const validTypes = ['tool', 'skill', 'subagent'];
    const validCommands = ['clear', 'reload'];

    for (const type of validTypes) {
      if (type.startsWith(afterSlash)) {
        return { mode: 'type', type: type as 'tool' | 'skill' | 'subagent' };
      }
    }

    for (const cmd of validCommands) {
      if (cmd.startsWith(afterSlash)) {
        return { mode: 'type' };  // 特殊命令也进入 type 模式显示建议
      }
    }

    // 检查是否正在输入类型后的名称 (例如 /tool:cl -> filter = 'cl')
    const typeColonMatch = afterSlash.match(/^(tool|skill|subagent):(\S*)$/);
    if (typeColonMatch) {
      return { mode: 'name', type: typeColonMatch[1] as 'tool' | 'skill' | 'subagent', filter: typeColonMatch[2] };
    }

    return { mode: null };
  };

  // 获取当前显示的建议列表
  const getCurrentSuggestions = (): SuggestionItem[] => {
    const state = parseInputState(input);
    const lastSlash = input.lastIndexOf('/');
    const filter = lastSlash >= 0 ? input.slice(lastSlash + 1).toLowerCase() : '';

    if (state.mode === 'type') {
      const allSuggestions: SuggestionItem[] = [
        { label: '/tool:', insertText: '/tool:', type: 'component', componentType: 'tool' },
        { label: '/skill:', insertText: '/skill:', type: 'component', componentType: 'skill' },
        { label: '/subagent:', insertText: '/subagent:', type: 'component', componentType: 'subagent' },
        { label: '/clear', insertText: '/clear', type: 'special', isSpecial: true },
        { label: '/reload', insertText: '/reload', type: 'special', isSpecial: true },
      ];

      // 根据输入过滤建议
      if (filter) {
        return allSuggestions.filter(s => s.label.toLowerCase().startsWith(`/${filter}`));
      }
      return allSuggestions;
    }

    if (state.mode === 'name' && state.type) {
      // 显示特定类型下的名称列表
      const suggestions = getSuggestionsByType(state.type);
      const filtered = state.filter
        ? suggestions.filter(s => s.name.toLowerCase().includes(state.filter!.toLowerCase()))
        : suggestions;
      return filtered.map(s => ({
        label: `/${s.type}:${s.name}`,
        insertText: `/${s.type}:${s.name} `,
        type: 'component',
        componentType: s.type,
      }));
    }

    return [];
  };

  // 检测输入变化
  useEffect(() => {
    const state = parseInputState(input);

    if (state.mode === null) {
      setSuggestionMode(null);
    } else if (state.mode === 'type') {
      setSuggestionMode('type');
    } else if (state.mode === 'name' && state.type) {
      setSuggestionMode('name');
    }

    setSelectedIndex(0);
  }, [input]);

  // 插入快捷指令
  const insertSuggestion = (suggestion: SuggestionItem) => {
    const lastSlash = input.lastIndexOf('/');
    const newInput = input.slice(0, lastSlash) + suggestion.insertText;

    onInputChange(newInput);
    setSuggestionMode(null);
    inputRef.current?.focus();
  };

  // 键盘导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const suggestions = getCurrentSuggestions();

    if (suggestionMode) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Tab' && suggestions.length > 0) {
        e.preventDefault();
        insertSuggestion(suggestions[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSuggestionMode(null);
        return;
      }
    }

    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      const { shortcuts, specialCommand, content } = parseShortcuts(input);
      if (specialCommand === 'clear') {
        onClear();
        onInputChange('');
      } else if (specialCommand === 'reload') {
        onReload();
        onInputChange('');
      } else {
        onSend(content, shortcuts);
      }
    }
  };

  const handleSendClick = () => {
    const { shortcuts, specialCommand, content } = parseShortcuts(input);
    if (specialCommand === 'clear') {
      onClear();
      onInputChange('');
    } else if (specialCommand === 'reload') {
      onReload();
      onInputChange('');
    } else {
      onSend(content, shortcuts);
    }
  };

  const styles = {
    container: {
      display: 'flex' as const,
      flexDirection: 'column' as const,
      gap: '4px',
      padding: '8px 12px',
      borderTop: `1px solid ${colors.border}`,
    },
    inputRow: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '8px',
    },
    input: {
      flex: 1,
      padding: '8px 12px',
      borderRadius: '6px',
      border: `1px solid ${colors.border}`,
      backgroundColor: colors.secondary,
      color: colors.text,
      fontSize: '13px',
      outline: 'none',
      resize: 'none' as const,
      fontFamily: 'inherit',
    },
    select: {
      padding: '6px 8px',
      borderRadius: '4px',
      border: `1px solid ${colors.border}`,
      backgroundColor: colors.secondary,
      color: colors.text,
      fontSize: '12px',
      cursor: 'pointer' as const,
    },
    button: {
      padding: '8px 16px',
      borderRadius: '6px',
      border: 'none',
      backgroundColor: '#3794FF',
      color: '#fff',
      cursor: (isLoading ? 'not-allowed' : 'pointer') as any,
      opacity: isLoading ? 0.6 : 1,
      fontSize: '13px',
    },
    suggestionBox: {
      border: `1px solid ${colors.border}`,
      borderRadius: '6px',
      backgroundColor: colors.secondary,
      maxHeight: '150px',
      overflow: 'auto',
    },
    suggestionItem: {
      padding: '6px 12px',
      fontSize: '12px',
      cursor: 'pointer' as const,
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '8px',
    },
    suggestionItemSelected: {
      backgroundColor: '#3794FF',
      color: '#fff',
    },
    typeTag: {
      padding: '1px 6px',
      borderRadius: '3px',
      fontSize: '10px',
      fontWeight: 'bold' as const,
    },
    hint: {
      fontSize: '11px',
      color: '#858585',
      padding: '2px 0',
    }
  };

  const suggestions = getCurrentSuggestions();

  return (
    <div style={styles.container}>
      {suggestionMode && suggestions.length > 0 && (
        <div style={styles.suggestionBox}>
          {suggestions.map((s, i) => (
            <div
              key={i}
              style={{
                ...styles.suggestionItem,
                ...(i === selectedIndex ? styles.suggestionItemSelected : {}),
              }}
              onClick={() => insertSuggestion(s)}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              {s.type === 'component' ? (
                <span style={{
                  ...styles.typeTag,
                  backgroundColor: s.componentType === 'tool' ? '#FF9800' : s.componentType === 'skill' ? '#4CAF50' : '#2196F3',
                  color: '#fff',
                }}>
                  {s.componentType === 'tool' ? 'T' : s.componentType === 'skill' ? 'S' : 'A'}
                </span>
              ) : (
                <span style={{
                  ...styles.typeTag,
                  backgroundColor: '#9C27B0',
                  color: '#fff',
                }}>
                  !
                </span>
              )}
              <span>{s.label}</span>
              {i === selectedIndex && <span style={{ marginLeft: 'auto', opacity: 0.7 }}>Tab</span>}
            </div>
          ))}
        </div>
      )}
      <div style={styles.hint}>
        输入 / 显示快捷指令 | ↑↓ 选择 | Tab 确认
      </div>
      <div style={styles.inputRow}>
        <textarea
          ref={inputRef}
          style={styles.input}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入任务... (Ctrl+Enter 发送)"
          disabled={isLoading}
          rows={2}
        />
        <select
          style={styles.select}
          value={activeModel}
          onChange={(e) => onModelChange(e.target.value)}
        >
          {models.map(m => (
            <option key={m.name} value={m.name}>{m.name}</option>
          ))}
        </select>
        <button style={styles.button} onClick={handleSendClick} disabled={isLoading || !input.trim()}>
          🗨
        </button>
      </div>
    </div>
  );
};
