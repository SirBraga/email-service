import { createImapWorker } from "./services/imap-worker.js";
import { logger } from "./shared/logger.js";

const worker = createImapWorker();

async function main() {
  logger.info("Iniciando email-service");
  await worker.start();
}

async function shutdown(signal) {
  logger.info({ signal }, "Encerrando email-service");
  await worker.stop();
  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

main().catch((error) => {
  logger.error({ error }, "Falha fatal ao iniciar email-service");
  process.exit(1);
});
