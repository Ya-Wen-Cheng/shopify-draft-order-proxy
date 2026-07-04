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

async function call(request) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    request,
    { ...env, SHOPIFY_TOKEN: 'test-token', SHOPIFY_WEBHOOK_SECRET: WEBHOOK_SECRET },
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function sendWebhook(body) {
  const rawBody = JSON.stringify(body);
  const hmac = await signHmac(rawBody, WEBHOOK_SECRET);
  const req = new Request('http://example.com/webhook/cost-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Hmac-Sha256': hmac },
    body: rawBody,
  });
  return call(req);
}

function readResponse({
  variantId = '456',
  variantTitle = 'Default Title',
  variantsCount = 1,
  lastKnownCost = {},
  costChangeLog = '',
  costChangeSource = '',
} = {}) {
  return new Response(
    JSON.stringify({
      data: {
        inventoryItem: {
          id: 'gid://shopify/InventoryItem/123',
          variant: {
            id: `gid://shopify/ProductVariant/${variantId}`,
            title: variantTitle,
            product: {
              id: 'gid://shopify/Product/789',
              variantsCount: { count: variantsCount },
              lastKnownCost: { value: JSON.stringify(lastKnownCost) },
              costChangeLog: { value: costChangeLog },
              costChangeSource: { value: costChangeSource },
            },
          },
        },
      },
    }),
    { status: 200 }
  );
}

function writeResponse() {
  return new Response(
    JSON.stringify({ data: { metafieldsSet: { metafields: [], userErrors: [] } } }),
    { status: 200 }
  );
}

function mockRead(overrides) {
  globalThis.fetch.mockImplementation(() => Promise.resolve(readResponse(overrides)));
}

function mockReadThenWrite(overrides) {
  let call = 0;
  globalThis.fetch.mockImplementation(() => {
    call += 1;
    return Promise.resolve(call === 1 ? readResponse(overrides) : writeResponse());
  });
}

function getWriteMutationBody() {
  const writeCall = globalThis.fetch.mock.calls[globalThis.fetch.mock.calls.length - 1];
  return JSON.parse(writeCall[1].body);
}

// ── CostChangeHandler DO logic ────────────────────────────────────────────────

describe('CostChangeHandler', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns 200 with no mutation when cost is unchanged', async () => {
    mockRead({ lastKnownCost: { '456': '5.00' } });

    const res = await sendWebhook({ id: 123, cost: '5.00' });

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // read only, no write
  });

  it('initializes last_known_cost with no log entry when missing', async () => {
    mockReadThenWrite({ lastKnownCost: {} });

    const res = await sendWebhook({ id: 123, cost: '5.00' });

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    const body = getWriteMutationBody();
    const lastKnownCostField = body.variables.metafields.find(m => m.key === 'last_known_cost');
    expect(JSON.parse(lastKnownCostField.value)).toEqual({ '456': '5.00' });
    expect(body.variables.metafields.find(m => m.key === 'cost_change_log')).toBeUndefined();
  });

  it('logs a single-variant cost change without a variant column', async () => {
    mockReadThenWrite({
      variantsCount: 1,
      lastKnownCost: { '456': '24.99' },
      costChangeSource: '',
    });

    const res = await sendWebhook({ id: 123, cost: '26.49' });

    expect(res.status).toBe(200);
    const body = getWriteMutationBody();
    const log = body.variables.metafields.find(m => m.key === 'cost_change_log').value;
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2} \| \$24\.99 → \$26\.49 \| manual$/);
  });

  it('logs a multi-variant cost change with the variant title', async () => {
    mockReadThenWrite({
      variantTitle: '32 oz',
      variantsCount: 2,
      lastKnownCost: { '456': '4.28' },
      costChangeSource: '',
    });

    const res = await sendWebhook({ id: 123, cost: '4.59' });

    expect(res.status).toBe(200);
    const body = getWriteMutationBody();
    const log = body.variables.metafields.find(m => m.key === 'cost_change_log').value;
    expect(log).toMatch(/^\d{4}-\d{2}-\d{2} \| 32 oz \| \$4\.28 → \$4\.59 \| manual$/);
  });

  it('uses cost_change_source when present and clears it after logging', async () => {
    mockReadThenWrite({
      variantsCount: 2,
      lastKnownCost: { '456': '4.28' },
      costChangeSource: 'order:#D1',
    });

    const res = await sendWebhook({ id: 123, cost: '4.59' });

    expect(res.status).toBe(200);
    const body = getWriteMutationBody();
    const log = body.variables.metafields.find(m => m.key === 'cost_change_log').value;
    expect(log).toContain('order:#D1');

    const sourceField = body.variables.metafields.find(m => m.key === 'cost_change_source');
    expect(sourceField.value).toBe('');
  });

  it('prepends new log entries, keeping newest first', async () => {
    mockReadThenWrite({
      lastKnownCost: { '456': '4.28' },
      costChangeLog: '2026-06-01 | $4.00 → $4.28 | manual',
    });

    await sendWebhook({ id: 123, cost: '4.59' });

    const body = getWriteMutationBody();
    const log = body.variables.metafields.find(m => m.key === 'cost_change_log').value;
    const lines = log.split('\n');
    expect(lines[0]).toContain('$4.28 → $4.59');
    expect(lines[1]).toBe('2026-06-01 | $4.00 → $4.28 | manual');
  });

  it('retries failed Shopify API calls up to 2x then returns 500', async () => {
    globalThis.fetch.mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

    const res = await sendWebhook({ id: 123, cost: '5.00' });

    expect(res.status).toBe(500);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });
});
