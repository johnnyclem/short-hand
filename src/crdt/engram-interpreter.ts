/**
 * EngramInterpreter — tiered interpretation of ActiveEngram payloads.
 *
 * Three tiers:
 *   regex — synchronous string substitution, no LM, no network
 *   local — bounded HTTP call to a local ollama endpoint
 *   host  — bounded HTTP call to Anthropic or OpenAI Messages API
 *
 * The `interpreterTemplate` on each ActiveEngram is resolved with
 * {{payload}} and {{context}} before being passed to the LM as a prompt.
 * The LM then produces a contextualized restatement of the engram.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type InterpreterTier = 'regex' | 'local' | 'host';

/** Hard limits applied to every LM call. Plain data — no methods. */
export interface InterpreterBound {
  /** Maximum tokens the LM may emit. */
  maxTokens: number;
  /** Wall-clock deadline for the HTTP call (ms). AbortController fires here. */
  timeoutMs: number;
}

export const DEFAULT_BOUND: InterpreterBound = {
  maxTokens: 256,
  timeoutMs: 10_000,
};

export interface EngramInterpreter {
  readonly tier: InterpreterTier;
  interpret(
    template: string,
    payload: string,
    context: string,
    bound: InterpreterBound,
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveTemplate(template: string, payload: string, context: string): string {
  return template
    .replace(/\{\{payload\}\}/g, payload)
    .replace(/\{\{context\}\}/g, context);
}

function makeAbortTimer(timeoutMs: number): { controller: AbortController; clear: () => void } {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, clear: () => clearTimeout(id) };
}

// ---------------------------------------------------------------------------
// Tier 0: RegexInterpreter
// ---------------------------------------------------------------------------

export class RegexInterpreter implements EngramInterpreter {
  readonly tier = 'regex' as const;

  interpret(
    template: string,
    payload: string,
    context: string,
    _bound: InterpreterBound,
  ): Promise<string> {
    return Promise.resolve(resolveTemplate(template, payload, context));
  }
}

// ---------------------------------------------------------------------------
// Tier 1: LocalLMInterpreter (ollama)
// ---------------------------------------------------------------------------

export interface LocalLMConfig {
  /** Base URL of the ollama server. e.g. "http://localhost:11434" */
  endpoint: string;
  /** Model name as known to ollama. e.g. "mistral" */
  model: string;
}

export class LocalLMInterpreter implements EngramInterpreter {
  readonly tier = 'local' as const;

  constructor(private readonly config: LocalLMConfig) {}

  async interpret(
    template: string,
    payload: string,
    context: string,
    bound: InterpreterBound,
  ): Promise<string> {
    const prompt = resolveTemplate(template, payload, context);
    const { controller, clear } = makeAbortTimer(bound.timeoutMs);

    try {
      const response = await fetch(`${this.config.endpoint}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt,
          stream: false,
          options: { num_predict: bound.maxTokens },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama returned HTTP ${response.status}`);
      }

      const data = await response.json() as { response: string };
      return data.response.trim();
    } finally {
      clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Tier 2: HostLMInterpreter (Anthropic / OpenAI)
// ---------------------------------------------------------------------------

export type HostProvider = 'anthropic' | 'openai';

export interface HostLMConfig {
  provider: HostProvider;
  model: string;
  apiKey: string;
  /** Override base URL for custom or proxy endpoints. */
  baseUrl?: string;
}

export class HostLMInterpreter implements EngramInterpreter {
  readonly tier = 'host' as const;

  constructor(private readonly config: HostLMConfig) {}

  async interpret(
    template: string,
    payload: string,
    context: string,
    bound: InterpreterBound,
  ): Promise<string> {
    const prompt = resolveTemplate(template, payload, context);
    const { controller, clear } = makeAbortTimer(bound.timeoutMs);

    try {
      return this.config.provider === 'anthropic'
        ? await this.callAnthropic(prompt, bound, controller)
        : await this.callOpenAI(prompt, bound, controller);
    } finally {
      clear();
    }
  }

  private async callAnthropic(
    prompt: string,
    bound: InterpreterBound,
    controller: AbortController,
  ): Promise<string> {
    const base = this.config.baseUrl ?? 'https://api.anthropic.com';
    const response = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: bound.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${text}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };
    const block = data.content.find((b) => b.type === 'text');
    if (!block) throw new Error('Anthropic response contained no text block');
    return block.text.trim();
  }

  private async callOpenAI(
    prompt: string,
    bound: InterpreterBound,
    controller: AbortController,
  ): Promise<string> {
    const base = this.config.baseUrl ?? 'https://api.openai.com';
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: bound.maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const choice = data.choices[0];
    if (!choice) throw new Error('OpenAI response contained no choices');
    return choice.message.content.trim();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type InterpreterConfig =
  | { tier: 'regex' }
  | { tier: 'local'; local: LocalLMConfig }
  | { tier: 'host'; host: HostLMConfig };

export function createInterpreter(config: InterpreterConfig): EngramInterpreter {
  switch (config.tier) {
    case 'regex':
      return new RegexInterpreter();
    case 'local':
      return new LocalLMInterpreter(config.local);
    case 'host':
      return new HostLMInterpreter(config.host);
  }
}
