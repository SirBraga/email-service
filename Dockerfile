FROM node:24-alpine AS base

WORKDIR /app

# Instalar dependências do sistema necessárias para Prisma
RUN apk add --no-cache openssl

# Copiar arquivos de dependências
COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Instalar dependências
RUN npm ci --only=production

# Gerar Prisma Client
RUN npx prisma generate

# Copiar código fonte
COPY src ./src

# Criar diretório de dados
RUN mkdir -p /app/data && chown -R node:node /app/data

# Usar usuário não-root
USER node

# Expor porta
EXPOSE 3010

# Comando de inicialização
CMD ["node", "src/index.js"]
