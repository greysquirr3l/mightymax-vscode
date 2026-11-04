import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';

import { schemaPropertyNames, searchTools, stem, tokenize } from './domain/tool-search.js';

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

// ─── #112: stemming, stop words, minimum length, frequency cap ─────────────

describe('tokenisation hygiene (#112)', () => {
  it('stems common inflections so changing / changed / changes meet', () => {
    deepStrictEqual(tokenize('changing changed changes change'), ['chang', 'chang', 'chang', 'change']);
    strictEqual(stem('files'), 'fil');
    strictEqual(stem('bus'), 'bus'); // would leave a 1-letter stem
  });

  it('drops stop words and lone letters but keeps digits and 2-letter terms', () => {
    deepStrictEqual(tokenize('a of to the in is it'), []);
    deepStrictEqual(tokenize('x v2 id 7'), ['v2', 'id', '7']);
  });

  it('a query of pure stop words returns nothing', () => {
    const tools = [{ name: 'read_file', description: 'Read a file from disk' }];
    strictEqual(searchTools('a of to the in is it', tools, 8).length, 0);
  });

  it('finds a tool through an inflected query', () => {
    const tools = [
      { name: 'coraline_impact', description: 'Analyze the impact radius of changing a symbol' },
      { name: 'other', description: 'Something unrelated' },
    ];
    strictEqual(searchTools('what would break if I changed this', tools, 8)[0]?.tool.name, 'coraline_impact');
  });

  it('repeating a word in a description cannot outrank an exact name match', () => {
    const tools = [
      { name: 'unrelated_tool', description: 'upload '.repeat(10) + 'things' },
      { name: 'upload', description: 'Upload a file' },
    ];
    strictEqual(searchTools('upload', tools, 8)[0]?.tool.name, 'upload');
  });
});
