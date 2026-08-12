import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleWebAuthnProvider } from '../src/webauthn.js';
import { authenticationResponse, registrationResponse, testConfig } from './helpers.js';

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

describe('SimpleWebAuthn security policy adapter', () => {
  const config = testConfig('postgresql://unused');
  const provider = new SimpleWebAuthnProvider(config);

  beforeEach(() => vi.clearAllMocks());

  it('requests a discoverable registration passkey with UV and no attestation', async () => {
    vi.mocked(generateRegistrationOptions).mockResolvedValue({ challenge: 'challenge' } as never);
    await provider.registrationOptions({
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'user@example.test',
      existingCredentialIds: ['existing'],
    });
    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'localhost',
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        excludeCredentials: [{ id: 'existing' }],
      }),
    );
  });

  it('pins challenge, origin, RP ID, algorithms, and UV for registration verification', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({
      verified: true,
      registrationInfo: {
        userVerified: true,
        credential: { id: 'credential', publicKey: new Uint8Array([1]), counter: 0 },
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    } as never);
    await expect(
      provider.verifyRegistration(registrationResponse, 'expected-challenge'),
    ).resolves.toMatchObject({
      credentialId: 'credential',
      counter: 0,
      deviceType: 'multiDevice',
      backedUp: true,
    });
    expect(verifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'expected-challenge',
        expectedOrigin: ['http://localhost:3000'],
        expectedRPID: 'localhost',
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      }),
    );
  });

  it('requests username-less authentication and pins all verifier inputs', async () => {
    vi.mocked(generateAuthenticationOptions).mockResolvedValue({ challenge: 'challenge' } as never);
    await provider.authenticationOptions();
    expect(generateAuthenticationOptions).toHaveBeenCalledWith({
      rpID: 'localhost',
      allowCredentials: [],
      userVerification: 'required',
    });

    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        userVerified: true,
        newCounter: 0,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: true,
      },
    } as never);
    const credential = { id: 'credential', publicKey: new Uint8Array([1]), counter: 0 };
    await provider.verifyAuthentication(authenticationResponse, 'expected-challenge', credential);
    expect(verifyAuthenticationResponse).toHaveBeenCalledWith({
      response: authenticationResponse,
      expectedChallenge: 'expected-challenge',
      expectedOrigin: ['http://localhost:3000'],
      expectedRPID: 'localhost',
      credential,
      requireUserVerification: true,
    });
  });

  it('rejects unverified and missing-user-verification library results', async () => {
    vi.mocked(verifyRegistrationResponse).mockResolvedValue({ verified: false } as never);
    await expect(provider.verifyRegistration(registrationResponse, 'challenge')).rejects.toThrow(
      /verification failed/,
    );
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: true,
      authenticationInfo: {
        userVerified: false,
        newCounter: 0,
        credentialDeviceType: 'multiDevice',
        credentialBackedUp: false,
      },
    } as never);
    await expect(
      provider.verifyAuthentication(authenticationResponse, 'challenge', {
        id: 'credential',
        publicKey: new Uint8Array([1]),
        counter: 0,
      }),
    ).rejects.toThrow(/verification failed/);
  });
});
