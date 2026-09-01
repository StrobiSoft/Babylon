import { describe, expect, it } from 'vitest';
import { testConfig } from './helpers.js';
import { applySoftChatLoadServerEnvironment } from './soft-chat-load-server-config.js';

describe('Soft Chat separate-server configuration', () => {
  it('maps the explicit activity-write throttle flag into the child Config', () => {
    const config = testConfig('postgresql://unused');

    const proof = applySoftChatLoadServerEnvironment(config, {
      AUTH_ACTIVITY_WRITE_THROTTLE_ENABLED: '1',
    });

    expect(config.authActivityWriteThrottleEnabled).toBe(true);
    expect(proof).toEqual({ authActivityWriteThrottleEnabled: true });
  });

  it('keeps the default disabled and rejects non-strict flag values', () => {
    const config = testConfig('postgresql://unused');
    expect(applySoftChatLoadServerEnvironment(config, {})).toEqual({
      authActivityWriteThrottleEnabled: false,
    });
    expect(() =>
      applySoftChatLoadServerEnvironment(config, {
        AUTH_ACTIVITY_WRITE_THROTTLE_ENABLED: 'true',
      }),
    ).toThrow(/must be either 0 or 1/);
  });
});
