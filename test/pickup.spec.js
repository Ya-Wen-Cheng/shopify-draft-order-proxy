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
        created_at: '2026-07-15T17:30:00Z',
        shipping_address: { first_name: 'Mei', last_name: 'Chen' },
        line_items: [
          { id: 101, title: 'Roma Tomatoes', variant_title: null, quantity: 3, price: '2.50', sku: 'TOM-1', product_id: 501, variant_id: 1001 },
          { id: 102, title: 'Bagged Rice', variant_title: '25lb', quantity: 1, price: '18.00', sku: 'RICE-1', product_id: 502, variant_id: 1002 },
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
              {
                id: 'gid://shopify/Product/501',
                tags: ['weight', 'produce'],
                variants: {
                  edges: [{
                    node: {
                      id: 'gid://shopify/ProductVariant/1001',
                      inventoryItem: {
                        id: 'gid://shopify/InventoryItem/2001',
                        unitCost: { amount: '1.25' },
                      },
                    },
                  }],
                },
              },
              {
                id: 'gid://shopify/Product/502',
                tags: ['grocery'],
                variants: {
                  edges: [{
                    node: {
                      id: 'gid://shopify/ProductVariant/1002',
                      inventoryItem: {
                        id: 'gid://shopify/InventoryItem/2002',
                        unitCost: { amount: '15.00' },
                      },
                    },
                  }],
                },
              },
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

  it('enriches line items with cost, inventory_item_id, variant_id, product_id and order with created_at', async () => {
    mockFetch();
    const res = await call(new Request('http://example.com/pickup/data'));
    const data = await res.json();
    const order = data.draft_orders[0];
    expect(order.created_at).toBe('2026-07-15T17:30:00Z');
    const item101 = order.line_items.find(i => i.id === 101);
    expect(item101.cost).toBe('1.25');
    expect(item101.inventory_item_id).toBe('gid://shopify/InventoryItem/2001');
    expect(item101.variant_id).toBe(1001);
    expect(item101.product_id).toBe(501);
    const item102 = order.line_items.find(i => i.id === 102);
    expect(item102.cost).toBe('15.00');
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
    expect(li.properties).toContainEqual({ name: 'Price Breakdown', value: '$2.50/lb × 2 lb = $5.00' });
  });

  it('uses unit_price from change (not stale lineItem.price) when driver updated price', async () => {
    mockFetch();
    // lineItem price is $2.50/lb but driver confirmed $3.00/lb in cost/price panel
    await call(put('/pickup/update', {
      draft_order_id: 1,
      updates: [{ line_item_id: 101, type: 'weight', weights: [1.0, 2.0], unit_price: '3.00' }],
    }));

    const [, putOpts] = globalThis.fetch.mock.calls.find(([, o]) => o?.method === 'PUT');
    const body = JSON.parse(putOpts.body);
    const li = body.draft_order.line_items.find(i => i.id === 101);
    expect(li.price).toBe('9.00'); // (1.0+2.0) * 3.00, not * 2.50
    expect(li.properties).toContainEqual({ name: 'Price Breakdown', value: '$3.00/lb × 3 lb = $9.00' });
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

// ── PUT /pickup/complete — batched changes ────────────────────────────────────

describe('PUT /pickup/complete — batched changes', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  const currentDraftOrder = {
    draft_order: {
      id: 1,
      line_items: [
        { id: 101, title: 'Roma Tomatoes', quantity: 1, price: '5.00', variant_id: 1001, properties: [] },
        { id: 102, title: 'Chicken Breast', quantity: 2, price: '12.00', variant_id: 1002, properties: [] },
      ],
    },
  };

  function mockFetch() {
    globalThis.fetch.mockImplementation(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};

      if (url.includes('/graphql.json') && body.query?.includes('metafieldsSet')) {
        return new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [{ id: 'mf1', key: 'cost_change_source' }], userErrors: [] } } }), { status: 200 });
      }
      if (url.includes('/graphql.json') && body.query?.includes('DraftOrderUpdate')) {
        return new Response(JSON.stringify({ data: { draftOrderUpdate: { draftOrder: { id: 'gid://shopify/DraftOrder/1' }, userErrors: [] } } }), { status: 200 });
      }
      if (url.includes('/graphql.json')) {
        return new Response(JSON.stringify({ data: { draftOrder: { order: { id: 'gid://shopify/Order/9001', legacyResourceId: '9001' } } } }), { status: 200 });
      }
      if (url.includes('/inventory_items/') && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ inventory_item: { id: 2001, cost: '3.50' } }), { status: 200 });
      }
      if (url.includes('/draft_orders/1.json') && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ draft_order: { id: 1 } }), { status: 200 });
      }
      if (url.includes('/draft_orders/1.json')) {
        return new Response(JSON.stringify(currentDraftOrder), { status: 200 });
      }
      if (url.includes('/complete.json')) {
        return new Response(JSON.stringify({ draft_order: { id: 1 } }), { status: 200 });
      }
      if (url.includes('/orders/9001.json') && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ order: { id: 9001, tags: 'sourced' } }), { status: 200 });
      }
      if (url.includes('/orders/9001.json')) {
        return new Response(JSON.stringify({ order: { id: 9001, tags: '' } }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
  }

  it('processes cost_price change: sets metafield, updates inventory item, merges price, completes draft', async () => {
    mockFetch();
    const res = await call(put('/pickup/complete', {
      draft_order_id: 1,
      changes: [{
        type: 'cost_price',
        line_item_id: 101,
        title: 'Roma Tomatoes',
        cost: '3.50',
        price: '6.00',
        product_id: 501,
        inventory_item_id: 'gid://shopify/InventoryItem/2001',
        current_cost: '1.25',
        current_price: '5.00',
      }],
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.all_succeeded).toBe(true);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].success).toBe(true);
    expect(data.results[0].line_item_id).toBe(101);
    expect(data.results[0].title).toBe('Roma Tomatoes');
    expect(data.order_id).toBe('9001');

    // metafield was set
    const metafieldCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/graphql.json') && JSON.parse(o.body).query?.includes('metafieldsSet')
    );
    expect(metafieldCall).toBeDefined();
    const mfBody = JSON.parse(metafieldCall[1].body);
    expect(mfBody.variables.metafields[0].value).toBe('pickup');
    expect(mfBody.variables.metafields[0].key).toBe('cost_change_source');

    // inventory item was updated
    const inventoryCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/inventory_items/') && o?.method === 'PUT'
    );
    expect(inventoryCall).toBeDefined();
    const invBody = JSON.parse(inventoryCall[1].body);
    expect(invBody.inventory_item.cost).toBe('3.50');

    // price was merged via GraphQL draftOrderUpdate
    const draftUpdateCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/graphql.json') && JSON.parse(o.body).query?.includes('DraftOrderUpdate')
    );
    expect(draftUpdateCall).toBeDefined();
    const updateVars = JSON.parse(draftUpdateCall[1].body).variables;
    const li = updateVars.input.lineItems.find(i => i.variantId === 'gid://shopify/ProductVariant/1001');
    expect(li.priceOverride).toEqual({ amount: '6.00', currencyCode: 'USD' });
  });

  it('cost-only change: sets metafield and inventory item, skips line item merge', async () => {
    mockFetch();
    const res = await call(put('/pickup/complete', {
      draft_order_id: 1,
      changes: [{
        type: 'cost_price',
        line_item_id: 101,
        title: 'Roma Tomatoes',
        cost: '3.50',
        price: null,
        product_id: 501,
        inventory_item_id: 'gid://shopify/InventoryItem/2001',
        current_cost: '1.25',
        current_price: '5.00',
      }],
    }));

    const data = await res.json();
    expect(data.all_succeeded).toBe(true);

    // inventory item updated
    const inventoryCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/inventory_items/') && o?.method === 'PUT'
    );
    expect(inventoryCall).toBeDefined();

    const metafieldCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/graphql.json') && JSON.parse(o?.body || '{}').query?.includes('metafieldsSet')
    );
    expect(metafieldCall).toBeDefined();

    // no draft order PUT (no line item changes)
    const draftPutCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/draft_orders/1.json') && o?.method === 'PUT'
    );
    expect(draftPutCall).toBeUndefined();
  });

  it('price-only change: skips metafield and inventory, merges price into draft order', async () => {
    mockFetch();
    const res = await call(put('/pickup/complete', {
      draft_order_id: 1,
      changes: [{
        type: 'cost_price',
        line_item_id: 101,
        title: 'Roma Tomatoes',
        cost: null,
        price: '6.00',
        product_id: 501,
        inventory_item_id: 'gid://shopify/InventoryItem/2001',
        current_cost: '1.25',
        current_price: '5.00',
      }],
    }));

    const data = await res.json();
    expect(data.all_succeeded).toBe(true);

    // no metafield call
    const metafieldCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/graphql.json') && JSON.parse(o?.body || '{}').query?.includes('metafieldsSet')
    );
    expect(metafieldCall).toBeUndefined();

    // no inventory item call
    const inventoryCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/inventory_items/') && o?.method === 'PUT'
    );
    expect(inventoryCall).toBeUndefined();

    // price merged via GraphQL draftOrderUpdate
    const draftUpdateCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/graphql.json') && JSON.parse(o.body).query?.includes('DraftOrderUpdate')
    );
    expect(draftUpdateCall).toBeDefined();
    const updateVars = JSON.parse(draftUpdateCall[1].body).variables;
    const li = updateVars.input.lineItems.find(i => i.variantId === 'gid://shopify/ProductVariant/1001');
    expect(li.priceOverride).toEqual({ amount: '6.00', currencyCode: 'USD' });
  });

  it('partial failure: metafield userErrors marks result failed, draft not completed', async () => {
    globalThis.fetch.mockImplementation(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (url.includes('/graphql.json') && body.query?.includes('metafieldsSet')) {
        return new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [], userErrors: [{ field: 'ownerId', message: 'not found' }] } } }), { status: 200 });
      }
      if (url.includes('/draft_orders/1.json')) {
        return new Response(JSON.stringify(currentDraftOrder), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const res = await call(put('/pickup/complete', {
      draft_order_id: 1,
      changes: [{
        type: 'cost_price', line_item_id: 101, title: 'Roma Tomatoes',
        cost: '3.50', price: null, product_id: 501,
        inventory_item_id: 'gid://shopify/InventoryItem/2001',
        current_cost: '1.25', current_price: '5.00',
      }],
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.all_succeeded).toBe(false);
    expect(data.results[0].success).toBe(false);
    const completeCall = globalThis.fetch.mock.calls.find(([u]) => u.includes('/complete.json'));
    expect(completeCall).toBeUndefined();
  });

  it('partial failure: inventory item 4xx marks result failed, draft not completed', async () => {
    globalThis.fetch.mockImplementation(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (url.includes('/graphql.json') && body.query?.includes('metafieldsSet')) {
        return new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [{ id: 'mf1', key: 'cost_change_source' }], userErrors: [] } } }), { status: 200 });
      }
      if (url.includes('/inventory_items/') && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ errors: 'Not Found' }), { status: 404 });
      }
      if (url.includes('/draft_orders/1.json')) {
        return new Response(JSON.stringify(currentDraftOrder), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const res = await call(put('/pickup/complete', {
      draft_order_id: 1,
      changes: [{
        type: 'cost_price', line_item_id: 101, title: 'Roma Tomatoes',
        cost: '3.50', price: null, product_id: 501,
        inventory_item_id: 'gid://shopify/InventoryItem/2001',
        current_cost: '1.25', current_price: '5.00',
      }],
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.all_succeeded).toBe(false);
    expect(data.results[0].success).toBe(false);
    const completeCall = globalThis.fetch.mock.calls.find(([u]) => u.includes('/complete.json'));
    expect(completeCall).toBeUndefined();
  });

  it('no-change detection: skips API calls when cost and price match current values', async () => {
    mockFetch();
    const res = await call(put('/pickup/complete', {
      draft_order_id: 1,
      changes: [{
        type: 'cost_price',
        line_item_id: 101,
        title: 'Roma Tomatoes',
        cost: '1.25',          // same as current_cost
        price: '5.00',         // same as current_price
        product_id: 501,
        inventory_item_id: 'gid://shopify/InventoryItem/2001',
        current_cost: '1.25',
        current_price: '5.00',
      }],
    }));

    const data = await res.json();
    expect(data.all_succeeded).toBe(true);

    // no metafield or inventory calls
    const metafieldCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/graphql.json') && JSON.parse(o?.body || '{}').query?.includes('metafieldsSet')
    );
    expect(metafieldCall).toBeUndefined();

    const inventoryCall = globalThis.fetch.mock.calls.find(([u, o]) =>
      u.includes('/inventory_items/') && o?.method === 'PUT'
    );
    expect(inventoryCall).toBeUndefined();

    // draft order completed (no changes = proceed to complete)
    const completeCall = globalThis.fetch.mock.calls.find(([u]) => u.includes('/complete.json'));
    expect(completeCall).toBeDefined();
  });

  it('missing inventory_item_id: returns failure result without crashing', async () => {
    mockFetch();
    const res = await call(put('/pickup/complete', {
      draft_order_id: 1,
      changes: [{
        type: 'cost_price',
        line_item_id: 101,
        title: 'Roma Tomatoes',
        cost: '3.50',
        price: null,
        product_id: 501,
        inventory_item_id: null,   // missing
        current_cost: '1.25',
        current_price: '5.00',
      }],
    }));

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.all_succeeded).toBe(false);
    expect(data.results[0].success).toBe(false);
    expect(data.results[0].error).toContain('missing inventory_item_id');
  });

  it('two-item batch: one succeeds one fails — both result entries present, draft not completed', async () => {
    globalThis.fetch.mockImplementation(async (url, opts) => {
      const body = opts?.body ? JSON.parse(opts.body) : {};
      if (url.includes('/graphql.json') && body.query?.includes('metafieldsSet')) {
        // metafield for product 501 succeeds, product 502 fails
        const ownerId = body.variables?.metafields?.[0]?.ownerId || '';
        if (ownerId.includes('502')) {
          return new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [], userErrors: [{ field: 'ownerId', message: 'not found' }] } } }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: { metafieldsSet: { metafields: [{ id: 'mf1', key: 'cost_change_source' }], userErrors: [] } } }), { status: 200 });
      }
      if (url.includes('/inventory_items/') && opts?.method === 'PUT') {
        return new Response(JSON.stringify({ inventory_item: { id: 2001, cost: '3.50' } }), { status: 200 });
      }
      if (url.includes('/draft_orders/1.json')) {
        return new Response(JSON.stringify(currentDraftOrder), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });
    const res = await call(put('/pickup/complete', {
      draft_order_id: 1,
      changes: [
        {
          type: 'cost_price', line_item_id: 101, title: 'Roma Tomatoes',
          cost: '3.50', price: null, product_id: 501,
          inventory_item_id: 'gid://shopify/InventoryItem/2001',
          current_cost: '1.25', current_price: '5.00',
        },
        {
          type: 'cost_price', line_item_id: 102, title: 'Chicken Breast',
          cost: '8.00', price: null, product_id: 502,
          inventory_item_id: 'gid://shopify/InventoryItem/2002',
          current_cost: '6.00', current_price: '12.00',
        },
      ],
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.all_succeeded).toBe(false);
    expect(data.results).toHaveLength(2);
    const r101 = data.results.find(r => r.line_item_id === 101);
    const r102 = data.results.find(r => r.line_item_id === 102);
    expect(r101.success).toBe(true);
    expect(r102.success).toBe(false);
    const completeCall = globalThis.fetch.mock.calls.find(([u]) => u.includes('/complete.json'));
    expect(completeCall).toBeUndefined();
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
