import { Message } from '../types';
import {
  ConversationItem,
  ConversationMessageItem,
  ConversationSnapshot,
  ConversationToolItem
} from './types';

let nextItemSequence = 0;

function createItemId(): string {
  nextItemSequence += 1;
  return `msg-${Date.now().toString(36)}-${nextItemSequence.toString(36)}`;
}

function cloneItem(item: ConversationItem): ConversationItem {
  return { ...item };
}

function isMessageItem(item: ConversationItem): item is ConversationMessageItem {
  return item.role !== 'tool';
}

function toMessage(item: ConversationItem): Message {
  if (isMessageItem(item)) {
    return { role: item.role, content: item.content };
  }
  return {
    role: 'user',
    content: `${item.callType} ${item.name} 结果: ${item.content}`
  };
}

function messageEquals(left: Message, right: Message): boolean {
  return left.role === right.role && left.content === right.content;
}

export class ConversationStore {
  private items: ConversationItem[] = [];

  appendMessage(message: Message): void {
    this.items.push({
      id: createItemId(),
      createdAt: Date.now(),
      role: message.role,
      content: message.content
    });
  }

  appendToolResult(result: Omit<ConversationToolItem, 'id' | 'createdAt' | 'role'>): void {
    this.items.push({
      id: createItemId(),
      createdAt: Date.now(),
      role: 'tool',
      ...result
    });
  }

  pop(): ConversationItem | undefined {
    return this.items.pop();
  }

  get length(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  rollbackTo(checkpoint: number): void {
    if (!Number.isInteger(checkpoint) || checkpoint < 0 || checkpoint > this.items.length) {
      throw new Error(`Invalid conversation checkpoint: ${checkpoint}`);
    }
    this.items.splice(checkpoint);
  }

  toMessages(): Message[] {
    return this.items.map(toMessage);
  }

  /**
   * 用扁平 LLM 历史替换当前内容，并尽量保留未变化前缀的 id/createdAt。
   * 这是旧 Message 协议迁移到结构化 ConversationItem 期间的兼容入口。
   */
  replaceMessages(messages: readonly Message[]): void {
    const currentMessages = this.toMessages();
    let commonPrefix = 0;
    while (
      commonPrefix < currentMessages.length &&
      commonPrefix < messages.length &&
      messageEquals(currentMessages[commonPrefix], messages[commonPrefix])
    ) {
      commonPrefix += 1;
    }

    const nextItems = this.items.slice(0, commonPrefix).map(cloneItem);
    for (const message of messages.slice(commonPrefix)) {
      nextItems.push({
        id: createItemId(),
        createdAt: Date.now(),
        role: message.role,
        content: message.content
      });
    }
    this.items = nextItems;
  }

  createSnapshot(): ConversationSnapshot {
    return {
      version: 1,
      items: this.items.map(cloneItem)
    };
  }

  replaceWithSummary(summaryContent: string, keepRecent: number): void {
    const recent = this.items.slice(-keepRecent).map(cloneItem);
    this.items = [
      {
        id: createItemId(),
        createdAt: Date.now(),
        role: 'system',
        content: summaryContent
      },
      ...recent
    ];
  }

  restore(snapshot: ConversationSnapshot | readonly Message[]): void {
    if (Array.isArray(snapshot)) {
      this.items = [];
      this.replaceMessages(snapshot as readonly Message[]);
      return;
    }
    const conversationSnapshot = snapshot as ConversationSnapshot;
    if (conversationSnapshot.version !== 1 || !Array.isArray(conversationSnapshot.items)) {
      throw new Error('Unsupported conversation snapshot');
    }
    this.items = conversationSnapshot.items.map(cloneItem);
  }
}
