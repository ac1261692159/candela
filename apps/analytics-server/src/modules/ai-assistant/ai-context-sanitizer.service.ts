import { Injectable } from '@nestjs/common';

const MAX_CONTEXT_BYTES = 128 * 1024;
const MAX_ARRAY_ITEMS = 100;
const MAX_CELL_CHARS = 2_000;
const MAX_QUERY_CHARS = 32 * 1024;
const MAX_DEPTH = 8;
const OMIT = Symbol('omit-sensitive-value');

const SENSITIVE_KEY = /(?:^|_)(?:project|project_name|distinct_id|user_key|device_id|authorization|auth_token|access_token|refresh_token|token|password|passwd|secret|api_key|apikey|cookie)(?:$|_)/i;
const QUERY_KEY = /^(?:sql|dsl|query|statement)$/i;

export interface SanitizedAiContext {
  value: Record<string, unknown>;
  truncated: boolean;
}

@Injectable()
export class AiContextSanitizerService {
  sanitize(input?: Record<string, unknown>): SanitizedAiContext {
    if (!input) return { value: {}, truncated: false };

    const state = { truncated: false };
    const sanitized = this.walk(input, state, 0) as Record<string, unknown>;
    let value = sanitized;

    if (this.byteLength(value) > MAX_CONTEXT_BYTES && 'result' in value) {
      value = {
        ...value,
        result: {
          _truncated: true,
          reason: 'context_size_limit',
        },
      };
      state.truncated = true;
    }

    if (this.byteLength(value) > MAX_CONTEXT_BYTES && 'analysis' in value) {
      value = {
        page: value.page,
        route: value.route,
        analysis: this.walk(value.analysis, state, 0, 20, 2_000),
        result: value.result,
        _truncated: true,
      };
      state.truncated = true;
    }

    if (this.byteLength(value) > MAX_CONTEXT_BYTES) {
      value = {
        page: value.page,
        route: value.route,
        _truncated: true,
        reason: 'context_size_limit',
      };
      state.truncated = true;
    } else if (state.truncated) {
      value = { ...value, _truncated: true };
    }

    return { value, truncated: state.truncated };
  }

  sanitizeText(value: string, maxChars = 4_000): string {
    const masked = this.maskSensitiveValues(value);
    return masked.length > maxChars ? `${masked.slice(0, maxChars)}…[truncated]` : masked;
  }

  private walk(
    value: unknown,
    state: { truncated: boolean },
    depth: number,
    arrayLimit = MAX_ARRAY_ITEMS,
    stringLimit = MAX_CELL_CHARS,
    parentKey = '',
  ): unknown {
    if (depth > MAX_DEPTH) {
      state.truncated = true;
      return '[depth limit]';
    }

    if (typeof value === 'string') {
      const limit = QUERY_KEY.test(parentKey) ? MAX_QUERY_CHARS : stringLimit;
      const masked = this.maskSensitiveValues(value);
      if (masked.length > limit) {
        state.truncated = true;
        return `${masked.slice(0, limit)}…[truncated]`;
      }
      return masked;
    }

    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      const items = value
        .slice(0, arrayLimit)
        .map((item) => this.walk(item, state, depth + 1, arrayLimit, stringLimit));
      if (value.length > arrayLimit) {
        state.truncated = true;
        items.push({ _truncated_items: value.length - arrayLimit });
      }
      return items;
    }

    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
        if (SENSITIVE_KEY.test(normalizedKey)) {
          state.truncated = true;
          continue;
        }
        const sanitized = this.walk(
          child,
          state,
          depth + 1,
          arrayLimit,
          stringLimit,
          key,
        );
        if (sanitized !== OMIT) result[key] = sanitized;
      }
      return result;
    }

    state.truncated = true;
    return OMIT;
  }

  private maskSensitiveValues(value: string): string {
    return value
      .replace(/\b1[3-9]\d{9}\b/g, (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`)
      .replace(/\b([A-Z0-9._%+-])[^\s@]*@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi, '$1***@$2')
      .replace(/\b\d{17}[\dXx]\b/g, (id) => `${id.slice(0, 3)}***********${id.slice(-4)}`);
  }

  private byteLength(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }
}
