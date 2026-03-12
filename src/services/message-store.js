import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataDir = path.resolve(process.cwd(), "data");
const inboxFile = path.join(dataDir, "inbox.ndjson");
const stateFile = path.join(dataDir, "state.json");

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true });
}

export async function appendMessage(message) {
  await ensureDataDir();
  await appendFile(inboxFile, `${JSON.stringify(message)}\n`, "utf8");
}

export async function readState() {
  await ensureDataDir();

  try {
    const content = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(content);
    return {
      lastUid: parsed.lastUid ?? 0,
      processedUids: Array.isArray(parsed.processedUids) ? parsed.processedUids : [],
    };
  } catch {
    return { lastUid: 0, processedUids: [] };
  }
}

export async function writeState(state) {
  await ensureDataDir();
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}
