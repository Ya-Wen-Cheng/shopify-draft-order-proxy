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
  costChangeSourceId = null,
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
              costChangeSource: costChangeSource
                ? { id: costChangeSourceId || 'gid://shopify/Metafield/999', value: costChangeSource }
                : null,
            },
          },
        },
      },
    }),
    { status: 200 }
  );
}

function deleteResponse() {
  return new Response(
    JSON.stringify({ data: { metafieldDelete: { deletedId: 'gid://shopify/Metafield/999', userErrors: [] } } }),
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
    expect(await res.json()).toEqual({ ok: true, unchanged: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // read only, no write
  });

  it('initializes last_known_cost with no log entry when missing', async () => {
    mockReadThenWrite({ lastKnownCost: {} });

    const res = await sendWebhook({ id: 123, cost: '5.00' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, initialized: true });
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
    expect(await res.json()).toEqual({ ok: true, logged: true });
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

  it('uses cost_change_source when present and deletes it after logging', async () => {
    let call = 0;
    globalThis.fetch.mockImplementation(() => {
      call += 1;
      if (call === 1) return Promise.resolve(readResponse({ variantsCount: 2, lastKnownCost: { '456': '4.28' }, costChangeSource: 'order:#D1' }));
      if (call === 2) return Promise.resolve(writeResponse());
      return Promise.resolve(deleteResponse());
    });

    const res = await sendWebhook({ id: 123, cost: '4.59' });

    expect(res.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // read + write + delete

    // log contains the source
    const writeBody = JSON.parse(globalThis.fetch.mock.calls[1][1].body);
    const log = writeBody.variables.metafields.find(m => m.key === 'cost_change_log').value;
    expect(log).toContain('order:#D1');

    // write batch does NOT include cost_change_source
    expect(writeBody.variables.metafields.find(m => m.key === 'cost_change_source')).toBeUndefined();

    // third call is the delete mutation
    const deleteBody = JSON.parse(globalThis.fetch.mock.calls[2][1].body);
    expect(deleteBody.variables.id).toBe('gid://shopify/Metafield/999');
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
    // the HTTP status must surface, not a JSON parse error from reading the 500 body (Stryker survivor)
    expect((await res.json()).error).toBe('Shopify API returned 500');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  // ── Gaps found by Stryker (mutation score was 54.8%) ──

  it('retries GraphQL-level errors on a 200 response, then returns 500 with the GraphQL error', async () => {
    globalThis.fetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ errors: [{ message: 'Throttled' }] }), { status: 200 })));

    const res = await sendWebhook({ id: 123, cost: '5.00' });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('Throttled');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries when the request itself throws, then returns 500 with the network error', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));

    const res = await sendWebhook({ id: 123, cost: '5.00' });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('network down');
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });

  it('recovers when a retry succeeds after a failed attempt', async () => {
    let n = 0;
    globalThis.fetch.mockImplementation(() => {
      n += 1;
      return Promise.resolve(n === 1
        ? new Response('Bad Gateway', { status: 502 })
        : readResponse({ lastKnownCost: { '456': '5.00' } }));
    });

    const res = await sendWebhook({ id: 123, cost: '5.00' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, unchanged: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns 404 and writes nothing when the inventory item has no product', async () => {
    globalThis.fetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: { inventoryItem: null } }), { status: 200 })));

    const res = await sendWebhook({ id: 123, cost: '5.00' });

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Inventory item not found');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('reads the right inventory item and writes both metafields to custom/* with the right types', async () => {
    mockReadThenWrite({ lastKnownCost: { '456': '4.00' } });

    await sendWebhook({ id: 123, cost: '5.00' });

    const [readUrl, readOpts] = globalThis.fetch.mock.calls[0];
    expect(readUrl).toMatch(/^https:\/\/.+\.myshopify\.com\/admin\/api\/[\d-]+\/graphql\.json$/);
    expect(readOpts.method).toBe('POST');
    // the DO reads its own env; vitest.config.js pins it to a fake token, never the .dev.vars one
    expect(readOpts.headers['X-Shopify-Access-Token']).toBe('test-token');
    expect(JSON.parse(readOpts.body).variables).toEqual({ id: 'gid://shopify/InventoryItem/123' });
    // a wrong namespace/type would silently write to a different metafield (Stryker survivors)
    expect(getWriteMutationBody().variables.metafields).toEqual([
      expect.objectContaining({ ownerId: 'gid://shopify/Product/789', namespace: 'custom', key: 'last_known_cost', type: 'json' }),
      expect.objectContaining({ ownerId: 'gid://shopify/Product/789', namespace: 'custom', key: 'cost_change_log', type: 'multi_line_text_field' }),
    ]);
  });

  it('returns 400 when the DO receives a non-JSON body', async () => {
    // index.js parses JSON before forwarding, so hit the DO stub directly
    const stub = env.COST_CHANGE_HANDLER.get(env.COST_CHANGE_HANDLER.idFromName('bad-json'));
    const res = await stub.fetch('https://cost-change-handler/', { method: 'POST', body: 'not json' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid JSON' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
