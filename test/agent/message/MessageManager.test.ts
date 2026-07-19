import { MessageManager } from '../../../src/agent/message/MessageManager';

describe('MessageManager', () => {
  it('setSystemContext stores systemPrompt and componentDescriptions', () => {
    const mm = new MessageManager();
    mm.setSystemContext('SP', 'COMPS');
    expect(mm.getSystemPrompt()).toBe('SP');
    expect((mm as any).componentDescriptions).toBe('COMPS');
  });

  it('addUserMessage does NOT auto-prepend system on first call', () => {
    const mm = new MessageManager();
    mm.setSystemContext('SP', 'COMPS'); // 即使设置了组件描述，也不应自动注入
    mm.addUserMessage('hi');
    const msgs = mm.getMessages();
    expect(msgs).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('multiple addUserMessage calls only push user messages', () => {
    const mm = new MessageManager();
    mm.setSystemContext('SP', 'COMPS');
    mm.addUserMessage('a');
    mm.addUserMessage('b');
    const msgs = mm.getMessages();
    expect(msgs).toEqual([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' }
    ]);
  });

  it('resetTokenUsage zeroes tokenUsage', () => {
    const mm = new MessageManager();
    mm.addTokenUsage({ inputTokens: 100, outputTokens: 50 });
    mm.addTokenUsage({ inputTokens: 20, outputTokens: 10 });
    expect(mm.getTokenUsage()).toEqual({ inputTokens: 120, outputTokens: 60, totalTokens: 180 });
    mm.resetTokenUsage();
    expect(mm.getTokenUsage()).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('clearHistory preserves systemPrompt and componentDescriptions', () => {
    const mm = new MessageManager();
    mm.setSystemContext('SP', 'COMPS');
    mm.addUserMessage('a');
    mm.addAssistantMessage('b');
    mm.clearHistory();
    expect(mm.getLength()).toBe(0);
    expect(mm.getSystemPrompt()).toBe('SP');
    expect((mm as any).componentDescriptions).toBe('COMPS');
  });

  it('compressHistory replaces middle messages with summary', async () => {
    const mm = new MessageManager({ keepRecent: 2 });
    for (let i = 0; i < 8; i++) mm.addUserMessage(`m${i}`);
    const summarize = jest.fn().mockResolvedValue('SUM');
    const compressed = await mm.compressHistory(summarize);
    expect(compressed).toBe(true);
    const msgs = mm.getMessages();
    // 摘要(1) + recent(2) = 3
    expect(msgs.length).toBe(3);
    expect(msgs[0].content).toContain('SUM');
  });

  it('needsCompression honors threshold', () => {
    const mm = new MessageManager({ compressThreshold: 1000 });
    expect(mm.needsCompression(500)).toBe(false);
    expect(mm.needsCompression(1500)).toBe(true);
  });
});
