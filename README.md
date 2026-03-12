# email-service

Serviço Node.js em JavaScript para recebimento de emails via IMAP IDLE com reconexão automática e envio via SMTP.

## Recursos

- IMAP IDLE para recebimento quase em tempo real
- Reconexão automática com backoff exponencial
- Ressincronização periódica para reduzir perda de eventos
- SMTP preparado para envio
- Logs estruturados com Pino

## Instalação

```bash
npm install
```

## Configuração

Copie `.env.example` para `.env` e preencha as credenciais IMAP/SMTP.

## Desenvolvimento

```bash
npm run dev
```

## Execução

```bash
npm start
```
