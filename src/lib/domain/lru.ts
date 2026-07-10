/**
 * Tiny LRU map. Bounded; evicts the least-recently-used entry when
 * full. Used by `ChatProvider` to cache thinking blocks across
 * multi-round agent turns.
 *
 * Pure ES2015 Map semantics on the read path (Map preserves
 * insertion order). Touching a key via `get` does NOT promote it;
 * the chat-provider uses an explicit `touch` call on the
 * thinking-block round-trip so the read path stays a pure lookup.
 */
export class LruMap<K, V> {
  private readonly capacity: number;
  private readonly store: Map<K, V>;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`LruMap capacity must be a positive integer; got ${capacity}`);
    }
    this.capacity = capacity;
    this.store = new Map();
  }

  get size(): number {
    return this.store.size;
  }

  get(key: K): V | undefined {
    return this.store.get(key);
  }

  has(key: K): boolean {
    return this.store.has(key);
  }

  /**
   * Insert or update a key. If the map is at capacity, evict the
   * least-recently-inserted key (Map iteration order = insertion
   * order, so the first key is the eviction candidate). The new
   * key becomes the most-recently-inserted.
   */
  set(key: K, value: V): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.capacity) {
      const oldest = this.store.keys().next();
      if (!oldest.done) {
        this.store.delete(oldest.value);
      }
    }
    this.store.set(key, value);
  }

  /**
   * Promote a key to the most-recently-inserted position without
   * changing its value. Returns the current value (if any) so the
   * caller can read after promotion.
   */
  touch(key: K): V | undefined {
    const value = this.store.get(key);
    if (value === undefined) return undefined;
    this.store.delete(key);
    this.store.set(key, value);
    return value;
  }

  delete(key: K): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
