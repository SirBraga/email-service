import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env, isStorageEnabled } from "../config/env.js";
import { logger } from "../shared/logger.js";

let s3Client = null;
let storageInitialized = false;

function getS3Client() {
  if (!isStorageEnabled()) {
    if (!storageInitialized) {
      logger.info("Storage desabilitado (EMAIL_STORAGE_ENABLED=false)");
      storageInitialized = true;
    }
    return null;
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: env.EMAIL_STORAGE_REGION,
      endpoint: env.EMAIL_STORAGE_ENDPOINT,
      forcePathStyle: env.EMAIL_STORAGE_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.EMAIL_STORAGE_ACCESS_KEY_ID,
        secretAccessKey: env.EMAIL_STORAGE_SECRET_ACCESS_KEY,
      },
    });
    logger.info({
      endpoint: env.EMAIL_STORAGE_ENDPOINT,
      bucket: env.EMAIL_STORAGE_BUCKET,
      region: env.EMAIL_STORAGE_REGION,
    }, "Cliente S3 inicializado");
    storageInitialized = true;
  }

  return s3Client;
}

function normalizePathSegment(value, fallback) {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\w./-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || fallback;
}

function buildStorageKey({ mailbox, uid, storedFilename }) {
  const prefix = normalizePathSegment(env.EMAIL_STORAGE_PREFIX, "emails").replace(/^\/+|\/+$/g, "");
  const mailboxSegment = normalizePathSegment(mailbox, "INBOX");
  const fileSegment = normalizePathSegment(storedFilename, "attachment.bin");
  return `${prefix}/${mailboxSegment}/uid-${uid}/${fileSegment}`;
}

function buildStorageUrl(key) {
  if (env.EMAIL_STORAGE_PUBLIC_BASE_URL) {
    return `${env.EMAIL_STORAGE_PUBLIC_BASE_URL.replace(/\/+$/g, "")}/${key}`;
  }

  if (!env.EMAIL_STORAGE_ENDPOINT) {
    return null;
  }

  const endpoint = env.EMAIL_STORAGE_ENDPOINT.replace(/\/+$/g, "");
  if (env.EMAIL_STORAGE_FORCE_PATH_STYLE) {
    return `${endpoint}/${env.EMAIL_STORAGE_BUCKET}/${key}`;
  }

  const baseUrl = new URL(endpoint);
  return `${baseUrl.protocol}//${env.EMAIL_STORAGE_BUCKET}.${baseUrl.host}/${key}`;
}

export async function uploadAttachments({ mailbox, uid, attachments }) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  if (!isStorageEnabled()) {
    return attachments.map((attachment) => ({
      filename: attachment.filename,
      storedFilename: attachment.storedFilename,
      contentType: attachment.contentType,
      size: attachment.size,
      contentDisposition: attachment.contentDisposition,
      contentId: attachment.contentId,
      checksum: attachment.checksum,
      storageProvider: null,
      storageBucket: null,
      storageKey: null,
      storageUrl: null,
      storageEtag: null,
    }));
  }

  const client = getS3Client();
  const uploaded = [];

  for (const attachment of attachments) {
    const key = buildStorageKey({
      mailbox,
      uid,
      storedFilename: attachment.storedFilename,
    });

    const response = await client.send(
      new PutObjectCommand({
        Bucket: env.EMAIL_STORAGE_BUCKET,
        Key: key,
        Body: attachment.content,
        ContentType: attachment.contentType,
      }),
    );

    const uploadedAttachment = {
      filename: attachment.filename,
      storedFilename: attachment.storedFilename,
      contentType: attachment.contentType,
      size: attachment.size,
      contentDisposition: attachment.contentDisposition,
      contentId: attachment.contentId,
      checksum: attachment.checksum,
      storageProvider: "s3",
      storageBucket: env.EMAIL_STORAGE_BUCKET,
      storageKey: key,
      storageUrl: buildStorageUrl(key),
      storageEtag: response.ETag ? response.ETag.replaceAll('"', "") : null,
    };

    logger.info({
      filename: attachment.filename,
      size: attachment.size,
      bucket: env.EMAIL_STORAGE_BUCKET,
      key,
    }, "Anexo salvo no bucket");

    uploaded.push(uploadedAttachment);
  }

  return uploaded;
}
