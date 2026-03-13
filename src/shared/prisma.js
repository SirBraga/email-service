import { PrismaClient } from "@prisma/client";
import { isDatabaseEnabled } from "../config/env.js";
import { logger } from "./logger.js";

let prisma = null;

export async function connectPrisma() {
  if (!isDatabaseEnabled()) {
    logger.info("Banco de dados desabilitado (EMAIL_DATABASE_ENABLED=false)");
    return null;
  }

  if (prisma) {
    return prisma;
  }

  try {
    prisma = new PrismaClient();
    await prisma.$connect();
    logger.info("Conexão com banco de dados estabelecida");
    return prisma;
  } catch (error) {
    logger.error({
      message: error?.message ?? "Erro ao conectar no banco",
      code: error?.code ?? null,
      meta: error?.meta ?? null,
    }, "Falha na conexão com banco de dados");
    throw error;
  }
}

export function getPrismaClient() {
  return prisma;
}

export async function disconnectPrisma() {
  if (!prisma) {
    return;
  }

  const current = prisma;
  prisma = null;
  await current.$disconnect();
}
