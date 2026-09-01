import type { Config } from '../src/config.js';

export interface SoftChatLoadServerConfigProof {
  authActivityWriteThrottleEnabled: boolean;
}

export function applySoftChatLoadServerEnvironment(
  config: Pick<Config, 'authActivityWriteThrottleEnabled'>,
  environment: NodeJS.ProcessEnv,
): SoftChatLoadServerConfigProof {
  const rawFlag = environment.AUTH_ACTIVITY_WRITE_THROTTLE_ENABLED ?? '0';
  if (rawFlag !== '0' && rawFlag !== '1') {
    throw new Error('AUTH_ACTIVITY_WRITE_THROTTLE_ENABLED must be either 0 or 1.');
  }
  config.authActivityWriteThrottleEnabled = rawFlag === '1';
  return {
    authActivityWriteThrottleEnabled: config.authActivityWriteThrottleEnabled,
  };
}
