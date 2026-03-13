import { createServer } from "node:http";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { getPrismaClient } from "../shared/prisma.js";
import { sendEmail } from "./smtp.js";

const log = logger.child({ scope: "http-server" });

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
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

  const where = {};

  if (search) {
    where.OR = [
      { subject: { contains: search, mode: "insensitive" } },
      { fromAddresses: { array_contains: search } },
    ];
  }

  if (mailbox) {
    where.mailbox = mailbox;
  }

  const [emails, total] = await Promise.all([
    prisma.emailMessage.findMany({
      where,
      orderBy: { receivedAt: "desc" },
      skip,
      take: limit,
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
    prisma.emailMessage.count({ where }),
  ]);

  const formatted = emails.map((email) => ({
    id: email.id,
    messageId: email.messageId,
    uid: email.uid,
    mailbox: email.mailbox,
    subject: email.subject,
    from: email.fromAddresses,
    to: email.toAddresses,
    cc: email.ccAddresses,
    date: getEmailDate(email),
    receivedAt: getReceivedAt(email),
    hasAttachments: email.hasAttachments,
    isRead: email.isRead,
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
      total,
      totalPages: Math.ceil(total / limit),
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

  sendJson(res, 200, {
    id: email.id,
    messageId: email.messageId,
    uid: email.uid,
    mailbox: email.mailbox,
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

async function handleSendEmail(req, res) {
  const body = await parseBody(req);

  const { to, subject, text, html, cc, bcc, replyTo, attachments } = body;

  if (!to || !subject) {
    return sendJson(res, 400, { error: "Missing required fields: to, subject" });
  }

  try {
    const result = await sendEmail({
      to: Array.isArray(to) ? to : [to],
      subject,
      text: text || "",
      html: html || "",
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : [],
      bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [],
      replyTo: replyTo || undefined,
      attachments: Array.isArray(attachments)
        ? attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType || "application/octet-stream",
            content: attachment.contentBase64,
            encoding: "base64",
          }))
        : [],
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

  const [totalEmails, totalAttachments, todayEmails, unreadEmails] = await Promise.all([
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
      },
    }),
  ]);

  sendJson(res, 200, {
    totalEmails,
    totalAttachments,
    todayEmails,
    unreadEmails,
  });
}

// Armazena os webhooks registrados
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
