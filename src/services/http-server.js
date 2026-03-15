import { createServer } from "node:http";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { getPrismaClient } from "../shared/prisma.js";
import {
  blockSender,
  getNextMailboxUid,
  listBlockedSenders,
  listDeletedEmails,
  persistEmail,
  registerDeletedEmail,
  restoreDeletedEmail,
  unblockSender,
} from "./email-repository.js";
import { prepareAttachments } from "./message-store.js";
import { sendEmail } from "./smtp.js";
import { readAttachmentContent, removeStoredAttachments, uploadAttachments } from "./storage-service.js";

const log = logger.child({ scope: "http-server" });

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseQuery(url) {
  const queryString = url.split("?")[1] || "";
  const params = new URLSearchParams(queryString);
  return Object.fromEntries(params.entries());
}

function getEmailDate(email) {
  return email.sentAt ? email.sentAt.toISOString() : null;
}

function getReceivedAt(email) {
  return email.receivedAt ? email.receivedAt.toISOString() : null;
}

function normalizeViewer(body) {
  if (!body || typeof body !== "object") {
    return { viewerId: null, viewerName: null, viewerEmail: null };
  }

  return {
    viewerId: typeof body.viewerId === "string" ? body.viewerId : null,
    viewerName: typeof body.viewerName === "string" ? body.viewerName : null,
    viewerEmail: typeof body.viewerEmail === "string" ? body.viewerEmail : null,
  };
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function classifyMailbox(mailbox) {
  if (env.IMAP_SENT_MAILBOXES.includes(mailbox)) return "sent";
  if (env.IMAP_SPAM_MAILBOXES.includes(mailbox)) return "spam";
  return "inbox";
}

function normalizeSenderEmail(value) {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim().toLowerCase();
  const bracketMatch = trimmed.match(/<([^>]+)>/);
  if (bracketMatch?.[1]) {
    return bracketMatch[1].trim();
  }

  const emailMatch = trimmed.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return emailMatch?.[0] ?? trimmed;
}

function parseBooleanQuery(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "sim"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "nao", "não"].includes(normalized)) {
    return false;
  }

  return null;
}

function resolveEmailFilters(query) {
  const filter = typeof query.filter === "string" ? query.filter.trim().toLowerCase() : "";
  const read = typeof query.read === "string" ? query.read.trim().toLowerCase() : "";
  const isRead = parseBooleanQuery(query.isRead);
  const hasAttachments = parseBooleanQuery(query.hasAttachments);
  const blocked = parseBooleanQuery(query.blocked);

  const filters = {
    isRead: isRead,
    hasAttachments,
    blocked,
  };

  if (filter === "unread" || read === "unread") {
    filters.isRead = false;
  } else if (filter === "read" || read === "read") {
    filters.isRead = true;
  }

  if (filter === "attachments") {
    filters.hasAttachments = true;
  }

  if (filter === "blocked") {
    filters.blocked = true;
  }

  return filters;
}

function mapBlockedSender(item) {
  return {
    id: item.id,
    email: item.email,
    normalizedEmail: item.normalizedEmail,
    reason: item.reason,
    blockedByUserId: item.blockedByUserId,
    blockedByUserName: item.blockedByUserName,
    blockedByUserEmail: item.blockedByUserEmail,
    blockedAt: item.blockedAt ? item.blockedAt.toISOString() : null,
    createdAt: item.createdAt ? item.createdAt.toISOString() : null,
    updatedAt: item.updatedAt ? item.updatedAt.toISOString() : null,
  };
}

function mapDeletedEmail(item) {
  return {
    id: item.id,
    mailbox: item.mailbox,
    uid: item.uid,
    messageId: item.messageId,
    subject: item.subject,
    fromAddress: item.fromAddress,
    deletedByUserId: item.deletedByUserId,
    deletedByUserName: item.deletedByUserName,
    deletedByUserEmail: item.deletedByUserEmail,
    deletedAt: item.deletedAt ? item.deletedAt.toISOString() : null,
  };
}

