(() => {
  'use strict';
  const status = document.querySelector('#status');
  const action = document.querySelector('#action');
  const operation = document.body.dataset.operation;
  const fragment = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname);

  const b64ToBytes = (value) => {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  };
  const bytesToB64 = (value) => {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const request = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || 'A művelet sikertelen.');
    return payload.data;
  };
  const serializeCredential = (credential) => ({
    id: credential.id,
    rawId: bytesToB64(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
    response:
      credential.response.attestationObject !== undefined
        ? {
            clientDataJSON: bytesToB64(credential.response.clientDataJSON),
            attestationObject: bytesToB64(credential.response.attestationObject),
            transports: credential.response.getTransports?.() || [],
          }
        : {
            clientDataJSON: bytesToB64(credential.response.clientDataJSON),
            authenticatorData: bytesToB64(credential.response.authenticatorData),
            signature: bytesToB64(credential.response.signature),
            userHandle: credential.response.userHandle ? bytesToB64(credential.response.userHandle) : undefined,
          },
  });
  const registrationOptions = (options) => ({
    ...options,
    challenge: b64ToBytes(options.challenge),
    user: { ...options.user, id: b64ToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((item) => ({ ...item, id: b64ToBytes(item.id) })),
  });
  const authenticationOptions = (options) => ({
    ...options,
    challenge: b64ToBytes(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((item) => ({ ...item, id: b64ToBytes(item.id) })),
  });

  const verifyEmail = async () => {
    const token = fragment.get('token');
    const transactionToken = fragment.get('transaction');
    const state = fragment.get('state');
    if (!token || !transactionToken || !state) throw new Error('Hiányzó ellenőrző tranzakció.');
    const result = await request('/api/v1/email-verification/confirm', { token, transactionToken, state });
    status.textContent = 'Az e-mail-cím rendben. A passkey létrehozása következik…';
    fragment.set('enrollment', result.enrollmentToken);
    return runPasskey();
  };
  const runPasskey = async () => {
    const transactionToken = fragment.get('transaction');
    const state = fragment.get('state');
    if (!transactionToken || !state) throw new Error('Hiányzó vagy lejárt hitelesítési tranzakció.');
    if (operation !== 'authenticate') {
      const enrollmentToken = fragment.get('enrollment');
      if (!enrollmentToken) throw new Error('Hiányzó beiratkozási jogosultság.');
      const setup = await request('/api/v1/passkeys/registration/options', {
        enrollmentToken,
        transactionToken,
        state,
      });
      const credential = await navigator.credentials.create({ publicKey: registrationOptions(setup.options) });
      if (!credential) throw new Error('A passkey létrehozása megszakadt.');
      const result = await request('/api/v1/passkeys/registration/verify', {
        ceremonyToken: setup.ceremonyToken,
        transactionToken,
        state,
        response: serializeCredential(credential),
      });
      location.replace(result.redirectUrl);
    } else {
      const setup = await request('/api/v1/passkeys/authentication/options', { transactionToken, state });
      const credential = await navigator.credentials.get({ publicKey: authenticationOptions(setup.options) });
      if (!credential) throw new Error('A belépés megszakadt.');
      const result = await request('/api/v1/passkeys/authentication/verify', {
        ceremonyToken: setup.ceremonyToken,
        transactionToken,
        state,
        response: serializeCredential(credential),
      });
      location.replace(result.redirectUrl);
    }
  };

  action.addEventListener('click', async () => {
    action.disabled = true;
    status.textContent = 'A biztonságos hitelesítés folyamatban…';
    try {
      await (operation === 'verify' ? verifyEmail() : runPasskey());
    } catch (error) {
      status.textContent = error.name === 'NotAllowedError' ? 'A művelet megszakadt.' : error.message;
      action.disabled = false;
    }
  });
  status.textContent = operation === 'verify' ? 'Készen áll az e-mail-cím ellenőrzésére.' : 'Készen áll a passkey műveletre.';
})();
