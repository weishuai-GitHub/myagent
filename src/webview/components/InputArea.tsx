import React, { useEffect, useRef, useState } from 'react';
import { DiscoveredComponents, Model } from '../types';

export interface Shortcut {
  type: 'tool' | 'skill' | 'subagent';
  name: string;
}

interface SuggestionItem {
  label: string;
  insertText: string;
  type: 'component' | 'special';
  componentType?: Shortcut['type'];
}

type SpecialCommand = 'clear' | 'reload' | 'compress';
type SuggestionMode = 'type' | 'name' | null;

interface InputAreaProps {
  input: string;
  history: string[];
  onInputChange: (value: string) => void;
  onSend: (processedContent: string, shortcuts: Shortcut[]) => void;
  onClear: () => void;
  onReload: () => void;
  onCompress: () => void;
  onCancel: () => void;
  isLoading: boolean;
  models: Model[];
  activeModel: string;
  onModelChange: (modelName: string) => void;
  components: DiscoveredComponents | null;
}

export function parseShortcuts(input: string): {
  shortcuts: Shortcut[];
  specialCommand: SpecialCommand | null;
  content: string;
} {
  const trimmed = input.trim();
  if (trimmed === '/clear') return { shortcuts: [], specialCommand: 'clear', content: '' };
  if (trimmed === '/reload') return { shortcuts: [], specialCommand: 'reload', content: '' };
  if (trimmed === '/compress') return { shortcuts: [], specialCommand: 'compress', content: '' };

  const shortcuts: Shortcut[] = [];
  const shortcutRegex = /\/(tool|skill|subagent):(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = shortcutRegex.exec(input)) !== null) {
    shortcuts.push({ type: match[1] as Shortcut['type'], name: match[2] });
  }
  return {
    shortcuts,
    specialCommand: null,
    content: input.replace(shortcutRegex, '').trim()
  };
}

export function buildShortcutPrompt(shortcuts: Shortcut[]): string {
  if (shortcuts.length === 0) return '';
  return `${shortcuts.map(item => `使用${item.type}:${item.name}回答用户问题`).join('，')}。`;
}

