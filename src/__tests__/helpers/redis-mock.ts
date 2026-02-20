/**
 * In-memory Redis mock for testing.
 * Implements the subset of ioredis commands used by HyPaper.
 */

type RedisValue = string;

export class RedisMock {
  private store = new Map<string, RedisValue>();
  private hashes = new Map<string, Map<string, string>>();
  private sets = new Map<string, Set<string>>();
  private sortedSets = new Map<string, Map<string, number>>();
  private lists = new Map<string, string[]>();

  // --- String commands ---

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
      if (this.hashes.delete(key)) count++;
      if (this.sets.delete(key)) count++;
      if (this.sortedSets.delete(key)) count++;
      if (this.lists.delete(key)) count++;
    }
    return count;
  }

  async exists(key: string): Promise<number> {
    if (this.store.has(key) || this.hashes.has(key) || this.sets.has(key)) return 1;
    return 0;
  }

  async incr(key: string): Promise<number> {
    const current = parseInt(this.store.get(key) ?? '0', 10);
    const next = current + 1;
    this.store.set(key, next.toString());
    return next;
  }

  // --- Hash commands ---

  async hset(key: string, ...args: string[]): Promise<number> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const hash = this.hashes.get(key)!;
    let count = 0;
    for (let i = 0; i < args.length; i += 2) {
      if (!hash.has(args[i])) count++;
      hash.set(args[i], args[i + 1]);
    }
    return count;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash);
  }

  async hincrbyfloat(key: string, field: string, increment: string): Promise<string> {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    const hash = this.hashes.get(key)!;
    const current = parseFloat(hash.get(field) ?? '0');
    const result = (current + parseFloat(increment)).toString();
    hash.set(field, result);
    return result;
  }

  // --- Set commands ---

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (!this.sets.has(key)) this.sets.set(key, new Set());
    const set = this.sets.get(key)!;
    let count = 0;
    for (const m of members) {
      if (!set.has(m)) count++;
      set.add(m);
    }
    return count;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let count = 0;
    for (const m of members) {
      if (set.delete(m)) count++;
    }
    return count;
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.sets.get(key);
    return set ? [...set] : [];
  }

  // --- Sorted set commands ---

  async zadd(key: string, score: number, member: string): Promise<number> {
    if (!this.sortedSets.has(key)) this.sortedSets.set(key, new Map());
    const zset = this.sortedSets.get(key)!;
    const isNew = !zset.has(member);
    zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zrange(key: string, _start: number, _stop: number): Promise<string[]> {
    const zset = this.sortedSets.get(key);
    if (!zset) return [];
    return [...zset.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  // --- List commands ---

  async lpush(key: string, ...values: string[]): Promise<number> {
    if (!this.lists.has(key)) this.lists.set(key, []);
    const list = this.lists.get(key)!;
    for (const v of values) {
      list.unshift(v);
    }
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    const end = stop < 0 ? list.length + stop + 1 : stop + 1;
    return list.slice(start, end);
  }

  // --- Pipeline ---

  pipeline(): PipelineMock {
    return new PipelineMock(this);
  }

  // --- Utility ---

  flushall(): void {
    this.store.clear();
    this.hashes.clear();
    this.sets.clear();
    this.sortedSets.clear();
    this.lists.clear();
  }
}

class PipelineMock {
  private commands: Array<() => Promise<unknown>> = [];
  private redis: RedisMock;

  constructor(redis: RedisMock) {
    this.redis = redis;
  }

  hset(key: string, ...args: string[]): this {
    this.commands.push(() => this.redis.hset(key, ...args));
    return this;
  }

  hget(key: string, field: string): this {
    this.commands.push(() => this.redis.hget(key, field));
    return this;
  }

  sadd(key: string, ...members: string[]): this {
    this.commands.push(() => this.redis.sadd(key, ...members));
    return this;
  }

  srem(key: string, ...members: string[]): this {
    this.commands.push(() => this.redis.srem(key, ...members));
    return this;
  }

  zadd(key: string, score: number, member: string): this {
    this.commands.push(() => this.redis.zadd(key, score, member));
    return this;
  }

  del(...keys: string[]): this {
    this.commands.push(() => this.redis.del(...keys));
    return this;
  }

  hincrbyfloat(key: string, field: string, increment: string): this {
    this.commands.push(() => this.redis.hincrbyfloat(key, field, increment));
    return this;
  }

  lpush(key: string, ...values: string[]): this {
    this.commands.push(() => this.redis.lpush(key, ...values));
    return this;
  }

  async exec(): Promise<Array<[null, unknown]>> {
    const results: Array<[null, unknown]> = [];
    for (const cmd of this.commands) {
      const result = await cmd();
      results.push([null, result]);
    }
    return results;
  }
}
