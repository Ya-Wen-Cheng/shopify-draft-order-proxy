import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src';

async function call(request, mockEnv = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, { SHOPIFY_TOKEN: 'test-token', ...mockEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function put(path, body) {
  return new Request(`http://example.com${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── GET /pickup ──────────────────────────────────────────────────────────────

describe('GET /pickup', () => {
  it('returns the mobile HTML page', async () => {
    const res = await call(new Request('http://example.com/pickup'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Pickup Assistant');
  });
});

// ── GET /pickup/data ─────────────────────────────────────────────────────────

describe('GET /pickup/data', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  const draftOrdersResponse = {
    draft_orders: [
      {
        id: 1, name: '#D1', tags: 'draft-order-tab, priced',
        shipping_address: { first_name: 'Mei', last_name: 'Chen' },
        line_items: [
          { id: 101, title: 'Roma Tomatoes', variant_title: null, quantity: 3, price: '2.50', sku: 'TOM-1', product_id: 501 },
          { id: 102, title: 'Bagged Rice', variant_title: '25lb', quantity: 1, price: '18.00', sku: 'RICE-1', product_id: 502 },
        ],
      },
      {
        id: 2, name: '#D2', tags: 'priced', // not tagged draft-order-tab — must be excluded
        shipping_address: { first_name: 'Sam', last_name: 'Lee' },
        line_items: [{ id: 201, title: 'Onions', variant_title: null, quantity: 2, price: '1.00', sku: 'ON-1', product_id: 503 }],
      },
    ],
  };

  function mockFetch() {
    globalThis.fetch.mockImplementation((url, opts) => {
      if (url.includes('/graphql.json')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: {
            nodes: [
              { id: 'gid://shopify/Product/501', tags: ['weight', 'produce'] },
              { id: 'gid://shopify/Product/502', tags: ['grocery'] },
            ],
          },
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(draftOrdersResponse), { status: 200 }));
    });
  }

  it('applies status=open filter', async () => {
    mockFetch();
    await call(new Request('http://example.com/pickup/data'));
    const [url] = globalThis.fetch.mock.calls.find(([u]) => u.includes('/draft_orders.json'));
    expect(url).toContain('status=open');
  });

  it('excludes draft orders not tagged draft-order-tab', async () => {
    mockFetch();
    const res = await call(new Request('http://example.com/pickup/data'));
    const data = await res.json();
    expect(data.draft_orders).toHaveLength(1);
    expect(data.draft_orders[0].id).toBe(1);
  });

  it('enriches line items with has_weight_tag from product tags', async () => {
    mockFetch();
    const res = await call(new Request('http://example.com/pickup/data'));
    const data = await res.json();
    const items = data.draft_orders[0].line_items;
    expect(items.find(i => i.id === 101).has_weight_tag).toBe(true);
    expect(items.find(i => i.id === 102).has_weight_tag).toBe(false);
  });

  it('returns 500 when Shopify errors', async () => {
    globalThis.fetch.mockResolvedValue(new Response(JSON.stringify({ errors: 'boom' }), { status: 500 }));
    const res = await call(new Request('http://example.com/pickup/data'));
    expect(res.status).toBe(500);
  });
});

// ── PUT /pickup/update ───────────────────────────────────────────────────────

describe('PUT /pickup/update', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  const currentDraftOrder = {
    draft_order: {
      id: 1,
      line_items: [
        { id: 101, title: 'Roma Tomatoes', quantity: 3, price: '2.50', properties: [] },
        { id: 102, title: 'Bagged Rice', quantity: 1, price: '18.00', properties: [] },
        { id: 103, title: 'Onions', quantity: 2, price: '1.00', properties: [] },
      ],
    },
  };

  function mockFetch() {
    globalThis.fetch.mockImplementation((url, opts) => {
      if (opts?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({ draft_order: { id: 1 } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(currentDraftOrder), { status: 200 }));
    });
  }

  it('computes weight pricing: qty->1, price=sum(weights)*unit_price', async () => {
    mockFetch();
    await call(put('/pickup/update', {
      draft_order_id: 1,
      updates: [{ line_item_id: 101, type: 'weight', weights: [1.2, 0.8], unit_price: '2.50' }],
    }));

    const [, putOpts] = globalThis.fetch.mock.calls.find(([, o]) => o?.method === 'PUT');
    const body = JSON.parse(putOpts.body);
    const li = body.draft_order.line_items.find(i => i.id === 101);
    expect(li.quantity).toBe(1);
    expect(li.price).toBe('5.00'); // (1.2+0.8) * 2.50
    expect(li.properties).toContainEqual({ name: 'Weight (lb)', value: '1.2, 0.8' });
  });

  it('fetch-then-merge preserves untouched line items', async () => {
    mockFetch();
    await call(put('/pickup/update', {
      draft_order_id: 1,
      updates: [{ line_item_id: 101, type: 'found' }],
    }));

    const [, putOpts] = globalThis.fetch.mock.calls.find(([, o]) => o?.method === 'PUT');
    const body = JSON.parse(putOpts.body);
    expect(body.draft_order.line_items).toHaveLength(3);
    expect(body.draft_order.line_items.find(i => i.id === 102)).toMatchObject({ quantity: 1, price: '18.00' });
    expect(body.draft_order.line_items.find(i => i.id === 103)).toMatchObject({ quantity: 2, price: '1.00' });
  });

  it('applies partial quantity update', async () => {
    mockFetch();
    await call(put('/pickup/update', {
      draft_order_id: 1,
      updates: [{ line_item_id: 103, type: 'partial', quantity: 1 }],
    }));

    const [, putOpts] = globalThis.fetch.mock.calls.find(([, o]) => o?.method === 'PUT');
    const body = JSON.parse(putOpts.body);
    expect(body.draft_order.line_items.find(i => i.id === 103).quantity).toBe(1);
  });

  it('removes a line item entirely', async () => {
    mockFetch();
    await call(put('/pickup/update', {
      draft_order_id: 1,
      updates: [{ line_item_id: 102, type: 'remove' }],
    }));

    const [, putOpts] = globalThis.fetch.mock.calls.find(([, o]) => o?.method === 'PUT');
    const body = JSON.parse(putOpts.body);
    expect(body.draft_order.line_items.find(i => i.id === 102)).toBeUndefined();
    expect(body.draft_order.line_items).toHaveLength(2);
  });

  it('returns 400 when draft_order_id or updates missing', async () => {
    const res = await call(put('/pickup/update', { updates: [] }));
    expect(res.status).toBe(400);
  });
});

// ── PUT /pickup/complete ─────────────────────────────────────────────────────

describe('PUT /pickup/complete', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  function mockFetch({ existingTags = '' } = {}) {
    globalThis.fetch.mockImplementation((url, opts) => {
      if (url.includes('/complete.json')) {
        return Promise.resolve(new Response(JSON.stringify({ draft_order: { id: 1, name: '#D1' } }), { status: 200 }));
      }
      if (url.includes('/graphql.json')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: { draftOrder: { order: { id: 'gid://shopify/Order/9001', legacyResourceId: '9001' } } },
        }), { status: 200 }));
      }
      if (url.includes('/orders/9001.json') && (!opts || opts.method !== 'PUT')) {
        return Promise.resolve(new Response(JSON.stringify({ order: { id: 9001, tags: existingTags } }), { status: 200 }));
      }
      if (url.includes('/orders/9001.json') && opts?.method === 'PUT') {
        return Promise.resolve(new Response(JSON.stringify({ order: { id: 9001, tags: 'sourced' } }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
  }

  it('completes the draft order and adds sourced tag to resulting order', async () => {
    mockFetch();
    const res = await call(put('/pickup/complete', { draft_order_id: 1 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.order_id).toBe('9001');

    const tagCall = globalThis.fetch.mock.calls.find(([u, o]) => u.includes('/orders/9001.json') && o?.method === 'PUT');
    expect(tagCall).toBeDefined();
    const body = JSON.parse(tagCall[1].body);
    expect(body.order.tags).toContain('sourced');
  });

  it('does not duplicate sourced tag if already present', async () => {
    mockFetch({ existingTags: 'sourced, other' });
    await call(put('/pickup/complete', { draft_order_id: 1 }));

    const tagCall = globalThis.fetch.mock.calls.find(([u, o]) => u.includes('/orders/9001.json') && o?.method === 'PUT');
    expect(tagCall).toBeUndefined();
  });

  it('returns 400 when draft_order_id missing', async () => {
    const res = await call(put('/pickup/complete', {}));
    expect(res.status).toBe(400);
  });
});

// ── GET /invoice/{order_id} ───────────────────────────────────────────────────

describe('GET /invoice/{order_id}', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  const baseOrder = {
    id: 9001, name: '#1009', created_at: '2026-07-10T10:00:00Z', tags: '',
    shipping_address: { first_name: 'Mei', last_name: 'Chen', address1: '188 S Valley Blvd', address2: '', city: 'San Gabriel', province: 'CA', zip: '91776', phone: '555-1234' },
    line_items: [
      { title: 'Roma Tomatoes', variant_title: null, quantity: 1, price: '5.00', properties: [{ name: 'Weight (lb)', value: '1.2, 0.8' }] },
    ],
    subtotal_price: '5.00', total_tax: '0.00', total_price: '5.00',
    shipping_lines: [{ price: '10.00' }],
  };

  it('renders HTML invoice with weight properties and signature line', async () => {
    globalThis.fetch.mockResolvedValue(new Response(JSON.stringify({ order: baseOrder }), { status: 200 }));

    const res = await call(new Request('http://example.com/invoice/9001'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Weight (lb): 1.2, 0.8');
    expect(html).toContain('Customer Signature');
    expect(html).toContain('$10.00'); // non-member delivery fee shown
  });

  it('shows $0.00 delivery fee for member orders', async () => {
    globalThis.fetch.mockResolvedValue(new Response(JSON.stringify({ order: { ...baseOrder, tags: 'member' } }), { status: 200 }));

    const res = await call(new Request('http://example.com/invoice/9001'));
    const html = await res.text();
    expect(html).toContain('$0.00');
  });

  it('returns error status when Shopify order fetch fails', async () => {
    globalThis.fetch.mockResolvedValue(new Response(JSON.stringify({ errors: 'not found' }), { status: 404 }));

    const res = await call(new Request('http://example.com/invoice/9999'));
    expect(res.status).toBe(404);
  });
});
