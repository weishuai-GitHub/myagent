import { Message } from '../types';

interface ConversationItemBase {
  id: string;
  createdAt: number;
}

export interface ConversationMessageItem extends ConversationItemBase {
  role: Message['role'];
  content: string;
}

export interface ConversationToolItem extends ConversationItemBase {
  role: 'tool';
  callId: string;
  callType: 'tool' | 'skill' | 'subagent';
  name: string;
  status: 'success' | 'error';
  content: string;
}

export type ConversationItem = ConversationMessageItem | ConversationToolItem;

export interface ConversationSnapshot {
  version: 1;
  items: ConversationItem[];
}
