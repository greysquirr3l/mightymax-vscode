import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import { schemaPropertyNames, searchTools, tokenize } from './domain/tool-search.js';

describe('tokenize', () => {
  it('splits camelCase and separators, lowercasing', () => {
    deepStrictEqual(tokenize('mcp_github-createIssue/v2'), [
      'mcp',
      'github',
      'create',
      'issue',
      'v2',
    ]);
  });

  it('turns CJK runs into character bigrams and keeps Latin words', () => {
    deepStrictEqual(tokenize('创建任务 task'), ['创建', '建任', '任务', 'task']);
  });
});

describe('schemaPropertyNames', () => {
  it('collects nested property names to a depth limit', () => {
    const schema = { properties: { a: { properties: { b: {} } }, c: {} } };
    deepStrictEqual(schemaPropertyNames(schema), ['a', 'b', 'c']);
    deepStrictEqual(schemaPropertyNames(schema, 0), ['a', 'c']);
  });
});

describe('searchTools', () => {
  const tools = [
    { name: 'read_file', description: 'Read a file from disk' },
    { name: 'write_file', description: 'Write a file to disk' },
    { name: 'web_search', description: 'Search the web' },
  ];

  it('ranks a name match above the same word elsewhere', () => {
    const hits = searchTools('web', tools, 5);
    strictEqual(hits[0]?.tool.name, 'web_search');
  });

  it('weights rare terms higher (idf)', () => {
    const hits = searchTools('read file', tools, 5);
    strictEqual(hits[0]?.tool.name, 'read_file');
  });

  it('omits zero-score tools and respects the limit', () => {
    strictEqual(searchTools('nonsense', tools, 5).length, 0);
    strictEqual(searchTools('file', tools, 1).length, 1);
  });

  it('is empty for an empty query or inventory', () => {
    strictEqual(searchTools('', tools, 5).length, 0);
    strictEqual(searchTools('file', [], 5).length, 0);
  });
});
