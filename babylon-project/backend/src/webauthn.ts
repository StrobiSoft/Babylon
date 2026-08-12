import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  WebAuthnCredential,
} from '@simplewebauthn/server';
import type { Config } from './config.js';

export interface RegistrationVerification {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
}

export interface AuthenticationVerification {
  newCounter: number;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
}

export interface WebAuthnProvider {
  registrationOptions(input: {
    userId: string;
    email: string;
    existingCredentialIds: string[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON>;
  verifyRegistration(
    response: RegistrationResponseJSON,
    challenge: string,
  ): Promise<RegistrationVerification>;
  authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON>;
  verifyAuthentication(
    response: AuthenticationResponseJSON,
    challenge: string,
    credential: WebAuthnCredential,
  ): Promise<AuthenticationVerification>;
}

export class SimpleWebAuthnProvider implements WebAuthnProvider {
  constructor(private readonly config: Config) {}

  registrationOptions(input: {
    userId: string;
    email: string;
    existingCredentialIds: string[];
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return generateRegistrationOptions({
      rpName: 'Babylon',
      rpID: this.config.webauthnRpId,
      userID: new TextEncoder().encode(input.userId),
      userName: input.email,
      userDisplayName: input.email,
      attestationType: 'none',
      excludeCredentials: input.existingCredentialIds.map((id) => ({ id })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      supportedAlgorithmIDs: [-7, -257],
    });
  }

  async verifyRegistration(
    response: RegistrationResponseJSON,
    challenge: string,
  ): Promise<RegistrationVerification> {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.webauthnOrigins,
      expectedRPID: this.config.webauthnRpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
    if (!result.verified) {
      throw new Error('WebAuthn registration verification failed');
    }
    const info = result.registrationInfo;
    if (!info.userVerified) throw new Error('WebAuthn registration verification failed');
    return {
      credentialId: info.credential.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: response.response.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    };
  }

  authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({
      rpID: this.config.webauthnRpId,
      allowCredentials: [],
      userVerification: 'required',
    });
  }

  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    challenge: string,
    credential: WebAuthnCredential,
  ): Promise<AuthenticationVerification> {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.webauthnOrigins,
      expectedRPID: this.config.webauthnRpId,
      credential,
      requireUserVerification: true,
    });
    if (!result.verified || !result.authenticationInfo.userVerified) {
      throw new Error('WebAuthn authentication verification failed');
    }
    return {
      newCounter: result.authenticationInfo.newCounter,
      deviceType: result.authenticationInfo.credentialDeviceType,
      backedUp: result.authenticationInfo.credentialBackedUp,
    };
  }
}
