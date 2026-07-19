import { XMLParser as FastXMLParser } from 'fast-xml-parser';

export interface ParsedToolCall {
  type: 'tool';
  name: string;
  args: Record<string, any>;
}

export interface ParsedSkillCall {
  type: 'skill';
  name: string;
}

export interface ParsedSubagentCall {
  type: 'subagent';
  name: string;
  question: string;
}

export type ParsedCall = ParsedToolCall | ParsedSkillCall | ParsedSubagentCall;

/**
 * 使用 fast-xml-parser 解析 LLM 输出中的 <tool>/<skill>/<subagent> 调用。
 *
 * 解决正则解析方案的以下缺陷：
 *   1. <args> 内容包含 </args> 时不再断裂（库基于状态机解析）
 *   2. <name> 跨行内容能正常匹配
 *   3. 多个/嵌套同名标签按真实 XML 结构处理
 *   4. args 子参数不会把内容里的随机 HTML 标签误当成参数
 */
export class XMLParser {
  private parser: FastXMLParser;
  private orderParser: FastXMLParser;

  constructor() {
    this.parser = new FastXMLParser({
      ignoreAttributes: true,
      // 保留原始字符串值，不要把 "123"/"true" 自动转成数字/布尔
      parseTagValue: false,
      trimValues: true,
      // 让同名标签始终以数组形式返回，便于统一处理
      isArray: (tagName: string) => ['tool', 'skill', 'subagent'].includes(tagName),
      // 文本节点的 key
      textNodeName: '#text',
      // 允许 CDATA，args 里若包含特殊字符可由 LLM 用 <![CDATA[...]]> 包裹
      cdataPropName: '#cdata',
      // 容错：不严格校验
      allowBooleanAttributes: true,
      processEntities: true
    });
    this.orderParser = new FastXMLParser({
      ignoreAttributes: true,
      parseTagValue: false,
      trimValues: true,
      preserveOrder: true,
      textNodeName: '#text',
      cdataPropName: '#cdata',
      allowBooleanAttributes: true,
      processEntities: true
    });
  }

  parse(content: string): ParsedCall[] {
    const calls: ParsedCall[] = [];
    if (!content || typeof content !== 'string') return calls;

    // 把 LLM 文本整体包一层 root，避免多个顶层标签解析问题
    const wrapped = `<root>${content}</root>`;

    let parsed: any;
    try {
      parsed = this.parser.parse(wrapped);
    } catch {
      // 解析失败时返回空，调用方按"无调用"处理
      return calls;
    }

    const root = parsed?.root;
    if (!root || typeof root !== 'object') return calls;

    const tools = this.toArray(root.tool);
    for (const t of tools) {
      const name = this.extractText(t?.name);
      if (!name) continue;
      const args = this.normalizeArgs(t?.args);
      calls.push({ type: 'tool', name, args });
    }

    const skills = this.toArray(root.skill);
    for (const s of skills) {
      const name = this.extractText(s);
      if (!name) continue;
      calls.push({ type: 'skill', name });
    }

    const subagents = this.toArray(root.subagent);
    for (const sa of subagents) {
      const name = this.extractText(sa?.name);
      const question = this.extractText(sa?.question);
      if (!name) continue;
      calls.push({ type: 'subagent', name, question: question ?? '' });
    }

    return this.restoreDocumentOrder(wrapped, calls);
  }

  stripXmlTags(content: string): string {
    // 这里仍用正则做粗剥离，目标只是删去调用标签，便于把"对用户说的话"展示出来。
    // 与解析逻辑不同，这里允许少量误差。
    return content
      .replace(/<tool\b[\s\S]*?<\/tool>/g, '')
      .replace(/<skill\b[\s\S]*?<\/skill>/g, '')
      .replace(/<subagent\b[\s\S]*?<\/subagent>/g, '')
      .trim();
  }

  /** 将 fast-xml-parser 的"单个对象 or 数组"统一成数组 */
  private toArray<T>(v: T | T[] | undefined | null): T[] {
    if (v === undefined || v === null) return [];
    return Array.isArray(v) ? v : [v];
  }

  /** 从节点中提取纯文本（兼容字符串、{ '#text': '...' }、{ '#cdata': '...' }） */
  private extractText(node: any): string {
    if (node === undefined || node === null) return '';
    if (typeof node === 'string') return node.trim();
    if (typeof node === 'number' || typeof node === 'boolean') return String(node);
    if (typeof node === 'object') {
      if (typeof node['#cdata'] === 'string') return node['#cdata'].trim();
      if (typeof node['#text'] === 'string') return node['#text'].trim();
    }
    return '';
  }

  /**
   * 支持两种形式：
   * 1. <args><path>...</path></args>（兼容旧协议）
   * 2. <args><![CDATA[{"path":"...","options":{"recursive":true}}]]></args>
   */
  private normalizeArgs(argsNode: any): Record<string, any> {
    if (argsNode === undefined || argsNode === null) return {};

    const directText = this.extractText(argsNode);
    if (directText) {
      const parsed = this.tryJSON(directText);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }

    if (typeof argsNode !== 'object' || Array.isArray(argsNode)) return {};
    const converted = this.nodeToValue(argsNode);
    return converted && typeof converted === 'object' && !Array.isArray(converted)
      ? converted
      : {};
  }

  private nodeToValue(node: any): any {
    if (Array.isArray(node)) return node.map(item => this.nodeToValue(item));
    if (node === undefined || node === null) return node;
    if (typeof node !== 'object') return this.tryJSON(String(node).trim());

    const directText = this.extractText(node);
    const childKeys = Object.keys(node).filter(key => key !== '#text' && key !== '#cdata');
    if (childKeys.length === 0) return this.tryJSON(directText);

    const out: Record<string, any> = {};
    for (const key of childKeys) {
      out[key] = this.nodeToValue(node[key]);
    }
    return out;
  }

  private tryJSON(value: string): any {
    if (value === '') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private restoreDocumentOrder(wrapped: string, groupedCalls: ParsedCall[]): ParsedCall[] {
    let orderedDocument: any;
    try {
      orderedDocument = this.orderParser.parse(wrapped);
    } catch {
      return groupedCalls;
    }
    const root = Array.isArray(orderedDocument)
      ? orderedDocument.find(node => node?.root)?.root
      : undefined;
    if (!Array.isArray(root)) return groupedCalls;

    const queues = {
      tool: groupedCalls.filter(call => call.type === 'tool'),
      skill: groupedCalls.filter(call => call.type === 'skill'),
      subagent: groupedCalls.filter(call => call.type === 'subagent')
    };
    const indexes = { tool: 0, skill: 0, subagent: 0 };
    const ordered: ParsedCall[] = [];
    for (const node of root) {
      const type = (['tool', 'skill', 'subagent'] as const)
        .find(candidate => Object.prototype.hasOwnProperty.call(node ?? {}, candidate));
      if (!type) continue;
      const call = queues[type][indexes[type]++];
      if (call) ordered.push(call);
    }
    return ordered.length === groupedCalls.length ? ordered : groupedCalls;
  }
}
