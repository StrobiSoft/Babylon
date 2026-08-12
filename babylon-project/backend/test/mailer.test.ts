import { createServer } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../src/mailer.js';
import { testConfig } from './helpers.js';

describe('local SMTP delivery', () => {
  let server: SMTPServer | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('delivers a Hungarian verification message to the local recipient', async () => {
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        if (!address || typeof address === 'string') return reject(new Error('No test port'));
        probe.close(() => resolve(address.port));
      });
    });
    let delivered = '';
    let recipient = '';
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS'],
      onData(stream, _session, callback) {
        stream.on('data', (chunk: Buffer) => (delivered += chunk.toString('utf8')));
        stream.on('end', () => callback());
      },
      onRcptTo(address, _session, callback) {
        recipient = address.address;
        callback();
      },
    });
    await new Promise<void>((resolve, reject) => {
      server?.once('error', reject);
      server?.listen(port, '127.0.0.1', () => resolve());
    });
    const config = testConfig('postgresql://unused');
    config.smtpPort = port;
    const mailer = new SmtpMailer(config);
    await mailer.send({
      to: 'user@example.test',
      subject: 'Babylon e-mail ellenőrzés',
      text: 'Erősítsd meg az e-mail-címedet: http://localhost:3000/verify-email#token=secret',
    });
    expect(recipient).toBe('user@example.test');
    expect(delivered).toContain('Subject: =?UTF-8?Q?Babylon');
    const decoded = delivered.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    expect(decoded).toContain('/verify-email#token=secret');
  });
});
