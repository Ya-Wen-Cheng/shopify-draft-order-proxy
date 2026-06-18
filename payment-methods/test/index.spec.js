import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { deriveChips } from '../src';

// ── helpers ──────────────────────────────────────────────────────────────────

async function call(request, mockEnv = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { SHOPIFY_TOKEN: 'test-token', ...mockEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ── deriveChips ───────────────────────────────────────────────────────────────

describe('deriveChips', () => {
  it('extracts text in parentheses', () => {
    expect(deriveChips('Bank Transfer (ACH)')).toEqual(['ACH']);
  });

  it('matches net 30', () => {
    expect(deriveChips('Net 30')).toEqual(['NET 30']);
  });

  it('matches net 60', () => {
    expect(deriveChips('Net 60 Terms')).toEqual(['NET 60']);
  });

  it('returns card brands for credit card', () => {
    expect(deriveChips('Credit Card')).toEqual(['VISA', 'MC', 'AMEX']);
  });

  it('returns CHECK for check', () => {
    expect(deriveChips('Business Check')).toEqual(['CHECK']);
  });

  it('returns ZELLE for zelle', () => {
    expect(deriveChips('Zelle Payment')).toEqual(['ZELLE']);
  });

  it('falls back to first word (max 6 chars) for unknown names', () => {
    expect(deriveChips('Crypto')).toEqual(['CRYPTO']);
    expect(deriveChips('Cryptocurrency Payment')).toEqual(['CRYPTO']);
    expect(deriveChips('TOOLONG Name')).toEqual(['TOOLON']);
  });
});

// ── OPTIONS preflight ─────────────────────────────────────────────────────────

describe('OPTIONS preflight', () => {
  it('returns 200 with CORS headers', async () => {
    const res = await call(new Request('http://example.com/', { method: 'OPTIONS' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

// ── Method not allowed ────────────────────────────────────────────────────────

describe('non-GET methods', () => {
  it('returns 405 for POST', async () => {
    const res = await call(new Request('http://example.com/', { method: 'POST' }));
    expect(res.status).toBe(405);
  });

  it('returns 405 for PUT', async () => {
    const res = await call(new Request('http://example.com/', { method: 'PUT' }));
    expect(res.status).toBe(405);
  });
});

// ── GET / ─────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns only enabled manual gateways with chips', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          payment_gateways: [
            { id: 1, name: 'Bank Transfer (ACH)', type: 'manual', enabled: true,  description: 'Wire details on invoice' },
            { id: 2, name: 'Net 30',              type: 'manual', enabled: true,  description: 'Pay within 30 days' },
            { id: 3, name: 'Credit Card',         type: 'manual', enabled: true,  description: 'Via invoice' },
            { id: 4, name: 'Shopify Payments',    type: 'hosted', enabled: true,  description: '' },
            { id: 5, name: 'Business Check',      type: 'manual', enabled: false, description: '' },
          ],
        }),
        { status: 200 }
      )
    );

    const res = await call(new Request('http://example.com/'));
    expect(res.status).toBe(200);

    const data = await res.json();
    // hosted gateway (#4) and disabled gateway (#5) are excluded
    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({ id: '1', name: 'Bank Transfer (ACH)', chips: ['ACH'] });
    expect(data[1]).toMatchObject({ id: '2', name: 'Net 30', chips: ['NET 30'] });
    expect(data[2]).toMatchObject({ id: '3', name: 'Credit Card', chips: ['VISA', 'MC', 'AMEX'] });
  });

  it('includes description in each gateway', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          payment_gateways: [
            { id: 1, name: 'Net 30', type: 'manual', enabled: true, description: 'Pay within 30 days of delivery' },
          ],
        }),
        { status: 200 }
      )
    );

    const res = await call(new Request('http://example.com/'));
    const [gateway] = await res.json();
    expect(gateway.description).toBe('Pay within 30 days of delivery');
  });

  it('returns empty array when no manual gateways exist', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          payment_gateways: [
            { id: 1, name: 'Shopify Payments', type: 'hosted', enabled: true, description: '' },
          ],
        }),
        { status: 200 }
      )
    );

    const res = await call(new Request('http://example.com/'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns empty array when payment_gateways is missing from response', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 })
    );

    const res = await call(new Request('http://example.com/'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('proxies Shopify error status and wraps message', async () => {
    globalThis.fetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const res = await call(new Request('http://example.com/'));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/Shopify error/);
  });

  it('returns 500 when fetch throws', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network failure'));

    const res = await call(new Request('http://example.com/'));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('network failure');
  });
});
