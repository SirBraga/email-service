import { isDatabaseEnabled } from "../config/env.js";
import { getPrismaClient } from "../shared/prisma.js";

function toDateOrNull(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSenderEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function persistEmail(emailRecord) {
  if (!isDatabaseEnabled()) {
    return { persisted: false, skipped: true, emailId: null };
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return { persisted: false, skipped: true, emailId: null };
  }

  const email = await prisma.emailMessage.upsert({
    where: {
      mailbox_uid: {
        mailbox: emailRecord.metadata.mailbox,
        uid: emailRecord.uid,
      },
    },
    create: {
      messageId: emailRecord.messageId,
      mailbox: emailRecord.metadata.mailbox,
      uid: emailRecord.uid,
      subject: emailRecord.subject,
      fromAddresses: emailRecord.from,
      toAddresses: emailRecord.to,
      ccAddresses: emailRecord.cc,
      bccAddresses: emailRecord.bcc,
      replyToAddresses: emailRecord.replyTo,
      sentAt: toDateOrNull(emailRecord.date),
      text: emailRecord.text,
      html: emailRecord.html,
      textPreview: emailRecord.textPreview,
      hasAttachments: emailRecord.hasAttachments,
      trigger: emailRecord.metadata.trigger,
      detectionMethod: emailRecord.metadata.detectionMethod,
      receivedAt: toDateOrNull(emailRecord.metadata.receivedAt),
      rawPayload: emailRecord,
    },
    update: {
      messageId: emailRecord.messageId,
      subject: emailRecord.subject,
      fromAddresses: emailRecord.from,
      toAddresses: emailRecord.to,
      ccAddresses: emailRecord.cc,
      bccAddresses: emailRecord.bcc,
      replyToAddresses: emailRecord.replyTo,
      sentAt: toDateOrNull(emailRecord.date),
      text: emailRecord.text,
      html: emailRecord.html,
      textPreview: emailRecord.textPreview,
      hasAttachments: emailRecord.hasAttachments,
      trigger: emailRecord.metadata.trigger,
      detectionMethod: emailRecord.metadata.detectionMethod,
      receivedAt: toDateOrNull(emailRecord.metadata.receivedAt),
      rawPayload: emailRecord,
    },
    select: {
      id: true,
    },
  });

  await prisma.emailAttachment.deleteMany({
    where: {
      emailId: email.id,
    },
  });

  if (emailRecord.attachments.length > 0) {
    await prisma.emailAttachment.createMany({
      data: emailRecord.attachments.map((attachment) => ({
        emailId: email.id,
        filename: attachment.filename ?? attachment.storedFilename,
        storedFilename: attachment.storedFilename,
        contentType: attachment.contentType ?? "application/octet-stream",
        size: Number(attachment.size ?? 0),
        contentDisposition: attachment.contentDisposition ?? null,
        contentId: attachment.contentId ?? null,
        checksum: attachment.checksum ?? null,
        localRelativePath: attachment.localRelativePath ?? attachment.relativePath ?? null,
        localAbsolutePath: attachment.localAbsolutePath ?? attachment.absolutePath ?? null,
        storageProvider: attachment.storageProvider ?? null,
        storageBucket: attachment.storageBucket ?? null,
        storageKey: attachment.storageKey ?? null,
        storageUrl: attachment.storageUrl ?? null,
        storageEtag: attachment.storageEtag ?? null,
      })),
    });
  }

  return { persisted: true, skipped: false, emailId: email.id };
}

export async function findExistingEmail(mailbox, uid) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return null;
  }

  return prisma.emailMessage.findUnique({
    where: {
      mailbox_uid: {
        mailbox,
        uid,
      },
    },
    include: {
      attachments: true,
    },
  });
}

export async function findLatestPersistedEmail(mailbox) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return null;
  }

  return prisma.emailMessage.findFirst({
    where: {
      mailbox,
    },
    orderBy: [
      { uid: "desc" },
      { receivedAt: "desc" },
    ],
    select: {
      id: true,
      uid: true,
      messageId: true,
      receivedAt: true,
      sentAt: true,
    },
  });
}

