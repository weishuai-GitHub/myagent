import { XMLParser, ParsedToolCall, ParsedSkillCall, ParsedSubagentCall } from '../../src/agent/xml-parser';

describe('XMLParser', () => {
  it('should parse tool calls correctly', () => {
    const parser = new XMLParser();
    const content = '<tool><name>read_file</name><args><path>/test/file.txt</path></args></tool>';
    const calls = parser.parse(content);

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('tool');
    const toolCall = calls[0] as ParsedToolCall;
    expect(toolCall.name).toBe('read_file');
    expect(toolCall.args).toEqual({ path: '/test/file.txt' });
  });

  it('should parse skill calls correctly', () => {
    const parser = new XMLParser();
    const content = '<skill>tdd</skill>';
    const calls = parser.parse(content);

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('skill');
    const skillCall = calls[0] as ParsedSkillCall;
    expect(skillCall.name).toBe('tdd');
  });

  it('should parse subagent calls correctly', () => {
    const parser = new XMLParser();
    const content = '<subagent><name>code-review</name><question>Review this PR</question></subagent>';
    const calls = parser.parse(content);

    expect(calls).toHaveLength(1);
    expect(calls[0].type).toBe('subagent');
    const subagentCall = calls[0] as ParsedSubagentCall;
    expect(subagentCall.name).toBe('code-review');
    expect(subagentCall.question).toBe('Review this PR');
  });

  it('should parse multiple calls in one content', () => {
    const parser = new XMLParser();
    const content = `
      <tool><name>read_file</name><args><path>/test/file.txt</path></args></tool>
      <skill>tdd</skill>
      <subagent><name>code-review</name><question>Review this PR</question></subagent>
    `;
    const calls = parser.parse(content);

    expect(calls).toHaveLength(3);
    expect(calls[0].type).toBe('tool');
    expect(calls[1].type).toBe('skill');
    expect(calls[2].type).toBe('subagent');
  });

  it('should strip XML tags correctly', () => {
    const parser = new XMLParser();
    const content = `
      This is regular text
      <tool><name>read_file</name><args><path>/test/file.txt</path></args></tool>
      More text
      <skill>tdd</skill>
      Final text
    `;
    const stripped = parser.stripXmlTags(content);

    expect(stripped).toContain('This is regular text');
    expect(stripped).toContain('More text');
    expect(stripped).toContain('Final text');
    expect(stripped).not.toContain('<tool>');
    expect(stripped).not.toContain('<skill>');
  });

  it('should handle empty content', () => {
    const parser = new XMLParser();
    const calls = parser.parse('');
    expect(calls).toHaveLength(0);
  });

  it('should parse args containing the string "</args>" via CDATA', () => {
    const parser = new XMLParser();
    const content = `
      <tool>
        <name>write_file</name>
        <args>
          <path>/test/snippet.md</path>
          <content><![CDATA[Example: </args> in markdown text]]></content>
        </args>
      </tool>
    `;
    const calls = parser.parse(content);

    expect(calls).toHaveLength(1);
    const toolCall = calls[0] as ParsedToolCall;
    expect(toolCall.name).toBe('write_file');
    expect(toolCall.args.path).toBe('/test/snippet.md');
    expect(toolCall.args.content).toBe('Example: </args> in markdown text');
  });

  it('should handle <name> content across multiple lines', () => {
    const parser = new XMLParser();
    const content = `<tool><name>
        read_file
      </name><args><path>/a.txt</path></args></tool>`;
    const calls = parser.parse(content);

    expect(calls).toHaveLength(1);
    expect((calls[0] as ParsedToolCall).name).toBe('read_file');
  });

  it('should parse multiple tool calls without confusion', () => {
    const parser = new XMLParser();
    const content = `
      <tool><name>a</name><args><x>1</x></args></tool>
      <tool><name>b</name><args><y>2</y></args></tool>
    `;
    const calls = parser.parse(content);

    expect(calls).toHaveLength(2);
    expect((calls[0] as ParsedToolCall).name).toBe('a');
    expect((calls[1] as ParsedToolCall).name).toBe('b');
    expect((calls[0] as ParsedToolCall).args).toEqual({ x: 1 });
    expect((calls[1] as ParsedToolCall).args).toEqual({ y: 2 });
  });

  it('should not crash on malformed XML and return no calls', () => {
    const parser = new XMLParser();
    const content = '<tool><name>broken<args><path>/a</path></args>';
    const calls = parser.parse(content);
    expect(Array.isArray(calls)).toBe(true);
  });

  it('should parse JSON args in tool calls', () => {
    const parser = new XMLParser();
    const content = `
      <tool>
        <name>edit_file</name>
        <args>
          <path>/test/file.txt</path>
          <old_content>Hello</old_content>
          <new_content>World</new_content>
        </args>
      </tool>
    `;
    const calls = parser.parse(content);

    expect(calls).toHaveLength(1);
    const toolCall = calls[0] as ParsedToolCall;
    expect(toolCall.args).toEqual({
      path: '/test/file.txt',
      old_content: 'Hello',
      new_content: 'World'
    });
  });
});
