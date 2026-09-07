function isPlainObject(value: object): value is Record<string, unknown> {
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

function serializeString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) {
        throw new TypeError('lone surrogate is not valid Unicode/JCS input');
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('lone surrogate is not valid Unicode/JCS input');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('lone surrogate is not valid Unicode/JCS input');
    }
  }
  return JSON.stringify(value);
}

function assertDataProperty(object: object, key: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw new TypeError('JCS input must contain only enumerable data properties');
  }
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
      return JSON.stringify(value);
    }
    case 'object': {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          throw new TypeError('only ordinary JSON arrays can be canonicalized');
        }
        const ownKeys = Reflect.ownKeys(value);
        if (ownKeys.length !== value.length + 1 || ownKeys.some((key) => typeof key === 'symbol')) {
          throw new TypeError('sparse arrays and extra array properties are not valid JCS input');
        }
        const items: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const key = String(index);
          if (!Object.hasOwn(value, key)) {
            throw new TypeError('sparse arrays are not valid JCS input');
          }
          assertDataProperty(value, key);
          items.push(canonicalize(value[index]));
        }
        return `[${items.join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new TypeError('only plain JSON objects can be canonicalized');
      }
      const symbolKeys = Object.getOwnPropertySymbols(value);
      if (symbolKeys.length > 0) {
        throw new TypeError('symbol keys are not valid JSON members');
      }
      const keys = Object.keys(value);
      if (Reflect.ownKeys(value).length !== keys.length) {
        throw new TypeError('non-enumerable properties are not valid JSON members');
      }
      const members = keys.sort().map((key) => {
        assertDataProperty(value, key);
        return `${serializeString(key)}:${canonicalize(value[key])}`;
      });
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`unsupported JCS value type: ${typeof value}`);
  }
}

/**
 * RFC 8785 JSON canonicalization for already-parsed I-JSON values.
 * Duplicate object-member names must be rejected by the parser before this function is called.
 */
export function canonicalizeJcs(value: unknown): string {
  return canonicalize(value);
}