async function handleRequest(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url || "/";
  const path = url.split("?")[0];
  const method = req.method || "GET";

  try {
    if (path === "/health" && method === "GET") {
      return sendJson(res, 200, { status: "ok", timestamp: new Date().toISOString() });
    }

    if (path === "/api/emails" && method === "GET") {
      return await handleListEmails(req, res);
    }

    if (path.startsWith("/api/emails/") && method === "GET") {
      const id = path.replace("/api/emails/", "");
      return await handleGetEmail(req, res, id);
    }

    if (path.match(/^\/api\/emails\/[^/]+\/read$/) && method === "POST") {
      const id = path.replace("/api/emails/", "").replace("/read", "");
      return await handleMarkEmailRead(req, res, id);
    }

    if (path.match(/^\/api\/emails\/[^/]+\/unread$/) && method === "POST") {
      const id = path.replace("/api/emails/", "").replace("/unread", "");
      return await handleMarkEmailUnread(req, res, id);
    }

    if (path.match(/^\/api\/emails\/[^/]+$/) && method === "DELETE") {
      const id = path.replace("/api/emails/", "");
      return await handleDeleteEmail(req, res, id);
    }

    if (path.match(/^\/api\/attachments\/[^/]+\/download$/) && method === "GET") {
      const id = path.replace("/api/attachments/", "").replace("/download", "");
      return await handleDownloadAttachment(req, res, id);
    }

    if (path === "/api/blocked-senders" && method === "GET") {
      return await handleListBlockedSenders(req, res);
    }

    if (path === "/api/blocked-senders" && method === "POST") {
      return await handleBlockSender(req, res);
    }

    if (path === "/api/deleted-emails" && method === "GET") {
      return await handleListDeletedEmails(req, res);
    }

    if (path.match(/^\/api\/deleted-emails\/[^/]+\/restore$/) && method === "POST") {
      const id = path.replace("/api/deleted-emails/", "").replace("/restore", "");
      return await handleRestoreDeletedEmail(req, res, id);
    }

    if (path.match(/^\/api\/blocked-senders\/[^/]+$/) && method === "DELETE") {
      const id = path.replace("/api/blocked-senders/", "");
      return await handleUnblockSender(req, res, id);
    }

    if (path === "/api/emails/send" && method === "POST") {
      return await handleSendEmail(req, res);
    }

    if (path === "/api/stats" && method === "GET") {
      return await handleGetStats(req, res);
    }

    if (path === "/api/webhooks/register" && method === "POST") {
      return await handleRegisterWebhook(req, res);
    }

    if (path === "/api/webhooks/unregister" && method === "POST") {
      return await handleUnregisterWebhook(req, res);
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    log.error({ error: error.message, path, method }, "Erro na requisição HTTP");
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
}

async function handleListEmails(req, res) {
  const prisma = getPrismaClient();
  if (!prisma) {
    return sendJson(res, 503, { error: "Database not available" });
  }

  const query = parseQuery(req.url || "");
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20));
  const skip = (page - 1) * limit;
  const search = query.search || "";
  const mailbox = query.mailbox || "";
  const mailboxType = query.mailboxType || "";
  const filters = resolveEmailFilters(query);
  const isSentWindow = mailboxType === "sent" && !mailbox;

  const where = {};

  if (search) {
    where.OR = [
      { subject: { contains: search, mode: "insensitive" } },
      { fromAddresses: { array_contains: search } },
    ];
  }

  if (mailbox) {
    where.mailbox = mailbox;
  } else if (mailboxType) {
    const mailboxCandidates =
      mailboxType === "sent"
        ? env.IMAP_SENT_MAILBOXES
        : mailboxType === "spam"
          ? env.IMAP_SPAM_MAILBOXES
          : env.IMAP_MAILBOXES;

    where.mailbox = {
      in: mailboxCandidates.length > 0 ? mailboxCandidates : [env.IMAP_MAILBOX],
    };
  }

  if (typeof filters.isRead === "boolean") {
    where.isRead = filters.isRead;
  }

  if (typeof filters.hasAttachments === "boolean") {
    where.hasAttachments = filters.hasAttachments;
  }

  let sentWindowIds = null;
  let blockedSenderMap = new Map();

  if (isSentWindow) {
    const sentWindow = await prisma.emailMessage.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      take: 50,
      select: { id: true },
    });
    sentWindowIds = sentWindow.map((email) => email.id);
  }

  if (filters.blocked !== false) {
    const blockedSenders = await prisma.emailBlockedSender.findMany({
      select: {
        id: true,
        email: true,
        normalizedEmail: true,
      },
    });
    blockedSenderMap = new Map(blockedSenders.map((sender) => [sender.normalizedEmail, sender]));
  }

  const effectiveWhere = sentWindowIds
    ? {
        ...where,
        id: {
          in: sentWindowIds.length > 0 ? sentWindowIds : ["__no-sent-emails__"],
        },
      }
    : where;

  const shouldFilterByBlocked = typeof filters.blocked === "boolean";
  const fetchLimit = shouldFilterByBlocked ? Math.max(limit * 5, limit) : limit;
  const [emails, total] = await Promise.all([
    prisma.emailMessage.findMany({
      where: effectiveWhere,
      orderBy: { receivedAt: "desc" },
      skip: shouldFilterByBlocked ? 0 : skip,
      take: shouldFilterByBlocked ? Math.max(skip + fetchLimit, fetchLimit) : limit,
      include: {
        attachments: {
          select: {
            id: true,
            filename: true,
            contentType: true,
            size: true,
            storageUrl: true,
          },
        },
      },
    }),
    prisma.emailMessage.count({ where: effectiveWhere }),
  ]);

  const decoratedEmails = emails.map((email) => {
    const fromAddress = Array.isArray(email.fromAddresses) ? email.fromAddresses[0] : null;
    const normalizedSender = normalizeSenderEmail(fromAddress);
    const blockedSender = normalizedSender ? blockedSenderMap.get(normalizedSender) ?? null : null;

    return {
      ...email,
      blockedSender,
      isBlocked: Boolean(blockedSender),
    };
  });

  const filteredEmails = shouldFilterByBlocked
    ? decoratedEmails.filter((email) => email.isBlocked === filters.blocked)
    : decoratedEmails;
  const paginatedEmails = shouldFilterByBlocked ? filteredEmails.slice(skip, skip + limit) : filteredEmails;
  const effectiveTotal = shouldFilterByBlocked ? filteredEmails.length : total;

  const formatted = paginatedEmails.map((email) => ({
    id: email.id,
    messageId: email.messageId,
    uid: email.uid,
    mailbox: email.mailbox,
    mailboxType: classifyMailbox(email.mailbox),
    subject: email.subject,
    from: email.fromAddresses,
    to: email.toAddresses,
    cc: email.ccAddresses,
    date: getEmailDate(email),
    receivedAt: getReceivedAt(email),
    hasAttachments: email.hasAttachments,
    isRead: email.isRead,
    isBlocked: email.isBlocked,
    blockedSenderId: email.blockedSender?.id ?? null,
    blockedSenderEmail: email.blockedSender?.email ?? null,
    readAt: email.readAt ? email.readAt.toISOString() : null,
    readByUserName: email.readByUserName,
    attachmentCount: email.attachments.length,
    preview: email.textPreview ? email.textPreview.substring(0, 200) : (email.text ? email.text.substring(0, 200) : null),
  }));

  sendJson(res, 200, {
    emails: formatted,
    pagination: {
      page,
      limit,
      total: effectiveTotal,
      totalPages: Math.ceil(effectiveTotal / limit),
    },
  });
}

