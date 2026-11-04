/**
 * BM25 relevance search over a tool inventory (pure).
 *
 * Replaces browsing MCP servers one at a time: the model describes what
 * it needs and gets the best-matching tools back, wherever they live.
 * Documents are built from each tool's name, description and flattened
 * input-schema property names, so a query can match a parameter
 * ("branch") as well as a purpose ("create a pull request").
 */

const K1 = 1.5;
const B = 0.75;

/**
 * A term repeated more often than this in one document stops adding to
 * its score. Without a cap a description that repeats a word ten times
 * outranks the tool whose NAME is that word.
 */
const MAX_TERM_FREQUENCY = 3;

/** Words that carry no tool-selection signal; they match most of the corpus. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'can', 'for', 'from', 'how', 'i',
  'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'so', 'that', 'the', 'this',
  'to', 'use', 'want', 'what', 'when', 'which', 'with', 'would', 'you', 'your',
]);

/**
 * Reduce a word to a crude stem so "changing", "changed" and "changes"
 * meet at "chang". Deliberately minimal (no Porter): it only strips the
 * common inflections, and only when a stem of 3+ letters remains.
 */
export function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.length - suffix.length >= 3 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** A CJK ideograph / kana / hangul: tokenized as character bigrams, since there are no spaces. */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;

/** Add a Latin word as a stemmed term, skipping stop words and lone letters. */
function pushWord(terms: string[], word: string): void {
  if (STOP_WORDS.has(word)) return;
  if (word.length < 2 && !/\d/.test(word)) return;
  terms.push(stem(word));
}

/** Split text into lowercase terms: camelCase and `_ - / .` separated words, CJK as bigrams. */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  for (const chunk of spaced.split(/[^\p{L}\p{N}]+/u)) {
    if (chunk === '') continue;
    if (!CJK.test(chunk)) {
      pushWord(terms, chunk);
      continue;
    }
    // Mixed runs: Latin stretches stay words, CJK stretches become bigrams.
    for (const run of chunk.match(/[぀-ヿ㐀-䶿一-鿿가-힯]+|[^぀-ヿ㐀-䶿一-鿿가-힯]+/g) ?? []) {
      if (!CJK.test(run)) pushWord(terms, run);
      else if (run.length === 1) terms.push(run);
      else for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2));
    }
  }
  return terms;
}

/** Property names of a JSON schema, depth-limited, for indexing. */
export function schemaPropertyNames(schema: unknown, depth = 3): string[] {
  if (depth < 0 || typeof schema !== 'object' || schema === null) return [];
  const props = (schema as { properties?: unknown }).properties;
  if (typeof props !== 'object' || props === null) return [];
  const names: string[] = [];
  for (const [name, sub] of Object.entries(props)) {
    names.push(name, ...schemaPropertyNames(sub, depth - 1));
  }
  return names;
}

export interface SearchableTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: object | undefined;
}

export interface ToolSearchHit<T extends SearchableTool> {
  readonly tool: T;
  readonly score: number;
}

/**
 * Rank `tools` against `query` with BM25. Name terms are repeated so a
 * name match outweighs the same word buried in a description, and a
 * term's frequency is capped so repetition cannot buy a ranking. Tools
 * scoring zero are omitted; ties keep inventory order.
 */
export function searchTools<T extends SearchableTool>(
  query: string,
  tools: ReadonlyArray<T>,
  limit: number,
): ReadonlyArray<ToolSearchHit<T>> {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0 || tools.length === 0) return [];

  const docs = tools.map((tool) => {
    const terms = [
      ...tokenize(tool.name),
      ...tokenize(tool.name),
      ...tokenize(tool.description),
      ...schemaPropertyNames(tool.inputSchema).flatMap(tokenize),
    ];
    const freq = new Map<string, number>();
    for (const term of terms) freq.set(term, (freq.get(term) ?? 0) + 1);
    return { freq, length: terms.length };
  });
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;

  const hits: Array<ToolSearchHit<T>> = [];
  tools.forEach((tool, i) => {
    const doc = docs[i];
    if (doc === undefined) return;
    let score = 0;
    for (const term of queryTerms) {
      const tf = Math.min(MAX_TERM_FREQUENCY, doc.freq.get(term) ?? 0);
      if (tf === 0) continue;
      const df = docs.filter((d) => d.freq.has(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / avgLength));
    }
    if (score > 0) hits.push({ tool, score });
  });
  // Array.prototype.sort is stable, so equal scores keep inventory order.
  return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
}
