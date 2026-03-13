import { createImapWorker } from "./services/imap-worker.js";
import { logger } from "./shared/logger.js";
import { connectPrisma, disconnectPrisma } from "./shared/prisma.js";

const worker = createImapWorker();

async function main() {
  logger.info("Iniciando email-service");
  await connectPrisma();
  await worker.start();
}

async function shutdown(signal) {
  logger.info({ signal }, "Encerrando email-service");
  await worker.stop();
  await disconnectPrisma();
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
  void disconnectPrisma().finally(() => {
    process.exit(1);
  });
});
