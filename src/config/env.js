import "dotenv/config";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável obrigatória ausente: ${name}`);
  }
  return value;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Número inválido: ${value}`);
  }
  return parsed;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? "development",
  LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
  IMAP_HOST: requireEnv("IMAP_HOST"),
  IMAP_PORT: parseNumber(process.env.IMAP_PORT, 993),
  IMAP_SECURE: parseBoolean(process.env.IMAP_SECURE, true),
  IMAP_USER: requireEnv("IMAP_USER"),
  IMAP_PASS: requireEnv("IMAP_PASS"),
  IMAP_MAILBOX: process.env.IMAP_MAILBOX ?? "INBOX",
  IMAP_MAX_IDLE_TIME_MS: parseNumber(process.env.IMAP_MAX_IDLE_TIME_MS, 240000),
  IMAP_RESYNC_INTERVAL_MS: parseNumber(process.env.IMAP_RESYNC_INTERVAL_MS, 300000),
  IMAP_RECONNECT_INITIAL_DELAY_MS: parseNumber(process.env.IMAP_RECONNECT_INITIAL_DELAY_MS, 2000),
  IMAP_RECONNECT_MAX_DELAY_MS: parseNumber(process.env.IMAP_RECONNECT_MAX_DELAY_MS, 60000),
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: parseNumber(process.env.SMTP_PORT, 465),
  SMTP_SECURE: parseBoolean(process.env.SMTP_SECURE, true),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  MAIL_FROM: process.env.MAIL_FROM,
};

export function hasSmtpConfig() {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM);
}
