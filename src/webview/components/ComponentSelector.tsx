import React from 'react';

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

interface ComponentSelectorProps {
  expanded: boolean;
  onToggle: () => void;
  activeTab: 'tools' | 'skills' | 'subagents';
  onTabChange: (tab: 'tools' | 'skills' | 'subagents') => void;
  components: DiscoveredComponents | null;
  onToggleComponent: (category: 'tools' | 'skills' | 'subagents', name: string, source: 'workspace' | 'home', enabled: boolean) => void;
  colors: { bg: string; border: string; text: string; secondary: string };
}

export const ComponentSelector: React.FC<ComponentSelectorProps> = ({
  expanded,
  onToggle,
  activeTab,
  onTabChange,
  components,
  onToggleComponent,
  colors
}) => {
  const styles = {
    container: {
      borderTop: `1px solid ${colors.border}`,
    },
    toggle: {
      display: 'flex' as const,
      justifyContent: 'center' as const,
      padding: '6px',
      cursor: 'pointer' as const,
      color: '#858585',
      fontSize: '12px',
    },
    content: {
      padding: '8px 12px',
    },
    tabs: {
      display: 'flex' as const,
      gap: '4px',
      marginBottom: '8px',
    },
    tab: {
      padding: '4px 12px',
      borderRadius: '4px',
      border: 'none',
      backgroundColor: 'transparent',
      color: colors.text,
      cursor: 'pointer' as const,
      fontSize: '12px',
    },
    tabActive: {
      backgroundColor: colors.secondary,
    },
    list: {
      display: 'flex' as const,
      flexDirection: 'column' as const,
      gap: '4px',
    },
    item: {
      display: 'flex' as const,
      alignItems: 'center' as const,
      gap: '8px',
      padding: '4px 8px',
      borderRadius: '4px',
      cursor: 'pointer' as const,
      fontSize: '12px',
    },
    checkbox: {
      width: '14px',
      height: '14px',
    },
    sourceBadge: {
      fontSize: '10px',
      padding: '1px 4px',
      borderRadius: '3px',
      marginLeft: '4px',
      opacity: 0.7,
    }
  };

  const getItems = (): DiscoveredComponent[] => {
    if (!components) return [];
    switch (activeTab) {
      case 'tools':
        return components.tools;
      case 'skills':
        return components.skills;
      case 'subagents':
        return components.subagents;
      default:
        return [];
    }
  };

  const items = getItems();

  return (
    <div style={styles.container}>
      <div style={styles.toggle} onClick={onToggle}>
        {expanded ? '▲ 收起组件' : '▼ 展开组件'}
      </div>

      {expanded && (
        <div style={styles.content}>
          <div style={styles.tabs}>
            {(['tools', 'skills', 'subagents'] as const).map(tab => (
              <button
                key={tab}
                style={{
                  ...styles.tab,
                  ...(activeTab === tab ? styles.tabActive : {})
                }}
                onClick={() => onTabChange(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>

          <div style={styles.list}>
            {items.map((item, i) => (
              <div key={i} style={styles.item}>
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={item.enabled}
                  onChange={() => onToggleComponent(activeTab, item.name, item.source, !item.enabled)}
                />
                <span>{item.name}</span>
                <span style={{
                  ...styles.sourceBadge,
                  backgroundColor: item.source === 'workspace' ? '#4CAF50' : '#2196F3',
                  color: '#fff'
                }}>
                  {item.source === 'workspace' ? 'W' : 'H'}
                </span>
              </div>
            ))}
            {items.length === 0 && (
              <div style={{ color: '#858585', fontSize: '12px' }}>
                暂无组件
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