async function handleGetEmail(req, res, id) {
  const prisma = getPrismaClient();
  if (!prisma) {
    return sendJson(res, 503, { error: "Database not available" });
  }

  const email = await prisma.emailMessage.findUnique({
    where: { id },
    include: {
      attachments: true,
      viewEvents: {
        orderBy: {
          viewedAt: "desc",
        },
      },
    },
  });

  if (!email) {
    return sendJson(res, 404, { error: "Email not found" });
  }

  const fromAddress = Array.isArray(email.fromAddresses) ? email.fromAddresses[0] : null;
  const normalizedSender = normalizeSenderEmail(fromAddress);
  const blockedSender = normalizedSender
    ? await prisma.emailBlockedSender.findUnique({
        where: {
          normalizedEmail: normalizedSender,
        },
      })
    : null;

  sendJson(res, 200, {
    id: email.id,
    messageId: email.messageId,
    uid: email.uid,
    mailbox: email.mailbox,
    mailboxType: classifyMailbox(email.mailbox),
    subject: email.subject,
    from: email.fromAddresses,
    to: email.toAddresses,
    cc: email.ccAddresses,
    bcc: email.bccAddresses,
    replyTo: email.replyToAddresses,
    date: getEmailDate(email),
    receivedAt: getReceivedAt(email),
    textBody: email.text,
    htmlBody: email.html,
    hasAttachments: email.hasAttachments,
    isRead: email.isRead,
    isBlocked: Boolean(blockedSender),
    blockedSenderId: blockedSender?.id ?? null,
    blockedSenderEmail: blockedSender?.email ?? null,
    readAt: email.readAt ? email.readAt.toISOString() : null,
    readByUserId: email.readByUserId,
    readByUserName: email.readByUserName,
    readByUserEmail: email.readByUserEmail,
    attachments: email.attachments.map((att) => ({
      id: att.id,
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      storageUrl: att.storageUrl,
    })),
    metadata: email.rawPayload,
    viewEvents: email.viewEvents.map((event) => ({
      id: event.id,
      viewerId: event.viewerId,
      viewerName: event.viewerName,
      viewerEmail: event.viewerEmail,
      viewedAt: event.viewedAt.toISOString(),
    })),
  });
}

