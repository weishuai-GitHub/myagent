import { Message, ChatOptions } from '../types';
import { LLMClient } from '../llm';
import { SummarizeFn } from './MessageManager';

const SUMMARY_SYSTEM_PROMPT = `你是一个对话历史压缩助手。你的任务是将对话历史压缩为简洁的摘要。

要求：
- 保留关键决策和结论
- 保留重要的工具调用及其结果（尤其是失败的工具调用）
- 保留用户明确提及的偏好和约束
- 省略中间推理过程和重复内容
- 用条目式格式输出，每条信息一行`;

const SUMMARY_USER_TEMPLATE = `请压缩以下对话历史：`;

/**
 * 创建基于 LLM 的消息摘要函数。
 * @param client LLM 客户端实例
 * @returns 可传给 MessageManager.compressHistory 的 SummarizeFn
 */
export function createSummarizeFn(client: LLMClient, signal?: AbortSignal): SummarizeFn {
  return async (messages: Message[]): Promise<string> => {
    const conversationText = messages
      .map(m => {
        const roleLabel = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统';
        return `[${roleLabel}]: ${m.content}`;
      })
      .join('\n\n');

    const summaryPrompt: Message[] = [
      {
        role: 'user',
        content: `${SUMMARY_USER_TEMPLATE}\n\n${conversationText}`
      }
    ];

    const options: ChatOptions = {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      maxTokens: 2000
    };

    const response = await client.chat(summaryPrompt, options, signal);
    return response.content;
  };
}
