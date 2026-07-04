import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src';

// ── helpers ──────────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret';

async function signHmac(rawBody, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function makeCtx() {
  return createExecutionContext();
}

async function call(request, mockEnv = {}) {
  const ctx = makeCtx();
  const res = await worker.fetch(
    request,
    { ...env, SHOPIFY_TOKEN: 'test-token', SHOPIFY_WEBHOOK_SECRET: WEBHOOK_SECRET, ...mockEnv },
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function webhookRequest(body, { secret = WEBHOOK_SECRET, badSignature = false } = {}) {
  const rawBody = JSON.stringify(body);
  const hmac = badSignature ? 'invalid-signature' : await signHmac(rawBody, secret);
  return new Request('http://example.com/webhook/cost-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac },
    body: rawBody,
  });
}

// ── POST /webhook/cost-update ────────────────────────────────────────────────

describe('POST /webhook/cost-update', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns 401 when HMAC signature is invalid', async () => {
    const req = await webhookRequest({ id: 123, cost: '5.00' }, { badSignature: true });
    const res = await call(req);
    expect(res.status).toBe(401);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('returns 401 when HMAC header is missing', async () => {
    const rawBody = JSON.stringify({ id: 123, cost: '5.00' });
    const req = new Request('http://example.com/webhook/cost-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawBody,
    });
    const res = await call(req);
    expect(res.status).toBe(401);
  });

  it('returns 200 immediately when cost is null, with no Shopify API calls', async () => {
    const req = await webhookRequest({ id: 123, cost: null });
    const res = await call(req);
    expect(res.status).toBe(200);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('forwards valid requests to the CostChangeHandler DO and returns its status', async () => {
    const req = await webhookRequest({ id: 123, cost: '5.00' });
    const res = await call(req);
    // Stub DO returns 200 OK by default (default DO fetch stubbed via Miniflare below is exercised
    // through the real durable object binding configured in wrangler.jsonc for tests).
    expect(res.status).toBe(200);
  });
});
