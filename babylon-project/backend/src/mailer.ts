import nodemailer from 'nodemailer';
import type { Config } from './config.js';
import type { Mailer, MailMessage } from './types.js';

export class SmtpMailer implements Mailer {
  private readonly transport;

  constructor(private readonly config: Config) {
    this.transport = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.emailFrom,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
