import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), "data");
const stateFile = path.join(dataDir, "state.json");

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

function sanitizeFilename(value, fallback) {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized || fallback;
}

function normalizeMailboxState(input) {
  const value = input && typeof input === "object" ? input : {};
  return {
    lastUid: Number(value.lastUid ?? 0) || 0,
    processedUids: Array.isArray(value.processedUids) ? value.processedUids : [],
  };
}

export function prepareAttachments({ uid, attachments }) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }

  const prepared = [];

  for (const [index, attachment] of attachments.entries()) {
    const safeFilename = sanitizeFilename(attachment.filename, `attachment-${index + 1}`);
    const storedFilename = `${String(index + 1).padStart(3, "0")}-${safeFilename}`;

    prepared.push({
      filename: attachment.filename ?? storedFilename,
      storedFilename,
      contentType: attachment.contentType ?? "application/octet-stream",
      size: attachment.size ?? attachment.content?.length ?? 0,
      contentDisposition: attachment.contentDisposition ?? null,
      contentId: attachment.cid ?? null,
      checksum: attachment.checksum ?? null,
      content: attachment.content,
    });
  }

  return prepared;
}

export async function readState() {
  await ensureDataDir();

  try {
    const content = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(content);
    const mailboxes = parsed.mailboxes && typeof parsed.mailboxes === "object" ? parsed.mailboxes : {};
    return {
      lastUid: parsed.lastUid ?? 0,
      processedUids: Array.isArray(parsed.processedUids) ? parsed.processedUids : [],
      mailboxes: Object.fromEntries(
        Object.entries(mailboxes).map(([mailbox, mailboxState]) => [mailbox, normalizeMailboxState(mailboxState)]),
      ),
    };
  } catch {
    return { lastUid: 0, processedUids: [], mailboxes: {} };
  }
}

export async function writeState(state) {
  await ensureDataDir();
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}
