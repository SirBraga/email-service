import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env, isDatabaseEnabled } from "../config/env.js";
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
    const adapter = new PrismaPg({
      connectionString: env.DATABASE_URL,
    });

    prisma = new PrismaClient({ adapter });
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