export async function registerDeletedEmail(email, deletedBy = {}) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma || !email) {
    return null;
  }

  const fromAddress = Array.isArray(email.fromAddresses) ? email.fromAddresses[0] : null;

  return prisma.emailDeletedMessage.upsert({
    where: {
      mailbox_uid: {
        mailbox: email.mailbox,
        uid: email.uid,
      },
    },
    create: {
      mailbox: email.mailbox,
      uid: email.uid,
      messageId: email.messageId ?? null,
      subject: email.subject ?? null,
      fromAddress: typeof fromAddress === "string" ? fromAddress : null,
      rawPayload: email.rawPayload,
      deletedByUserId: deletedBy.viewerId ?? null,
      deletedByUserName: deletedBy.viewerName ?? null,
      deletedByUserEmail: deletedBy.viewerEmail ?? null,
    },
    update: {
      messageId: email.messageId ?? null,
      subject: email.subject ?? null,
      fromAddress: typeof fromAddress === "string" ? fromAddress : null,
      rawPayload: email.rawPayload,
      deletedByUserId: deletedBy.viewerId ?? null,
      deletedByUserName: deletedBy.viewerName ?? null,
      deletedByUserEmail: deletedBy.viewerEmail ?? null,
      deletedAt: new Date(),
    },
  });
}

export async function findDeletedEmail(mailbox, uid) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return null;
  }

  return prisma.emailDeletedMessage.findUnique({
    where: {
      mailbox_uid: {
        mailbox,
        uid,
      },
    },
  });
}

export async function listDeletedEmails() {
  if (!isDatabaseEnabled()) {
    return [];
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return [];
  }

  return prisma.emailDeletedMessage.findMany({
    orderBy: {
      deletedAt: "desc",
    },
  });
}

export async function restoreDeletedEmail(id) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return null;
  }

  const deleted = await prisma.emailDeletedMessage.findUnique({
    where: { id },
  });

  if (!deleted) {
    throw new Error("Email excluído não encontrado");
  }

  await persistEmail(deleted.rawPayload);
  await prisma.emailDeletedMessage.delete({
    where: { id },
  });

  return deleted;
}

export async function listBlockedSenders() {
  if (!isDatabaseEnabled()) {
    return [];
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return [];
  }

  return prisma.emailBlockedSender.findMany({
    orderBy: {
      blockedAt: "desc",
    },
  });
}

export async function findBlockedSenderByEmail(email) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return null;
  }

  const normalizedEmail = normalizeSenderEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  return prisma.emailBlockedSender.findUnique({
    where: {
      normalizedEmail,
    },
  });
}

export async function blockSender(email, blockedBy = {}, reason = null) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return null;
  }

  const normalizedEmail = normalizeSenderEmail(email);
  if (!normalizedEmail) {
    throw new Error("Email do remetente inválido");
  }

  return prisma.emailBlockedSender.upsert({
    where: {
      normalizedEmail,
    },
    create: {
      email: email.trim(),
      normalizedEmail,
      reason: reason ?? null,
      blockedByUserId: blockedBy.viewerId ?? null,
      blockedByUserName: blockedBy.viewerName ?? null,
      blockedByUserEmail: blockedBy.viewerEmail ?? null,
    },
    update: {
      email: email.trim(),
      reason: reason ?? null,
      blockedByUserId: blockedBy.viewerId ?? null,
      blockedByUserName: blockedBy.viewerName ?? null,
      blockedByUserEmail: blockedBy.viewerEmail ?? null,
      blockedAt: new Date(),
    },
  });
}

export async function unblockSender(id) {
  if (!isDatabaseEnabled()) {
    return null;
  }

  const prisma = getPrismaClient();
  if (!prisma) {
    return null;
  }

  return prisma.emailBlockedSender.delete({
    where: { id },
  });
}
