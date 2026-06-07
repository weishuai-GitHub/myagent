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

    return calls;
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

  /** 把 <args> 子元素转换为参数对象。值优先 JSON.parse，失败则保留字符串 */
  private normalizeArgs(argsNode: any): Record<string, any> {
    const out: Record<string, any> = {};
    if (!argsNode || typeof argsNode !== 'object') return out;

    for (const key of Object.keys(argsNode)) {
      if (key === '#text' || key === '#cdata') continue;
      const raw = argsNode[key];
      // 同一参数名出现多次：保留首个，保持与旧实现行为一致
      const node = Array.isArray(raw) ? raw[0] : raw;
      const value = this.extractText(node);
      out[key] = this.tryJSON(value);
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
}
