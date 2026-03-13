import { createImapWorker } from "./services/imap-worker.js";
import { createHttpServer } from "./services/http-server.js";
import { logger } from "./shared/logger.js";
import { connectPrisma, disconnectPrisma } from "./shared/prisma.js";

const worker = createImapWorker();
const httpServer = createHttpServer();

async function main() {
  logger.info("Iniciando email-service");
  await connectPrisma();
  await httpServer.start();
  await worker.start();
}

async function shutdown(signal) {
  logger.info({ signal }, "Encerrando email-service");
  await worker.stop();
  await httpServer.stop();
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
  logger.error({
    message: error?.message ?? "Erro desconhecido",
    stack: error?.stack ?? "Stack trace não disponível",
    code: error?.code ?? null,
    name: error?.name ?? null,
    cause: error?.cause ?? null,
  }, "Falha fatal ao iniciar email-service");
  void disconnectPrisma().finally(() => {
    process.exit(1);
  });
});
