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
  DATABASE_URL: process.env.DATABASE_URL ?? "",
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
  EMAIL_ATTACHMENTS_DIR: process.env.EMAIL_ATTACHMENTS_DIR ?? "data/attachments",
  EMAIL_DATABASE_ENABLED: parseBoolean(process.env.EMAIL_DATABASE_ENABLED, true),
  EMAIL_STORAGE_ENABLED: parseBoolean(process.env.EMAIL_STORAGE_ENABLED, false),
  EMAIL_STORAGE_ENDPOINT: process.env.EMAIL_STORAGE_ENDPOINT ?? "",
  EMAIL_STORAGE_REGION: process.env.EMAIL_STORAGE_REGION ?? "us-east-1",
  EMAIL_STORAGE_BUCKET: process.env.EMAIL_STORAGE_BUCKET ?? "",
  EMAIL_STORAGE_ACCESS_KEY_ID: process.env.EMAIL_STORAGE_ACCESS_KEY_ID ?? "",
  EMAIL_STORAGE_SECRET_ACCESS_KEY: process.env.EMAIL_STORAGE_SECRET_ACCESS_KEY ?? "",
  EMAIL_STORAGE_FORCE_PATH_STYLE: parseBoolean(process.env.EMAIL_STORAGE_FORCE_PATH_STYLE, true),
  EMAIL_STORAGE_PUBLIC_BASE_URL: process.env.EMAIL_STORAGE_PUBLIC_BASE_URL ?? "",
  EMAIL_STORAGE_PREFIX: process.env.EMAIL_STORAGE_PREFIX ?? "emails",
  EMAIL_WEBHOOK_URL: process.env.EMAIL_WEBHOOK_URL ?? "",
  EMAIL_WEBHOOK_BEARER_TOKEN: process.env.EMAIL_WEBHOOK_BEARER_TOKEN ?? "",
  EMAIL_WEBHOOK_TIMEOUT_MS: parseNumber(process.env.EMAIL_WEBHOOK_TIMEOUT_MS, 10000),
  EMAIL_WEBHOOK_MAX_RETRIES: parseNumber(process.env.EMAIL_WEBHOOK_MAX_RETRIES, 3),
  EMAIL_WEBHOOK_RETRY_DELAY_MS: parseNumber(process.env.EMAIL_WEBHOOK_RETRY_DELAY_MS, 1500),
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

export function isDatabaseEnabled() {
  return Boolean(env.EMAIL_DATABASE_ENABLED && env.DATABASE_URL);
}

export function isStorageEnabled() {
  return Boolean(
    env.EMAIL_STORAGE_ENABLED &&
      env.EMAIL_STORAGE_ENDPOINT &&
      env.EMAIL_STORAGE_BUCKET &&
      env.EMAIL_STORAGE_ACCESS_KEY_ID &&
      env.EMAIL_STORAGE_SECRET_ACCESS_KEY,
  );
}
