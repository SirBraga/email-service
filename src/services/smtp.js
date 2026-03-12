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
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}

export async function verifySmtp() {
  const transport = getTransporter();
  await transport.verify();
}
