import React from 'react';
import { DiscoveredComponent, DiscoveredComponents } from '../types';

type ComponentTab = 'tools' | 'skills' | 'subagents';

interface ComponentSelectorProps {
  expanded: boolean;
  onToggle: () => void;
  activeTab: ComponentTab;
  onTabChange: (tab: ComponentTab) => void;
  components: DiscoveredComponents | null;
  onToggleComponent: (
    category: ComponentTab,
    name: string,
    source: 'workspace' | 'home',
    enabled: boolean
  ) => void;
}

const TAB_LABELS: Record<ComponentTab, string> = {
  tools: '工具',
  skills: '技能',
  subagents: '子代理'
};

export const ComponentSelector: React.FC<ComponentSelectorProps> = ({
  expanded,
  onToggle,
  activeTab,
  onTabChange,
  components,
  onToggleComponent
}) => {
  const getItems = (): DiscoveredComponent[] => components?.[activeTab] ?? [];
  const items = getItems();
  const enabledCount = components
    ? [...components.tools, ...components.skills, ...components.subagents].filter(item => item.enabled).length
    : 0;

  return (
    <section className="component-panel">
      <button
        className="component-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {expanded ? '收起组件' : `组件配置 · 已启用 ${enabledCount}`}
      </button>

      {expanded && (
        <div className="component-content">
          <div className="component-tabs" role="tablist" aria-label="组件分类">
            {(Object.keys(TAB_LABELS) as ComponentTab[]).map(tab => (
              <button
                key={tab}
                className={`component-tab ${activeTab === tab ? 'active' : ''}`}
                onClick={() => onTabChange(tab)}
                role="tab"
                aria-selected={activeTab === tab}
              >
                {TAB_LABELS[tab]}
                {components ? ` ${components[tab].filter(item => item.enabled).length}/${components[tab].length}` : ''}
              </button>
            ))}
          </div>

          <div className="component-list">
            {items.map(item => (
              <label className="component-item" key={`${item.source}:${item.name}`} title={item.description}>
                <span className="component-item-main">
                  <input
                    type="checkbox"
                    className="component-checkbox"
                    checked={item.enabled}
                    onChange={() => onToggleComponent(activeTab, item.name, item.source, !item.enabled)}
                  />
                  <span className="component-name">{item.name}</span>
                </span>
                <span className="source-badge">
                  {item.source === 'workspace' ? '项目' : '全局'}
                </span>
              </label>
            ))}
            {items.length === 0 && <div className="empty-components">暂无组件</div>}
          </div>
        </div>
      )}
    </section>
  );
};