async function handleMarkEmailRead(req, res, id) {
  const prisma = getPrismaClient();
  if (!prisma) {
    return sendJson(res, 503, { error: "Database not available" });
  }

  const body = await parseBody(req);
  const { viewerId, viewerName, viewerEmail } = normalizeViewer(body);
  const now = new Date();

  const email = await prisma.emailMessage.update({
    where: { id },
    data: {
      isRead: true,
      readAt: now,
      readByUserId: viewerId,
      readByUserName: viewerName,
      readByUserEmail: viewerEmail,
      viewEvents: {
        create: {
          viewerId,
          viewerName,
          viewerEmail,
          viewedAt: now,
        },
      },
    },
    include: {
      viewEvents: {
        orderBy: {
          viewedAt: "desc",
        },
      },
    },
  });

  sendJson(res, 200, {
    success: true,
    email: {
      id: email.id,
      isRead: email.isRead,
      readAt: email.readAt ? email.readAt.toISOString() : null,
      readByUserId: email.readByUserId,
      readByUserName: email.readByUserName,
      readByUserEmail: email.readByUserEmail,
      viewEvents: email.viewEvents.map((event) => ({
        id: event.id,
        viewerId: event.viewerId,
        viewerName: event.viewerName,
        viewerEmail: event.viewerEmail,
        viewedAt: event.viewedAt.toISOString(),
      })),
    },
  });
}

async function handleMarkEmailUnread(req, res, id) {
  const prisma = getPrismaClient();
  if (!prisma) {
    return sendJson(res, 503, { error: "Database not available" });
  }

  const email = await prisma.emailMessage.update({
    where: { id },
    data: {
      isRead: false,
      readAt: null,
      readByUserId: null,
      readByUserName: null,
      readByUserEmail: null,
    },
  });

  sendJson(res, 200, {
    success: true,
    email: {
      id: email.id,
      isRead: email.isRead,
      readAt: null,
      readByUserId: null,
      readByUserName: null,
      readByUserEmail: null,
    },
  });
}

async function handleDeleteEmail(req, res, id) {
  const prisma = getPrismaClient();
  if (!prisma) {
    return sendJson(res, 503, { error: "Database not available" });
  }

  const body = await parseBody(req).catch(() => ({}));
  const deletedBy = normalizeViewer(body);

  const email = await prisma.emailMessage.findUnique({
    where: { id },
    include: {
      attachments: true,
    },
  });

  if (!email) {
    return sendJson(res, 404, { error: "Email not found" });
  }

  await registerDeletedEmail(email, deletedBy);
  await prisma.emailMessage.delete({
    where: { id },
  });

  sendJson(res, 200, { success: true });
}

