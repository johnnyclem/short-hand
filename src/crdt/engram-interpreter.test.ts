/**
 * Tests for the EngramInterpreter abstraction.
 *
 * Covers:
 *   - RegexInterpreter: deterministic template substitution
 *   - LocalLMInterpreter: ollama HTTP contract (fetch mocked)
 *   - HostLMInterpreter: Anthropic and OpenAI HTTP contracts (fetch mocked)
 *   - createInterpreter factory: discriminated union
 *   - retrieveAsync / interpretAsync on ActiveEngramStore
 *   - Bound enforcement: AbortController fires at timeoutMs
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  RegexInterpreter,
  LocalLMInterpreter,
  HostLMInterpreter,
  createInterpreter,
  DEFAULT_BOUND,
  type InterpreterBound,
} from './engram-interpreter.js';
import { ActiveEngramStore } from './active-engram-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(responseBody: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function hangingFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          } else {
            signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
        }
        // Without a signal the promise hangs forever (not used in tests)
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// RegexInterpreter
// ---------------------------------------------------------------------------

describe('RegexInterpreter', () => {
  it('resolves {{payload}} and {{context}}', async () => {
    const interp = new RegexInterpreter();
    const result = await interp.interpret(
      'Context: {{context}}. Fact: {{payload}}.',
      'database is PostgreSQL',
      'scaling to enterprise',
      DEFAULT_BOUND,
    );
    expect(result).toBe('Context: scaling to enterprise. Fact: database is PostgreSQL.');
  });

  it('replaces multiple occurrences of each placeholder', async () => {
    const interp = new RegexInterpreter();
    const result = await interp.interpret(
      '{{payload}} / {{payload}} — in {{context}} ({{context}})',
      'fact',
      'ctx',
      DEFAULT_BOUND,
    );
    expect(result).toBe('fact / fact — in ctx (ctx)');
  });

  it('returns a Promise (async-compatible)', async () => {
    const interp = new RegexInterpreter();
    const p = interp.interpret('{{payload}}', 'x', 'y', DEFAULT_BOUND);
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe('x');
  });

  it('handles empty template', async () => {
    const interp = new RegexInterpreter();
    expect(await interp.interpret('', 'p', 'c', DEFAULT_BOUND)).toBe('');
  });

  it('accepts bound parameter without error', async () => {
    const interp = new RegexInterpreter();
    const bound: InterpreterBound = { maxTokens: 10, timeoutMs: 500 };
    await expect(interp.interpret('{{payload}}', 'p', 'c', bound)).resolves.toBe('p');
  });

  it('has tier "regex"', () => {
    expect(new RegexInterpreter().tier).toBe('regex');
  });
});

// ---------------------------------------------------------------------------
// LocalLMInterpreter
// ---------------------------------------------------------------------------

describe('LocalLMInterpreter', () => {
  it('has tier "local"', () => {
    const interp = new LocalLMInterpreter({ endpoint: 'http://localhost:11434', model: 'x' });
    expect(interp.tier).toBe('local');
  });

  it('sends POST to <endpoint>/api/generate', async () => {
    mockFetch({ response: 'ollama output', done: true });
    const interp = new LocalLMInterpreter({ endpoint: 'http://localhost:11434', model: 'mistral' });
    await interp.interpret('{{payload}}', 'fact', 'ctx', DEFAULT_BOUND);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/generate');
  });

  it('sends correct body shape', async () => {
    mockFetch({ response: 'ok', done: true });
    const interp = new LocalLMInterpreter({ endpoint: 'http://localhost:11434', model: 'mistral' });
    await interp.interpret(
      'Given {{context}}, restate {{payload}}',
      'fact A',
      'production scale',
      { maxTokens: 128, timeoutMs: 5000 },
    );

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.model).toBe('mistral');
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBe(128);
    // Resolved template
    expect(body.prompt).toContain('fact A');
    expect(body.prompt).toContain('production scale');
  });

  it('returns data.response.trim()', async () => {
    mockFetch({ response: '  trimmed response  ', done: true });
    const interp = new LocalLMInterpreter({ endpoint: 'http://localhost:11434', model: 'x' });
    const result = await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND);
    expect(result).toBe('trimmed response');
  });

  it('throws on non-200 status', async () => {
    mockFetch({ error: 'model not found' }, 404);
    const interp = new LocalLMInterpreter({ endpoint: 'http://localhost:11434', model: 'x' });
    await expect(interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND)).rejects.toThrow('404');
  });

  it('aborts after timeoutMs', async () => {
    vi.useFakeTimers();
    hangingFetch();

    const interp = new LocalLMInterpreter({ endpoint: 'http://localhost:11434', model: 'x' });
    const promise = interp.interpret('{{payload}}', 'p', 'c', { maxTokens: 50, timeoutMs: 1000 });

    vi.advanceTimersByTime(1100);

    await expect(promise).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// HostLMInterpreter — Anthropic
// ---------------------------------------------------------------------------

describe('HostLMInterpreter — Anthropic', () => {
  const anthropicConfig = {
    provider: 'anthropic' as const,
    model: 'claude-haiku-20240307',
    apiKey: 'test-key',
  };

  it('has tier "host"', () => {
    expect(new HostLMInterpreter(anthropicConfig).tier).toBe('host');
  });

  it('POSTs to /v1/messages', async () => {
    mockFetch({ content: [{ type: 'text', text: 'result' }] });
    const interp = new HostLMInterpreter(anthropicConfig);
    await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('sets x-api-key and anthropic-version headers', async () => {
    mockFetch({ content: [{ type: 'text', text: 'result' }] });
    const interp = new HostLMInterpreter(anthropicConfig);
    await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends correct body', async () => {
    mockFetch({ content: [{ type: 'text', text: 'result' }] });
    const interp = new HostLMInterpreter(anthropicConfig);
    await interp.interpret('Given {{context}}: {{payload}}', 'fact', 'new context', {
      maxTokens: 100,
      timeoutMs: 5000,
    });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.model).toBe('claude-haiku-20240307');
    expect(body.max_tokens).toBe(100);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toContain('fact');
    expect(body.messages[0].content).toContain('new context');
  });

  it('returns text block content trimmed', async () => {
    mockFetch({ content: [{ type: 'text', text: '  hello world  ' }] });
    const interp = new HostLMInterpreter(anthropicConfig);
    const result = await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND);
    expect(result).toBe('hello world');
  });

  it('skips non-text blocks and returns text block', async () => {
    mockFetch({
      content: [
        { type: 'tool_use', id: 'tu_1' },
        { type: 'text', text: 'the answer' },
      ],
    });
    const interp = new HostLMInterpreter(anthropicConfig);
    expect(await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND)).toBe('the answer');
  });

  it('throws with status code on non-200', async () => {
    mockFetch({ error: { message: 'Unauthorized' } }, 401);
    const interp = new HostLMInterpreter(anthropicConfig);
    await expect(interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND)).rejects.toThrow('401');
  });

  it('throws when response has no text block', async () => {
    mockFetch({ content: [{ type: 'tool_use', id: 'x' }] });
    const interp = new HostLMInterpreter(anthropicConfig);
    await expect(interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND)).rejects.toThrow(
      /no text block/i,
    );
  });

  it('aborts after timeoutMs', async () => {
    vi.useFakeTimers();
    hangingFetch();

    const interp = new HostLMInterpreter(anthropicConfig);
    const promise = interp.interpret('{{payload}}', 'p', 'c', { maxTokens: 50, timeoutMs: 500 });
    vi.advanceTimersByTime(600);

    await expect(promise).rejects.toThrow();
  });

  it('respects custom baseUrl', async () => {
    mockFetch({ content: [{ type: 'text', text: 'ok' }] });
    const interp = new HostLMInterpreter({ ...anthropicConfig, baseUrl: 'https://proxy.example.com' });
    await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://proxy.example.com/v1/messages');
  });
});

// ---------------------------------------------------------------------------
// HostLMInterpreter — OpenAI
// ---------------------------------------------------------------------------

describe('HostLMInterpreter — OpenAI', () => {
  const openaiConfig = {
    provider: 'openai' as const,
    model: 'gpt-4o-mini',
    apiKey: 'sk-test',
  };

  it('POSTs to /v1/chat/completions', async () => {
    mockFetch({ choices: [{ message: { content: 'result' } }] });
    const interp = new HostLMInterpreter(openaiConfig);
    await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND);

    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('sets Authorization header with Bearer token', async () => {
    mockFetch({ choices: [{ message: { content: 'result' } }] });
    const interp = new HostLMInterpreter(openaiConfig);
    await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND);

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test');
  });

  it('sends correct body', async () => {
    mockFetch({ choices: [{ message: { content: 'ok' } }] });
    const interp = new HostLMInterpreter(openaiConfig);
    await interp.interpret('{{payload}}', 'fact', 'ctx', { maxTokens: 64, timeoutMs: 5000 });

    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.model).toBe('gpt-4o-mini');
    expect(body.max_tokens).toBe(64);
    expect(body.messages[0].role).toBe('user');
  });

  it('returns choices[0].message.content trimmed', async () => {
    mockFetch({ choices: [{ message: { content: '  openai answer  ' } }] });
    const interp = new HostLMInterpreter(openaiConfig);
    expect(await interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND)).toBe('openai answer');
  });

  it('throws with status code on non-200', async () => {
    mockFetch({ error: { message: 'rate limit exceeded' } }, 429);
    const interp = new HostLMInterpreter(openaiConfig);
    await expect(interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND)).rejects.toThrow('429');
  });

  it('throws when choices array is empty', async () => {
    mockFetch({ choices: [] });
    const interp = new HostLMInterpreter(openaiConfig);
    await expect(interp.interpret('{{payload}}', 'p', 'c', DEFAULT_BOUND)).rejects.toThrow(
      /no choices/i,
    );
  });

  it('aborts after timeoutMs', async () => {
    vi.useFakeTimers();
    hangingFetch();

    const interp = new HostLMInterpreter(openaiConfig);
    const promise = interp.interpret('{{payload}}', 'p', 'c', { maxTokens: 50, timeoutMs: 500 });
    vi.advanceTimersByTime(600);

    await expect(promise).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// createInterpreter factory
// ---------------------------------------------------------------------------

describe('createInterpreter', () => {
  it('returns RegexInterpreter for tier "regex"', () => {
    const interp = createInterpreter({ tier: 'regex' });
    expect(interp).toBeInstanceOf(RegexInterpreter);
    expect(interp.tier).toBe('regex');
  });

  it('returns LocalLMInterpreter for tier "local"', () => {
    const interp = createInterpreter({
      tier: 'local',
      local: { endpoint: 'http://localhost:11434', model: 'mistral' },
    });
    expect(interp).toBeInstanceOf(LocalLMInterpreter);
    expect(interp.tier).toBe('local');
  });

  it('returns HostLMInterpreter for tier "host" (anthropic)', () => {
    const interp = createInterpreter({
      tier: 'host',
      host: { provider: 'anthropic', model: 'claude-haiku-20240307', apiKey: 'key' },
    });
    expect(interp).toBeInstanceOf(HostLMInterpreter);
    expect(interp.tier).toBe('host');
  });

  it('returns HostLMInterpreter for tier "host" (openai)', () => {
    const interp = createInterpreter({
      tier: 'host',
      host: { provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-x' },
    });
    expect(interp).toBeInstanceOf(HostLMInterpreter);
  });

  it('returned interpreters satisfy EngramInterpreter interface', () => {
    const interp = createInterpreter({ tier: 'regex' });
    expect(typeof interp.tier).toBe('string');
    expect(typeof interp.interpret).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// ActiveEngramStore.retrieveAsync and interpretAsync
// (uses RegexInterpreter — no network, deterministic)
// ---------------------------------------------------------------------------

describe('ActiveEngramStore — retrieveAsync', () => {
  it('produces the same interpreted output as the sync retrieve() for regex tier', async () => {
    const interp = new RegexInterpreter();

    const storeSync = new ActiveEngramStore();
    storeSync.add('fact A', {
      interpreterTemplate: 'In {{context}}: {{payload}}',
      activationPolicy: { surfaceWhenTopics: [] },
    });
    const syncResults = storeSync.retrieve('context X');

    const storeAsync = new ActiveEngramStore();
    storeAsync.add('fact A', {
      interpreterTemplate: 'In {{context}}: {{payload}}',
      activationPolicy: { surfaceWhenTopics: [] },
    });
    const asyncResults = await storeAsync.retrieveAsync('context X', interp);

    expect(asyncResults[0].interpreted).toBe(syncResults[0].interpreted);
    expect(asyncResults[0].payload).toBe(syncResults[0].payload);
  });

  it('increments retrievalCount', async () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    await store.retrieveAsync('ctx', new RegexInterpreter());
    expect(store.get(id)!.retrievalCount).toBe(1);
  });

  it('increments retrievalCount on each call', async () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    const interp = new RegexInterpreter();
    await store.retrieveAsync('ctx', interp);
    await store.retrieveAsync('ctx', interp);
    expect(store.get(id)!.retrievalCount).toBe(2);
  });

  it('returns empty array when no engrams are eligible', async () => {
    const store = new ActiveEngramStore();
    store.add('fact', { activationPolicy: { surfaceWhenTopics: ['specific-topic'] } });
    const results = await store.retrieveAsync('unrelated context', new RegexInterpreter());
    expect(results).toHaveLength(0);
  });

  it('sorts results descending by importanceScore', async () => {
    const store = new ActiveEngramStore();
    store.add('low', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.2 });
    store.add('high', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.9 });
    store.add('mid', { activationPolicy: { surfaceWhenTopics: [] }, importanceScore: 0.5 });

    const results = await store.retrieveAsync('ctx', new RegexInterpreter());
    expect(results[0].importanceScore).toBe(0.9);
    expect(results[1].importanceScore).toBe(0.5);
    expect(results[2].importanceScore).toBe(0.2);
  });

  it('applies shadow resolution', async () => {
    const store = new ActiveEngramStore();
    const originalId = store.add('old fact', {
      activationPolicy: { surfaceWhenTopics: [] },
      importanceScore: 0.5,
    });
    store.add('corrected fact', {
      activationPolicy: { surfaceWhenTopics: [], shadowsEngramId: originalId },
      importanceScore: 0.8,
    });

    const results = await store.retrieveAsync('ctx', new RegexInterpreter());
    expect(results).toHaveLength(1);
    expect(results[0].engramId).toBe(originalId);
    expect(results[0].payload).toBe('corrected fact');
  });

  it('propagates interpreter error (timeout)', async () => {
    vi.useFakeTimers();
    hangingFetch();

    const store = new ActiveEngramStore();
    store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });

    const interp = new LocalLMInterpreter({ endpoint: 'http://x', model: 'y' });
    const promise = store.retrieveAsync('ctx', interp, {
      bound: { maxTokens: 50, timeoutMs: 200 },
    });
    vi.advanceTimersByTime(300);

    await expect(promise).rejects.toThrow();
  });
});

describe('ActiveEngramStore — interpretAsync', () => {
  it('does NOT increment retrievalCount', async () => {
    const store = new ActiveEngramStore();
    const id = store.add('fact', { activationPolicy: { surfaceWhenTopics: [] } });
    await store.interpretAsync(id, 'ctx', new RegexInterpreter());
    await store.interpretAsync(id, 'ctx', new RegexInterpreter());
    expect(store.get(id)!.retrievalCount).toBe(0);
  });

  it('returns undefined for unknown id', async () => {
    const store = new ActiveEngramStore();
    const result = await store.interpretAsync('nonexistent', 'ctx', new RegexInterpreter());
    expect(result).toBeUndefined();
  });

  it('returns contextualized output', async () => {
    const store = new ActiveEngramStore();
    const id = store.add('database is PostgreSQL', {
      interpreterTemplate: 'Given {{context}}: {{payload}}',
      activationPolicy: { surfaceWhenTopics: [] },
    });

    const result = await store.interpretAsync(id, 'enterprise scaling', new RegexInterpreter());
    expect(result!.interpreted).toContain('enterprise scaling');
    expect(result!.interpreted).toContain('database is PostgreSQL');
  });

  it('different contexts produce different interpreted outputs', async () => {
    const store = new ActiveEngramStore();
    const id = store.add('use TypeScript', {
      interpreterTemplate: 'In {{context}}: {{payload}}',
      activationPolicy: { surfaceWhenTopics: [] },
    });
    const interp = new RegexInterpreter();

    const r1 = await store.interpretAsync(id, 'backend development', interp);
    const r2 = await store.interpretAsync(id, 'frontend development', interp);

    expect(r1!.interpreted).not.toBe(r2!.interpreted);
  });

  it('preserves payload verbatim in result', async () => {
    const store = new ActiveEngramStore();
    const id = store.add('exact payload text', { activationPolicy: { surfaceWhenTopics: [] } });
    const result = await store.interpretAsync(id, 'ctx', new RegexInterpreter());
    expect(result!.payload).toBe('exact payload text');
  });
});
