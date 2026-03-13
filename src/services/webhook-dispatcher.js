import { env } from "../config/env.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders() {
  const headers = {
    "content-type": "application/json",
  };

  if (env.EMAIL_WEBHOOK_BEARER_TOKEN) {
    headers.authorization = `Bearer ${env.EMAIL_WEBHOOK_BEARER_TOKEN}`;
  }

  return headers;
}

export function isWebhookEnabled() {
  return Boolean(env.EMAIL_WEBHOOK_URL);
}

export async function dispatchEmailWebhook(payload) {
  if (!isWebhookEnabled()) {
    return { delivered: false, skipped: true };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= env.EMAIL_WEBHOOK_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(env.EMAIL_WEBHOOK_URL, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(env.EMAIL_WEBHOOK_TIMEOUT_MS),
      });

      if (response.ok) {
        return {
          delivered: true,
          skipped: false,
          status: response.status,
          attempt,
        };
      }

      const responseText = await response.text();
      const error = new Error(`Webhook respondeu com status ${response.status}`);
      error.status = response.status;
      error.responseText = responseText.slice(0, 1000);
      lastError = error;

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        break;
      }
    } catch (error) {
      lastError = error;
    }

    if (attempt < env.EMAIL_WEBHOOK_MAX_RETRIES) {
      await wait(env.EMAIL_WEBHOOK_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError ?? new Error("Falha ao enviar webhook de email");
}
