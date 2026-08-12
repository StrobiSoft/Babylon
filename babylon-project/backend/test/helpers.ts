import { createHash } from 'node:crypto';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import type { Config } from '../src/config.js';
import { pkceChallenge } from '../src/crypto.js';
import type { Mailer, MailMessage, RandomSource } from '../src/types.js';
import type {
  AuthenticationVerification,
  RegistrationVerification,
  WebAuthnProvider,
} from '../src/webauthn.js';

export class FakeClock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export class DeterministicRandom implements RandomSource {
  private counter = 0;
  token(): string {
    this.counter += 1;
    return createHash('sha256').update(`token-${this.counter}`).digest('base64url');
  }
  uuid(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${this.counter.toString().padStart(12, '0')}`;
  }
}

export class MemoryMailer implements Mailer {
  messages: MailMessage[] = [];
  fail = false;
  async send(message: MailMessage): Promise<void> {
    if (this.fail) throw new Error('SMTP unavailable');
    this.messages.push(message);
  }
  lastToken(): string {
    const text = this.messages.at(-1)?.text ?? '';
    const match = /https?:\/\/[^\s]+/.exec(text);
    if (!match?.[0]) throw new Error('No link in last message');
    const fragment = new URLSearchParams(new URL(match[0]).hash.slice(1));
    const value = fragment.get('token') ?? fragment.get('enrollment');
    if (!value) throw new Error('No token in last message');
    return value;
  }
}

export class FakeWebAuthn implements WebAuthnProvider {
  rejectRegistration = false;
  rejectAuthentication = false;
  failureReason = 'invalid';
  registrationResult: RegistrationVerification = {
    credentialId: 'credential-1',
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ['internal'],
    deviceType: 'multiDevice',
    backedUp: true,
  };
  authenticationResult: AuthenticationVerification = {
    newCounter: 0,
    deviceType: 'multiDevice',
    backedUp: true,
  };

  async registrationOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return {
      challenge: 'registration-challenge',
      rp: { name: 'Babylon', id: 'localhost' },
      user: { id: 'dXNlcg', name: 'user@example.test', displayName: 'user@example.test' },
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
      timeout: 60_000,
      attestation: 'none',
      excludeCredentials: [],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: {},
      hints: [],
    };
  }
  async verifyRegistration(
    _response: RegistrationResponseJSON,
    challenge: string,
  ): Promise<RegistrationVerification> {
    if (this.rejectRegistration || challenge !== 'registration-challenge')
      throw new Error(this.failureReason);
    return this.registrationResult;
  }
  async authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return {
      challenge: 'authentication-challenge',
      timeout: 60_000,
      rpId: 'localhost',
      allowCredentials: [],
      userVerification: 'required',
      extensions: {},
      hints: [],
    };
  }
  async verifyAuthentication(
    _response: AuthenticationResponseJSON,
    challenge: string,
    _credential: WebAuthnCredential,
  ): Promise<AuthenticationVerification> {
    void _credential;
    if (this.rejectAuthentication || challenge !== 'authentication-challenge')
      throw new Error(this.failureReason);
    return this.authenticationResult;
  }
}

export function testConfig(databaseUrl: string): Config {
  return {
    databaseUrl,
    httpHost: '127.0.0.1',
    httpPort: 0,
    publicBackendUrl: 'http://localhost:3000',
    webauthnRpId: 'localhost',
    webauthnOrigins: ['http://localhost:3000'],
    accessTokenTtlSeconds: 60,
    refreshTokenTtlSeconds: 3600,
    invitationTtlSeconds: 600,
    emailTokenTtlSeconds: 300,
    enrollmentTtlSeconds: 300,
    challengeTtlSeconds: 120,
    nativeTransactionTtlSeconds: 300,
    returnCodeTtlSeconds: 60,
    adminBootstrapToken: 'admin-token-that-is-at-least-32-characters-long',
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    emailFrom: 'Babylon <no-reply@babylon.test>',
    logLevel: 'silent',
    allowedClientOrigins: ['http://localhost:4200'],
    returnProfiles: {
      'desktop-local': {
        clientId: 'babylon-flutter',
        uri: 'http://127.0.0.1:43821/callback',
        development: true,
      },
    },
    cleanupIntervalSeconds: 300,
    production: false,
  };
}

export const verifier = 'a'.repeat(64);
export const state = 's'.repeat(43);
export const pkce = pkceChallenge(verifier);

export const registrationResponse = {
  id: 'credential-1',
  rawId: 'Y3JlZGVudGlhbC0x',
  type: 'public-key',
  response: { clientDataJSON: 'AA', attestationObject: 'AA', transports: ['internal'] },
  clientExtensionResults: {},
} as RegistrationResponseJSON;

export const authenticationResponse = {
  id: 'credential-1',
  rawId: 'Y3JlZGVudGlhbC0x',
  type: 'public-key',
  response: { clientDataJSON: 'AA', authenticatorData: 'AA', signature: 'AA' },
  clientExtensionResults: {},
} as AuthenticationResponseJSON;
