import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { prepareAttachments, readState, writeState } from "./message-store.js";
import {
  findBlockedSenderByEmail,
  findDeletedEmail,
  findExistingEmail,
  findLatestPersistedEmail,
  persistEmail,
} from "./email-repository.js";
import { uploadAttachments } from "./storage-service.js";
import { dispatchEmailWebhook, isWebhookEnabled } from "./webhook-dispatcher.js";

function normalizeEmailAddress(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveConfiguredMailboxes() {
  const configured = new Set(env.IMAP_MAILBOXES);
  configured.add(env.IMAP_MAILBOX);
  for (const mailbox of env.IMAP_SENT_MAILBOXES) configured.add(mailbox);
  for (const mailbox of env.IMAP_SPAM_MAILBOXES) configured.add(mailbox);
  return Array.from(configured).filter(Boolean);
}

export function createImapWorker() {
  let client = null;
  let mailboxLock = null;
  let activeMailbox = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let resyncTimer = null;
  let reconnectTimer = null;
  let mailboxStates = {};
  let processingRangePromise = null;

  const log = logger.child({ scope: "imap-worker" });
  const mailboxes = resolveConfiguredMailboxes();

  function getMailboxState(mailbox) {
    if (!mailboxStates[mailbox]) {
      mailboxStates[mailbox] = {
        lastUid: 0,
        processedUids: new Set(),
      };
    }

    return mailboxStates[mailbox];
  }

  async function loadState() {
    const state = await readState();
    mailboxStates = {};

    for (const mailbox of mailboxes) {
      const saved = state.mailboxes?.[mailbox];
      mailboxStates[mailbox] = {
        lastUid: Number(saved?.lastUid ?? (mailbox === env.IMAP_MAILBOX ? state.lastUid : 0)) || 0,
        processedUids: new Set(
          (saved?.processedUids ?? (mailbox === env.IMAP_MAILBOX ? state.processedUids : []))
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0),
        ),
      };
    }
  }

  async function persistState() {
    const serializedMailboxes = Object.fromEntries(
      Object.entries(mailboxStates).map(([mailbox, state]) => [mailbox, {
        lastUid: state.lastUid,
        processedUids: Array.from(state.processedUids)
          .filter((value) => Number.isInteger(value) && value > 0)
          .sort((a, b) => a - b),
      }]),
    );

    const primaryState = serializedMailboxes[env.IMAP_MAILBOX] ?? { lastUid: 0, processedUids: [] };
    await writeState({
      lastUid: primaryState.lastUid,
      processedUids: primaryState.processedUids,
      mailboxes: serializedMailboxes,
    });
  }

  async function resolveSyncCursor(mailbox) {
    const mailboxState = getMailboxState(mailbox);
    const latestPersistedEmail = await findLatestPersistedEmail(mailbox);
    const latestPersistedUid = Number(latestPersistedEmail?.uid ?? 0);
    const resolvedLastUid = Math.max(mailboxState.lastUid, latestPersistedUid);

    if (resolvedLastUid !== mailboxState.lastUid) {
      mailboxState.lastUid = resolvedLastUid;
      await persistState();
    }

    return { latestPersistedEmail, latestPersistedUid, resolvedLastUid };
  }

  function getReconnectDelay() {
    const base = env.IMAP_RECONNECT_INITIAL_DELAY_MS;
    const max = env.IMAP_RECONNECT_MAX_DELAY_MS;
    const exponential = Math.min(base * 2 ** reconnectAttempts, max);
    const jitter = Math.floor(Math.random() * 1000);
    return exponential + jitter;
  }

  async function connect() {
    client = new ImapFlow({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      secure: env.IMAP_SECURE,
      auth: {
        user: env.IMAP_USER,
        pass: env.IMAP_PASS,
      },
      maxIdleTime: env.IMAP_MAX_IDLE_TIME_MS,
      logger: false,
    });
    const currentClient = client;

    client.on("error", (error) => {
      log.error({ error }, "Erro no cliente IMAP");
    });

    client.on("close", () => {
      if (client === currentClient) {
        client = null;
      }
      mailboxLock = null;
      activeMailbox = null;
      scheduleReconnect();
    });

    client.on("exists", () => {
      void processRangeSafely("exists");
    });

    await client.connect();
    reconnectAttempts = 0;

    log.info({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      mailboxes,
      secure: env.IMAP_SECURE,
    }, "Worker IMAP conectado");
  }

  async function acquireMailbox(mailbox) {
    if (!client) return;

    if (mailboxLock) {
      try {
        mailboxLock.release();
      } catch {}
      mailboxLock = null;
    }

    mailboxLock = await client.getMailboxLock(mailbox);
    activeMailbox = mailbox;
  }

  function buildAttachmentFingerprint(attachment) {
    return [
      attachment.filename ?? attachment.storedFilename ?? "",
      attachment.storedFilename ?? "",
      attachment.contentType ?? "",
      Number(attachment.size ?? 0),
      attachment.checksum ?? "",
      attachment.contentId ?? "",
    ].join("::");
  }

  function normalizeExistingAttachment(attachment) {
    return {
      filename: attachment.filename,
      storedFilename: attachment.storedFilename,
      contentType: attachment.contentType,
      size: attachment.size,
      contentDisposition: attachment.contentDisposition ?? null,
      contentId: attachment.contentId ?? null,
      checksum: attachment.checksum ?? null,
      localRelativePath: attachment.localRelativePath ?? null,
      localAbsolutePath: attachment.localAbsolutePath ?? null,
      storageProvider: attachment.storageProvider ?? null,
      storageBucket: attachment.storageBucket ?? null,
      storageKey: attachment.storageKey ?? null,
      storageUrl: attachment.storageUrl ?? null,
      storageEtag: attachment.storageEtag ?? null,
    };
  }

  async function resolvePersistedAttachments(mailbox, uid, attachments) {
    if (!attachments.length) {
      return [];
    }

    const existingEmail = await findExistingEmail(mailbox, uid);
    const existingAttachments = existingEmail?.attachments ?? [];
    const existingByFingerprint = new Map(
      existingAttachments.map((attachment) => [buildAttachmentFingerprint(attachment), attachment]),
    );

    const reused = [];
    const pendingUpload = [];

    for (const attachment of attachments) {
      const fingerprint = buildAttachmentFingerprint(attachment);
      const existingAttachment = existingByFingerprint.get(fingerprint);

      if (existingAttachment) {
        reused.push(normalizeExistingAttachment(existingAttachment));
        continue;
      }

      pendingUpload.push(attachment);
    }

    const uploaded = await uploadAttachments({
      mailbox,
      uid,
      attachments: pendingUpload,
    });

    if (reused.length > 0) {
      log.info({ mailbox, uid, reused: reused.length, uploaded: uploaded.length }, "Anexos existentes reaproveitados");
    }

    return [...reused, ...uploaded];
  }

  function classifyMailbox(mailbox) {
    if (env.IMAP_SENT_MAILBOXES.includes(mailbox)) return "sent";
    if (env.IMAP_SPAM_MAILBOXES.includes(mailbox)) return "spam";
    return "inbox";
  }

  async function shouldSkipMessage(mailbox, uid, fromAddresses) {
    const deleted = await findDeletedEmail(mailbox, uid);
    if (deleted) {
      log.info({ mailbox, uid }, "Email ignorado por exclusão persistida");
      return true;
    }

    const primarySender = fromAddresses.find(Boolean);
    const normalized = normalizeEmailAddress(primarySender);
    if (!normalized) {
      return false;
    }

    const blocked = await findBlockedSenderByEmail(normalized);
    if (blocked) {
      log.info({ mailbox, uid, sender: normalized }, "Email ignorado por remetente bloqueado");
      return true;
    }

    return false;
  }

  async function processMessage(mailbox, message, trigger) {
    if (!message?.uid) return;

    const mailboxState = getMailboxState(mailbox);
    const uid = message.uid;

    if (mailboxState.processedUids.has(uid)) return;
    if (!message.source) return;

    const parsed = await simpleParser(message.source);
    const from = (parsed.from?.value ?? []).map((item) => item.address || item.name || "").filter(Boolean);

    if (await shouldSkipMessage(mailbox, uid, from)) {
      mailboxState.processedUids.add(uid);
      if (uid > mailboxState.lastUid) {
        mailboxState.lastUid = uid;
      }
      await persistState();
      return;
    }

    const messageId = parsed.messageId ?? `${mailbox}-uid-${uid}`;
    const attachments = prepareAttachments({ uid, attachments: parsed.attachments ?? [] });
    const detectionMethod = trigger === "exists" ? "idle" : "resync";
    const persistedAttachments = await resolvePersistedAttachments(mailbox, uid, attachments);
    const emailRecord = {
      messageId,
      uid,
      subject: parsed.subject ?? "",
      from,
      to: (parsed.to?.value ?? []).map((item) => item.address || item.name || "").filter(Boolean),
      cc: (parsed.cc?.value ?? []).map((item) => item.address || item.name || "").filter(Boolean),
      bcc: (parsed.bcc?.value ?? []).map((item) => item.address || item.name || "").filter(Boolean),
      replyTo: (parsed.replyTo?.value ?? []).map((item) => item.address || item.name || "").filter(Boolean),
      date: parsed.date?.toISOString() ?? null,
      text: parsed.text ?? null,
      html: typeof parsed.html === "string" ? parsed.html : null,
      textPreview: (parsed.text ?? "").trim().slice(0, 500) || null,
      hasAttachments: persistedAttachments.length > 0,
      attachments: persistedAttachments,
      metadata: {
        mailbox,
        mailboxType: classifyMailbox(mailbox),
        trigger,
        detectionMethod,
        receivedAt: new Date().toISOString(),
      },
    };

    await persistEmail(emailRecord);

    if (uid > mailboxState.lastUid) {
      mailboxState.lastUid = uid;
    }

    mailboxState.processedUids.add(uid);
    const minimumUidToKeep = Math.max(mailboxState.lastUid - 200 + 1, 1);
    mailboxState.processedUids = new Set(
      Array.from(mailboxState.processedUids).filter((processedUid) => processedUid >= minimumUidToKeep),
    );
    await persistState();

    if (isWebhookEnabled()) {
      try {
        await dispatchEmailWebhook({
          event: "email.received",
          version: 1,
          email: emailRecord,
        });
      } catch (error) {
        log.error({ error, mailbox, uid, messageId }, "Falha ao enviar webhook do email");
      }
    }

    log.info({
      mailbox,
      uid,
      messageId,
      subject: parsed.subject ?? "",
      from: emailRecord.from,
      attachments: persistedAttachments.length,
    }, "Email processado");
  }

  async function processMailboxRange(mailbox, trigger) {
    if (!client) return 0;

    await acquireMailbox(mailbox);

    let processed = 0;
    const { latestPersistedUid } = await resolveSyncCursor(mailbox);
    const status = await client.status(mailbox, { uidNext: true });
    const highestUid = Math.max((status.uidNext ?? 1) - 1, 0);

    if (highestUid === 0) {
      return 0;
    }

    const startUid = latestPersistedUid > 0 ? latestPersistedUid + 1 : 1;

    if (startUid > highestUid) {
      log.info({ mailbox, trigger, latestPersistedUid, highestUid }, "Nenhum novo email encontrado para sincronização");
      return 0;
    }

    for await (const message of client.fetch(`${startUid}:${highestUid}`, { uid: true, envelope: true, source: true }, { uid: true })) {
      if (!message.uid) continue;
      await processMessage(mailbox, message, trigger);
      processed += 1;
    }

    if (processed > 0) {
      log.info({ mailbox, trigger, startUid, highestUid, processed, latestPersistedUid }, "Sincronização de emails concluída");
    }

    return processed;
  }

  async function processRange(trigger) {
    if (!client) return;

    for (const mailbox of mailboxes) {
      await processMailboxRange(mailbox, trigger);
    }
  }

  async function processRangeSafely(trigger) {
    if (processingRangePromise) {
      return processingRangePromise;
    }

    processingRangePromise = (async () => {
      try {
        await processRange(trigger);
      } catch (error) {
        log.error({ error, trigger }, "Falha ao processar faixa de mensagens");
        if (error?.code === "NoConnection") {
          scheduleReconnect();
        }
      } finally {
        processingRangePromise = null;
      }
    })();

    return processingRangePromise;
  }

  function scheduleResync() {
    if (resyncTimer) {
      clearInterval(resyncTimer);
    }

    resyncTimer = setInterval(() => {
      void processRangeSafely("interval");
    }, env.IMAP_RESYNC_INTERVAL_MS);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;

    reconnectAttempts += 1;
    const delay = getReconnectDelay();

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;

      void (async () => {
        try {
          await run();
        } catch (error) {
          log.error({ error }, "Falha no loop de reconexão");
          scheduleReconnect();
        }
      })();
    }, delay);
  }

  async function cleanupClient() {
    if (mailboxLock) {
      try {
        mailboxLock.release();
      } catch {}
      mailboxLock = null;
    }

    activeMailbox = null;

    if (!client) return;

    const current = client;
    client = null;

    try {
      await current.logout();
    } catch {
      try {
        current.close();
      } catch {}
    }
  }

  async function startIdleLoop() {
    if (!client) return;

    const idleMailbox = mailboxes[0] || env.IMAP_MAILBOX;
    if (activeMailbox !== idleMailbox) {
      await acquireMailbox(idleMailbox);
    }

    while (!stopped && client) {
      try {
        await client.idle();
      } catch (error) {
        if (stopped) {
          break;
        }

        if (error?.code === "NoConnection") {
          break;
        }

        throw error;
      }
    }
  }

  async function run() {
    if (stopped) return;

    await cleanupClient();
    await connect();
    scheduleResync();
    await processRangeSafely("startup");

    try {
      await startIdleLoop();
    } catch (error) {
      log.error({ error }, "Loop IDLE interrompido");
      scheduleReconnect();
      return;
    }

    if (!stopped) {
      scheduleReconnect();
    }
  }

  return {
    async start() {
      try {
        stopped = false;
        await loadState();
        await run();
      } catch (error) {
        log.error({
          message: error?.message ?? "Erro ao iniciar worker",
          code: error?.code ?? null,
          stack: error?.stack ?? null,
        }, "Falha ao iniciar worker IMAP");
        throw error;
      }
    },
    async stop() {
      stopped = true;

      if (resyncTimer) {
        clearInterval(resyncTimer);
        resyncTimer = null;
      }

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      await cleanupClient();
    },
  };
}
