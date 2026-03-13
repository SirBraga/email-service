import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { env } from "../config/env.js";
import { logger } from "../shared/logger.js";
import { prepareAttachments, readState, writeState } from "./message-store.js";
import { persistEmail } from "./email-repository.js";
import { uploadAttachments } from "./storage-service.js";
import { dispatchEmailWebhook, isWebhookEnabled } from "./webhook-dispatcher.js";

export function createImapWorker() {
  let client = null;
  let mailboxLock = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let resyncTimer = null;
  let reconnectTimer = null;
  let lastUid = 0;
  let processedUids = new Set();
  let processingRangePromise = null;
  const recentWindowSize = 10;

  const log = logger.child({ scope: "imap-worker" });

  async function loadState() {
    const state = await readState();
    lastUid = state.lastUid;
    processedUids = new Set(
      state.processedUids
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    );
  }

  async function persistState() {
    const normalized = Array.from(processedUids)
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);

    await writeState({ lastUid, processedUids: normalized });
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
      scheduleReconnect();
    });

    client.on("exists", () => {
      void processRangeSafely("exists");
    });

    await client.connect();
    mailboxLock = await client.getMailboxLock(env.IMAP_MAILBOX);
    reconnectAttempts = 0;

    log.info({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      mailbox: env.IMAP_MAILBOX,
      secure: env.IMAP_SECURE,
    }, "Worker IMAP conectado");
  }

  async function processMessage(message, trigger) {
    if (!message?.uid) return;

    const uid = message.uid;

    if (processedUids.has(uid)) return;
    if (!message.source) return;

    const parsed = await simpleParser(message.source);
    const messageId = parsed.messageId ?? `uid-${uid}`;
    const attachments = prepareAttachments({
      uid,
      attachments: parsed.attachments ?? [],
    });
    const detectionMethod = trigger === "exists" ? "idle" : "resync";
    const persistedAttachments = await uploadAttachments({
      mailbox: env.IMAP_MAILBOX,
      uid,
      attachments,
    });
    const emailRecord = {
      messageId,
      uid,
      subject: parsed.subject ?? "",
      from: (parsed.from?.value ?? []).map((item) => item.address || item.name || "").filter(Boolean),
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
        mailbox: env.IMAP_MAILBOX,
        trigger,
        detectionMethod,
        receivedAt: new Date().toISOString(),
      },
    };

    await persistEmail(emailRecord);

    if (uid > lastUid) {
      lastUid = uid;
    }

    processedUids.add(uid);
    const minimumUidToKeep = Math.max(lastUid - recentWindowSize + 1, 1);
    processedUids = new Set(
      Array.from(processedUids).filter((processedUid) => processedUid >= minimumUidToKeep),
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
        log.error({ error, uid, messageId }, "Falha ao enviar webhook do email");
      }
    }

    log.info({
      uid,
      messageId,
      subject: parsed.subject ?? "",
      from: emailRecord.from,
      attachments: persistedAttachments.length,
    }, "Email processado");
  }

  async function processRange(trigger) {
    if (!client) return;
    let processed = 0;
    const status = await client.status(env.IMAP_MAILBOX, { uidNext: true });
    const highestUid = Math.max((status.uidNext ?? 1) - 1, 0);
    const startUid = Math.max(highestUid - recentWindowSize + 1, 1);

    if (highestUid === 0) {
      return;
    }

    for await (const message of client.fetch(
      `${startUid}:${highestUid}`,
      { uid: true, envelope: true, source: true },
      { uid: true },
    )) {
      if (!message.uid) continue;
      await processMessage(message, trigger);
      processed += 1;
    }

    if (processed > 0) {
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

  async function startIdleLoop() {
    if (!client) return;

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

  async function cleanupClient() {
    if (mailboxLock) {
      try {
        mailboxLock.release();
      } catch {}

      mailboxLock = null;
    }

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