export const InputArea: React.FC<InputAreaProps> = ({
  input,
  history,
  onInputChange,
  onSend,
  onClear,
  onReload,
  onCompress,
  onCancel,
  isLoading,
  models,
  activeModel,
  onModelChange,
  components
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>(null);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef('');

  const parseInputState = (value: string): {
    mode: SuggestionMode;
    type?: Shortcut['type'];
    filter?: string;
  } => {
    const lastSlash = value.lastIndexOf('/');
    if (lastSlash === -1) return { mode: null };
    const afterSlash = value.slice(lastSlash + 1);
    const nameMatch = afterSlash.match(/^(tool|skill|subagent):(\S*)$/);
    if (nameMatch) {
      return {
        mode: 'name',
        type: nameMatch[1] as Shortcut['type'],
        filter: nameMatch[2]
      };
    }

    const candidates = ['tool', 'skill', 'subagent', 'clear', 'reload', 'compress'];
    if (candidates.some(candidate => candidate.startsWith(afterSlash))) {
      return { mode: 'type' };
    }
    return { mode: null };
  };

  const componentSuggestions = (type: Shortcut['type']): Shortcut[] => {
    if (!components) return [];
    return components[`${type === 'subagent' ? 'subagents' : `${type}s`}` as keyof DiscoveredComponents]
      .filter(item => item.enabled)
      .map(item => ({ type, name: item.name }));
  };

  const getCurrentSuggestions = (): SuggestionItem[] => {
    const state = parseInputState(input);
    const lastSlash = input.lastIndexOf('/');
    const filter = lastSlash >= 0 ? input.slice(lastSlash + 1).toLowerCase() : '';

    if (state.mode === 'type') {
      const suggestions: SuggestionItem[] = [
        { label: '/tool:', insertText: '/tool:', type: 'component', componentType: 'tool' },
        { label: '/skill:', insertText: '/skill:', type: 'component', componentType: 'skill' },
        { label: '/subagent:', insertText: '/subagent:', type: 'component', componentType: 'subagent' },
        { label: '/clear', insertText: '/clear', type: 'special' },
        { label: '/reload', insertText: '/reload', type: 'special' },
        { label: '/compress', insertText: '/compress', type: 'special' }
      ];
      return filter
        ? suggestions.filter(suggestion => suggestion.label.toLowerCase().startsWith(`/${filter}`))
        : suggestions;
    }

    if (state.mode === 'name' && state.type) {
      const matches = componentSuggestions(state.type)
        .filter(item => !state.filter || item.name.toLowerCase().includes(state.filter.toLowerCase()));
      return matches.map(item => ({
        label: `/${item.type}:${item.name}`,
        insertText: `/${item.type}:${item.name} `,
        type: 'component',
        componentType: item.type
      }));
    }
    return [];
  };

  useEffect(() => {
    setSuggestionMode(parseInputState(input).mode);
    setSelectedIndex(0);
  }, [input]);

  useEffect(() => {
    setHistoryIndex(null);
    draftRef.current = '';
  }, [history.length]);

  const insertSuggestion = (suggestion: SuggestionItem) => {
    const lastSlash = input.lastIndexOf('/');
    onInputChange(`${input.slice(0, lastSlash)}${suggestion.insertText}`);
    setSuggestionMode(null);
    inputRef.current?.focus();
  };

  const moveCaretToEnd = () => {
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (!element) return;
      element.selectionStart = element.value.length;
      element.selectionEnd = element.value.length;
    });
  };

  const navigateHistory = (direction: 'older' | 'newer') => {
    if (history.length === 0) return;

    if (direction === 'older') {
      if (historyIndex === null) draftRef.current = input;
      const nextIndex = historyIndex === null
        ? history.length - 1
        : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      onInputChange(history[nextIndex]);
    } else {
      if (historyIndex === null) return;
      const nextIndex = historyIndex + 1;
      if (nextIndex >= history.length) {
        setHistoryIndex(null);
        onInputChange(draftRef.current);
      } else {
        setHistoryIndex(nextIndex);
        onInputChange(history[nextIndex]);
      }
    }
    moveCaretToEnd();
  };

  const submit = () => {
    const { shortcuts, specialCommand, content } = parseShortcuts(input);
    if (specialCommand === 'clear') {
      onClear();
      onInputChange('');
    } else if (specialCommand === 'reload') {
      onReload();
      onInputChange('');
    } else if (specialCommand === 'compress') {
      onCompress();
      onInputChange('');
    } else {
      onSend(content, shortcuts);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const suggestions = getCurrentSuggestions();
    if (suggestionMode && suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex(current => Math.min(current + 1, suggestions.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex(current => Math.max(current - 1, 0));
        return;
      }
      if (
        (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey))
        && !event.ctrlKey
      ) {
        event.preventDefault();
        insertSuggestion(suggestions[selectedIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSuggestionMode(null);
        return;
      }
    }

    if (suggestionMode) {
      return;
    }

    const target = event.currentTarget;
    const isSingleLine = !input.includes('\n');
    if (
      event.key === 'ArrowUp' &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (isSingleLine || target.selectionStart === 0)
    ) {
      event.preventDefault();
      navigateHistory('older');
      return;
    }
    if (
      event.key === 'ArrowDown' &&
      historyIndex !== null &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (isSingleLine || target.selectionEnd === input.length)
    ) {
      event.preventDefault();
      navigateHistory('newer');
      return;
    }

    if (event.key === 'Enter' && event.ctrlKey) {
      event.preventDefault();
      submit();
    }
  };

  const suggestions = getCurrentSuggestions();

  return (
    <section className="composer-wrap">
      {suggestionMode && suggestions.length > 0 && (
        <div className="suggestion-box" role="listbox">
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.label}
              className={`suggestion-item ${index === selectedIndex ? 'selected' : ''}`}
              onClick={() => insertSuggestion(suggestion)}
              onMouseEnter={() => setSelectedIndex(index)}
              role="option"
              aria-selected={index === selectedIndex}
            >
              <span className="suggestion-tag">
                {suggestion.type === 'special'
                  ? 'CMD'
                  : suggestion.componentType === 'tool'
                    ? 'TOOL'
                    : suggestion.componentType === 'skill'
                      ? 'SKILL'
                      : 'AGENT'}
              </span>
              <span>{suggestion.label}</span>
              {index === selectedIndex && <span className="suggestion-key">Tab</span>}
            </div>
          ))}
        </div>
      )}

      <div className="composer">
        <div className="composer-toolbar">
          <select
            className="model-select"
            value={activeModel}
            onChange={event => onModelChange(event.target.value)}
            disabled={isLoading}
            aria-label="当前模型"
          >
            {models.map(model => (
              <option key={model.name} value={model.name}>{model.name}</option>
            ))}
          </select>
          <span className="composer-hint">/ 快捷指令 · ↑↓ 历史 · Ctrl+Enter 发送</span>
        </div>

        <div className="composer-main">
          <textarea
            ref={inputRef}
            className="composer-input"
            value={input}
            onChange={event => {
              setHistoryIndex(null);
              draftRef.current = event.target.value;
              onInputChange(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            placeholder={isLoading ? '任务执行中…' : '描述你想完成的任务'}
            disabled={isLoading}
            rows={2}
            aria-label="任务输入"
          />
          <button
            className="send-button"
            onClick={isLoading ? onCancel : submit}
            disabled={!isLoading && !input.trim()}
            data-mode={isLoading ? 'cancel' : 'send'}
          >
            {isLoading ? '停止' : '发送'}
          </button>
        </div>
      </div>
    </section>
  );
};
