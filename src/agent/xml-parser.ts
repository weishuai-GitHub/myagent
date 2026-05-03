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

export class XMLParser {
  parse(content: string): ParsedCall[] {
    const calls: ParsedCall[] = [];

    // 解析 tool 标签
    const toolRegex = /<tool>\s*<name>(.*?)<\/name>\s*<args>([\s\S]*?)<\/args>\s*<\/tool>/g;
    let match;
    while ((match = toolRegex.exec(content)) !== null) {
      const name = match[1].trim();
      const argsContent = match[2];
      const args = this.parseArgs(argsContent);
      calls.push({ type: 'tool', name, args });
    }

    // 解析 skill 标签
    const skillRegex = /<skill>(.*?)<\/skill>/g;
    while ((match = skillRegex.exec(content)) !== null) {
      const name = match[1].trim();
      calls.push({ type: 'skill', name });
    }

    // 解析 subagent 标签
    const subagentRegex = /<subagent>\s*<name>(.*?)<\/name>\s*<question>(.*?)<\/question>\s*<\/subagent>/g;
    while ((match = subagentRegex.exec(content)) !== null) {
      const name = match[1].trim();
      const question = match[2].trim();
      calls.push({ type: 'subagent', name, question });
    }

    return calls;
  }

  private parseArgs(content: string): Record<string, any> {
  const args: Record<string, any> = {};
  // 关键：确保每次调用函数时，正则都是全新的
  const argRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  
  let match;
  while ((match = argRegex.exec(content)) !== null) {
    const key = match[1];
    let value: any = match[2].trim();
    try {
      value = JSON.parse(value);
    } catch {
      // 保持原样
    }
    args[key] = value;
  }
  return args;
}

  stripXmlTags(content: string): string {
    return content
      .replace(/<tool>[\s\S]*?<\/tool>/g, '')
      .replace(/<skill>[\s\S]*?<\/skill>/g, '')
      .replace(/<subagent>[\s\S]*?<\/subagent>/g, '')
      .trim();
  }
}
