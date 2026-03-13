import nodemailer from "nodemailer";
import { env, hasSmtpConfig } from "../config/env.js";

let transporter = null;

function getTransporter() {
  if (!hasSmtpConfig()) {
    throw new Error("Configuração SMTP incompleta");
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }

  return transporter;
}

export async function sendEmail(input) {
  const transport = getTransporter();

  return transport.sendMail({
    from: env.MAIL_FROM,
    to: input.to,
    cc: input.cc || undefined,
    bcc: input.bcc || undefined,
    replyTo: input.replyTo || undefined,
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: input.attachments || undefined,
  });
}

export async function verifySmtp() {
  const transport = getTransporter();
  await transport.verify();
}