async function handleDownloadAttachment(req, res, id) {
  const prisma = getPrismaClient();
  if (!prisma) {
    return sendJson(res, 503, { error: "Database not available" });
  }

  const attachment = await prisma.emailAttachment.findUnique({
    where: { id },
  });

  if (!attachment) {
    return sendJson(res, 404, { error: "Attachment not found" });
  }

  const { body, contentType, filename } = await readAttachmentContent(attachment);
  const safeFilename = filename.replace(/"/g, "");
  const encodedFilename = encodeURIComponent(filename);

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Content-Disposition": `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
  });
  res.end(body);
}

async function handleListBlockedSenders(req, res) {
  const blocked = await listBlockedSenders();
  sendJson(res, 200, {
    blockedSenders: blocked.map(mapBlockedSender),
  });
}

async function handleListDeletedEmails(req, res) {
  const deleted = await listDeletedEmails();
  sendJson(res, 200, {
    deletedEmails: deleted.map(mapDeletedEmail),
  });
}

async function handleRestoreDeletedEmail(req, res, id) {
  const restored = await restoreDeletedEmail(id);
  sendJson(res, 200, {
    success: true,
    deletedEmail: restored ? mapDeletedEmail(restored) : null,
  });
}

async function handleBlockSender(req, res) {
  const body = await parseBody(req);
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : null;
  const blockedBy = normalizeViewer(body);

  if (!email) {
    return sendJson(res, 400, { error: "Email do remetente é obrigatório" });
  }

  const blocked = await blockSender(email, blockedBy, reason);
  sendJson(res, 200, {
    success: true,
    blockedSender: mapBlockedSender(blocked),
  });
}

async function handleUnblockSender(req, res, id) {
  const blocked = await unblockSender(id);
  sendJson(res, 200, {
    success: true,
    blockedSender: mapBlockedSender(blocked),
  });
}

async function handleSendEmail(req, res) {
  const body = await parseBody(req);

  const { to, subject, text, html, cc, bcc, replyTo, attachments } = body;

  if (!to || !subject) {
    return sendJson(res, 400, { error: "Missing required fields: to, subject" });
  }

  try {
    const sentMailbox = env.IMAP_SENT_MAILBOXES[0] || "Sent";
    const sentUid = await getNextMailboxUid(sentMailbox);
    const attachmentInputs = Array.isArray(attachments) ? attachments : [];

    const result = await sendEmail({
      to: Array.isArray(to) ? to : [to],
      subject,
      text: text || "",
      html: html || "",
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : [],
      bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [],
      replyTo: replyTo || undefined,
      attachments: attachmentInputs.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType || "application/octet-stream",
            content: attachment.contentBase64,
            encoding: "base64",
          })),
    });

    const preparedAttachments = prepareAttachments({
      uid: sentUid,
      attachments: attachmentInputs.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType || "application/octet-stream",
        size: attachment.size,
        content: Buffer.from(attachment.contentBase64, "base64"),
      })),
    });

    const storedAttachments = await uploadAttachments({
      mailbox: sentMailbox,
      uid: sentUid,
      attachments: preparedAttachments,
    });

    await persistEmail({
      messageId: result.messageId,
      uid: sentUid,
      subject,
      from: [env.MAIL_FROM].filter(Boolean),
      to: Array.isArray(to) ? to : [to],
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : [],
      bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [],
      replyTo: replyTo ? (Array.isArray(replyTo) ? replyTo : [replyTo]) : [],
      date: new Date().toISOString(),
      text: text || "",
      html: html || "",
      textPreview: (text || "").trim().slice(0, 500) || null,
      hasAttachments: storedAttachments.length > 0,
      attachments: storedAttachments,
      metadata: {
        mailbox: sentMailbox,
        mailboxType: "sent",
        trigger: "system-send",
        detectionMethod: "manual_send",
        receivedAt: new Date().toISOString(),
      },
    });

    sendJson(res, 200, {
      success: true,
      messageId: result.messageId,
    });
  } catch (error) {
    log.error({ error: error.message }, "Falha ao enviar email");
    sendJson(res, 500, { error: error.message || "Failed to send email" });
  }
}

