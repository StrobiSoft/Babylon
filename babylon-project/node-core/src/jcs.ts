function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeString(value: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('string is not JSON serializable');
  }
  return serialized;
}

function canonicalize(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  switch (typeof value) {
    case 'string':
      return serializeString(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError('non-finite numbers are not valid JCS values');
      }
      const serialized = JSON.stringify(value);
      if (serialized === undefined) {
        throw new TypeError('number is not JSON serializable');
      }
      return serialized;
    }
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item)).join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new TypeError('only plain JSON objects can be canonicalized');
      }
      const symbolKeys = Object.getOwnPropertySymbols(value);
      if (symbolKeys.length > 0) {
        throw new TypeError('symbol keys are not valid JSON members');
      }
      const members = Object.keys(value)
        .sort()
        .map((key) => `${serializeString(key)}:${canonicalize(value[key])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`unsupported JCS value type: ${typeof value}`);
  }
}

/**
 * RFC 8785-style JSON canonicalization for already-parsed JSON values.
 * Duplicate object-member names must be rejected by the parser before this function is called.
 */
export function canonicalizeJcs(value: unknown): string {
  return canonicalize(value);
}