async function handleGetStats(req, res) {
  const prisma = getPrismaClient();
  if (!prisma) {
    return sendJson(res, 503, { error: "Database not available" });
  }

  const inboxMailboxes = env.IMAP_MAILBOXES.length > 0 ? env.IMAP_MAILBOXES : [env.IMAP_MAILBOX];
  const sentMailboxes = env.IMAP_SENT_MAILBOXES;
  const spamMailboxes = env.IMAP_SPAM_MAILBOXES;
  const [totalEmails, totalAttachments, todayEmails, unreadEmails, inboxEmails, sentEmails, spamEmails] = await Promise.all([
    prisma.emailMessage.count(),
    prisma.emailAttachment.count(),
    prisma.emailMessage.count({
      where: {
        receivedAt: {
          gte: new Date(new Date().setHours(0, 0, 0, 0)),
        },
      },
    }),
    prisma.emailMessage.count({
      where: {
        isRead: false,
        mailbox: {
          in: inboxMailboxes,
        },
      },
    }),
    prisma.emailMessage.count({
      where: {
        mailbox: {
          in: inboxMailboxes,
        },
      },
    }),
    prisma.emailMessage.count({
      where: {
        mailbox: {
          in: sentMailboxes.length > 0 ? sentMailboxes : ["__no-sent-emails__"],
        },
      },
    }),
    prisma.emailMessage.count({
      where: {
        mailbox: {
          in: spamMailboxes.length > 0 ? spamMailboxes : ["__no-spam-emails__"],
        },
      },
    }),
  ]);

  sendJson(res, 200, {
    totalEmails,
    totalAttachments,
    todayEmails,
    unreadEmails,
    inboxEmails,
    sentEmails,
    spamEmails,
  });
}

const webhooks = new Set();

async function handleRegisterWebhook(req, res) {
  const body = await parseBody(req);
  const { url, userId } = body;

  if (!url || typeof url !== "string") {
    return sendJson(res, 400, { error: "URL do webhook é obrigatória" });
  }

  const webhookKey = `${userId || "anonymous"}:${url}`;
  webhooks.add(webhookKey);

  log.info({ url, userId }, "Webhook registrado");
  sendJson(res, 200, { success: true, registered: webhooks.size });
}

async function handleUnregisterWebhook(req, res) {
  const body = await parseBody(req);
  const { url, userId } = body;

  if (!url || typeof url !== "string") {
    return sendJson(res, 400, { error: "URL do webhook é obrigatória" });
  }

  const webhookKey = `${userId || "anonymous"}:${url}`;
  webhooks.delete(webhookKey);

  log.info({ url, userId }, "Webhook desregistrado");
  sendJson(res, 200, { success: true, registered: webhooks.size });
}

export async function notifyNewEmail(emailData) {
  if (webhooks.size === 0) return;

  const payload = {
    type: "new_email",
    timestamp: new Date().toISOString(),
    email: {
      id: emailData.id,
      subject: emailData.subject,
      from: emailData.from,
      receivedAt: emailData.receivedAt,
      hasAttachments: emailData.hasAttachments,
    },
  };

  const promises = Array.from(webhooks).map(async (webhookKey) => {
    const url = webhookKey.split(":")[1];
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        log.warn({ url, status: response.status }, "Falha ao notificar webhook");
      }
    } catch (error) {
      log.error({ url, error: error.message }, "Erro ao notificar webhook");
    }
  });

  await Promise.allSettled(promises);
}

export function createHttpServer() {
  const server = createServer(handleRequest);
  const port = env.HTTP_PORT || 3010;

  return {
    start() {
      return new Promise((resolve) => {
        server.listen(port, () => {
          log.info({ port }, "Servidor HTTP iniciado");
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => {
          log.info("Servidor HTTP encerrado");
          resolve();
        });
      });
    },
  };
}
