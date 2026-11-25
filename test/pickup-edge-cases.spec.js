import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getPickupData,
  applyLineItemUpdate,
  updateLineItems,
  completeDraftOrder,
  markOrderDelivered,
} from '../src/pickup.js';

// Edge-case and failure coverage for pickup.js. Only fetch (external I/O) is mocked.

const BASE = 'https://shop.example/admin/api/2024-01';
const TOKEN = 't';

const res = (body, status = 200) => new Response(JSON.stringify(body), { status });

// Route table: [method, urlSubstring, responder]. First match wins; unmatched calls fail loudly.
function mockRoutes(routes) {
  globalThis.fetch.mockImplementation((url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    for (const [m, sub, responder] of routes) {
      if (m === method && url.includes(sub)) {
        return Promise.resolve(typeof responder === 'function' ? responder(url, opts) : responder());
      }
    }
    return Promise.reject(new Error(`unmocked ${method} ${url}`));
  });
}

const gqlBody = (opts) => JSON.parse(opts.body);
const callsTo = (sub, method) =>
  globalThis.fetch.mock.calls.filter(([u, o]) => u.includes(sub) && (!method || (o?.method || 'GET') === method));

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

// ── applyLineItemUpdate (pure) ───────────────────────────────────────────────

describe('applyLineItemUpdate', () => {
  const item = { id: 1, quantity: 3, price: '2.50', properties: [{ name: 'Note', value: 'x' }] };

  it('given no update, returns the line item untouched', () => {
    expect(applyLineItemUpdate(item, undefined)).toBe(item);
  });

  it('given type "found", returns the line item untouched', () => {
    expect(applyLineItemUpdate(item, { type: 'found' })).toBe(item);
  });

  it('given an unknown type, falls through to untouched rather than throwing', () => {
    expect(applyLineItemUpdate(item, { type: 'cost_price' })).toBe(item);
  });

  it('given "remove", returns null', () => {
    expect(applyLineItemUpdate(item, { type: 'remove' })).toBeNull();
  });

  it('given a weight update with no unit_price, prices from the existing line price', () => {
    const out = applyLineItemUpdate(item, { type: 'weight', weights: ['1.5', '2'] });
    expect(out.price).toBe('8.75'); // 3.5 lb × 2.50
    expect(out.quantity).toBe(1);
  });

  it('given a weight update, keeps existing properties and appends weight + breakdown', () => {
    const out = applyLineItemUpdate(item, { type: 'weight', weights: [2], unit_price: 4 });
    expect(out.properties.map(p => p.name)).toEqual(['Note', 'Weight (lb)', 'Price Breakdown']);
    expect(out.properties[1].value).toBe('2');
    expect(out.properties[2].value).toBe('$4.00/lb × 2 lb = $8.00');
  });

  it('given a weight update with no weights, produces a zero price instead of NaN', () => {
    const out = applyLineItemUpdate(item, { type: 'weight' });
    expect(out.price).toBe('0.00');
  });

  it('given a weight update on an item with no properties, still adds the weight properties', () => {
    const out = applyLineItemUpdate({ id: 2, price: '1.00' }, { type: 'weight', weights: [1] });
    expect(out.properties).toHaveLength(2);
  });
});

// ── getPickupData ────────────────────────────────────────────────────────────

describe('getPickupData — edge cases', () => {
  const tagged = (over = {}) => ({
    id: 1, name: '#D1', tags: 'draft-order-tab', created_at: '2026-01-01T00:00:00Z', line_items: [], ...over,
  });

  it('given invoice_sent drafts tagged draft-order-tab, includes them alongside open ones', async () => {
    mockRoutes([
      ['GET', 'status=open', () => res({ draft_orders: [tagged({ id: 1 })] })],
      ['GET', 'status=invoice_sent', () => res({ draft_orders: [tagged({ id: 2, name: '#D2' })] })],
      ['GET', '/orders.json', () => res({ orders: [] })],
    ]);
    const out = await getPickupData(BASE, TOKEN);
    expect(out.map(o => o.id).sort()).toEqual([1, 2]);
  });

  it('given a draft with undefined tags, excludes it instead of throwing', async () => {
    mockRoutes([
      ['GET', 'status=open', () => res({ draft_orders: [tagged({ tags: undefined })] })],
      ['GET', 'status=invoice_sent', () => res({})],
      ['GET', '/orders.json', () => res({})],
    ]);
    expect(await getPickupData(BASE, TOKEN)).toEqual([]);
  });

  it('given Shopify rejects the open-drafts request, throws an error carrying the Shopify status and message', async () => {
    // Fresh Response per call: a shared Response body can only be read once and would fail for the wrong reason.
    mockRoutes([
      ['GET', 'status=open', () => res({ errors: 'Invalid API key' }, 401)],
      ['GET', 'status=invoice_sent', () => res({ draft_orders: [] })],
      ['GET', '/orders.json', () => res({ orders: [] })],
    ]);
    await expect(getPickupData(BASE, TOKEN)).rejects.toMatchObject({
      status: 401,
      message: JSON.stringify('Invalid API key'),
    });
  });

  it('given neither shipping address nor customer, returns an empty customer_name', async () => {
    mockRoutes([
      ['GET', 'status=open', () => res({ draft_orders: [tagged()] })],
      ['GET', 'status=invoice_sent', () => res({ draft_orders: [] })],
      ['GET', '/orders.json', () => res({ orders: [] })],
    ]);
    const [order] = await getPickupData(BASE, TOKEN);
    expect(order.customer_name).toBe('');
  });

  it('given a line item whose variant has no cost data, returns cost and inventory_item_id as null', async () => {
    mockRoutes([
      ['GET', 'status=open', () => res({ draft_orders: [tagged({
        line_items: [{ id: 5, title: 'X', quantity: 1, price: '1', product_id: 9, variant_id: 77 }],
      })] })],
      ['GET', 'status=invoice_sent', () => res({ draft_orders: [] })],
      ['GET', '/orders.json', () => res({ orders: [] })],
      ['POST', '/graphql.json', () => res({ data: { nodes: [{
        id: 'gid://shopify/Product/9', tags: ['Weight'],
        variants: { edges: [{ node: { id: 'gid://shopify/ProductVariant/77', inventoryItem: null } }] },
      }] } })],
    ]);
    const [order] = await getPickupData(BASE, TOKEN);
    expect(order.line_items[0]).toMatchObject({ cost: null, inventory_item_id: null, has_weight_tag: true });
  });

  it('given the GraphQL enrichment returns nothing usable, still returns the orders with null enrichment', async () => {
    mockRoutes([
      ['GET', 'status=open', () => res({ draft_orders: [tagged({
        line_items: [{ id: 5, title: 'X', quantity: 1, price: '1', product_id: 9, variant_id: 77 }],
      })] })],
      ['GET', 'status=invoice_sent', () => res({ draft_orders: [] })],
      ['GET', '/orders.json', () => res({ orders: [] })],
      ['POST', '/graphql.json', () => res({ errors: 'throttled' })],
    ]);
    const [order] = await getPickupData(BASE, TOKEN);
    expect(order.line_items[0]).toMatchObject({ cost: null, has_weight_tag: false });
  });

  it('given a draft with no line_items key, returns an empty line_items array', async () => {
    mockRoutes([
      ['GET', 'status=open', () => res({ draft_orders: [{ id: 1, name: '#D1', tags: 'draft-order-tab' }] })],
      ['GET', 'status=invoice_sent', () => res({ draft_orders: [] })],
      ['GET', '/orders.json', () => res({ orders: [] })],
    ]);
    const [order] = await getPickupData(BASE, TOKEN);
    expect(order.line_items).toEqual([]);
  });

  it('given sourced orders with missing optional fields, defaults variant_title and properties', async () => {
    mockRoutes([
      ['GET', 'status=open', () => res({ draft_orders: [] })],
      ['GET', 'status=invoice_sent', () => res({ draft_orders: [] })],
      ['GET', '/orders.json', () => res({ orders: [{ id: 3, name: '#1003', created_at: '2026-01-02T00:00:00Z',
        customer: { first_name: 'Ann', last_name: 'Lee' },
        line_items: [{ id: 1, title: 'Rice', quantity: 1, price: '5' }] }] })],
    ]);
    const [order] = await getPickupData(BASE, TOKEN);
    expect(order).toMatchObject({ status: 'sourced', customer_name: 'Ann Lee' });
    expect(order.line_items[0]).toMatchObject({ variant_title: null, properties: [] });
  });

  it('given open and sourced orders, sorts newest first', async () => {
    mockRoutes([
      ['GET', 'status=open', () => res({ draft_orders: [tagged({ id: 1, created_at: '2026-01-01T00:00:00Z' })] })],
      ['GET', 'status=invoice_sent', () => res({ draft_orders: [] })],
      ['GET', '/orders.json', () => res({ orders: [{ id: 2, created_at: '2026-03-01T00:00:00Z' }] })],
    ]);
    const out = await getPickupData(BASE, TOKEN);
    expect(out.map(o => o.id)).toEqual([2, 1]);
  });
});

// ── updateLineItems ──────────────────────────────────────────────────────────

describe('updateLineItems — failures', () => {
  it('given the initial GET fails, returns the Shopify status and never PUTs', async () => {
    mockRoutes([['GET', '/draft_orders/1.json', () => res({ errors: 'Not Found' }, 404)]]);
    const out = await updateLineItems(BASE, TOKEN, 1, []);
    expect(out.status).toBe(404);
    expect(out.body.error).toBe('shopify_error');
    expect(callsTo('/draft_orders/1.json', 'PUT')).toHaveLength(0);
  });

  it('given the PUT fails, returns the Shopify status and error', async () => {
    mockRoutes([
      ['GET', '/draft_orders/1.json', () => res({ draft_order: { line_items: [{ id: 1, quantity: 1, price: '1' }] } })],
      ['PUT', '/draft_orders/1.json', () => res({ errors: 'locked' }, 422)],
    ]);
    const out = await updateLineItems(BASE, TOKEN, 1, [{ line_item_id: 1, type: 'remove' }]);
    expect(out.status).toBe(422);
    expect(out.body.message).toContain('locked');
  });

  it('given an update for a line item that does not exist, ignores it and leaves others as-is', async () => {
    mockRoutes([
      ['GET', '/draft_orders/1.json', () => res({ draft_order: { line_items: [{ id: 1, quantity: 2, price: '1' }] } })],
      ['PUT', '/draft_orders/1.json', (_u, o) => res({ sent: JSON.parse(o.body) })],
    ]);
    const out = await updateLineItems(BASE, TOKEN, 1, [{ line_item_id: 999, type: 'remove' }]);
    expect(out.status).toBe(200);
    expect(out.body.sent.draft_order.line_items).toEqual([{ id: 1, quantity: 2, price: '1' }]);
  });

  it('given a draft order with no line_items, sends an empty list', async () => {
    mockRoutes([
      ['GET', '/draft_orders/1.json', () => res({ draft_order: {} })],
      ['PUT', '/draft_orders/1.json', (_u, o) => res({ sent: JSON.parse(o.body) })],
    ]);
    const out = await updateLineItems(BASE, TOKEN, 1, []);
    expect(out.body.sent.draft_order.line_items).toEqual([]);
  });
});

// ── completeDraftOrder ───────────────────────────────────────────────────────

describe('completeDraftOrder — failures and edge cases', () => {
  const li = (over = {}) => ({ id: 10, title: 'Item', quantity: 1, price: '2.00', ...over });
  const draftGet = (items) => ['GET', '/draft_orders/5.json', () => res({ draft_order: { line_items: items } })];
  const completeOk = ['PUT', '/draft_orders/5/complete.json', () => res({ draft_order: { id: 5 } })];
  const gqlOrderLookup = (legacy) => ['POST', '/graphql.json', (_u, o) => {
    const q = gqlBody(o).query;
    if (q.includes('draftOrder(id')) return res({ data: { draftOrder: { order: legacy ? { legacyResourceId: legacy } : null } } });
    return res({ data: { draftOrderUpdate: { userErrors: [] } } });
  }];

  it('given no changes and Shopify refuses completion, passes the Shopify status through', async () => {
    mockRoutes([['PUT', '/draft_orders/5/complete.json', () => res({ errors: 'already completed' }, 422)]]);
    const out = await completeDraftOrder(BASE, TOKEN, 5);
    expect(out.status).toBe(422);
    expect(out.body.error).toBe('shopify_error');
    expect(out.body.message).toContain('already completed');
  });

  it('given the completed draft has no linked order, succeeds without order_id and does not tag anything', async () => {
    mockRoutes([completeOk, gqlOrderLookup(null)]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, []);
    expect(out.status).toBe(200);
    expect(out.body.all_succeeded).toBe(true);
    expect(out.body).not.toHaveProperty('order_id');
    expect(callsTo('/orders/')).toHaveLength(0);
  });

  it('given the resulting order has no tags yet, adds "sourced" as the only tag', async () => {
    mockRoutes([
      completeOk, gqlOrderLookup('900'),
      ['GET', '/orders/900.json', () => res({ order: { name: '#1900' } })],
      ['PUT', '/orders/900.json', () => res({})],
    ]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, []);
    expect(out.body).toMatchObject({ order_id: '900', order_name: '#1900' });
    const put = callsTo('/orders/900.json', 'PUT')[0][1];
    expect(JSON.parse(put.body).order.tags).toBe('sourced');
  });

  it('given the order GET returns nothing useful, reports order_name as null', async () => {
    mockRoutes([
      completeOk, gqlOrderLookup('900'),
      ['GET', '/orders/900.json', () => res({})],
      ['PUT', '/orders/900.json', () => res({})],
    ]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, []);
    expect(out.body.order_name).toBeNull();
  });

  it('given the draft-order GET fails during a merge, marks the changed item failed and does not complete', async () => {
    mockRoutes([['GET', '/draft_orders/5.json', () => res({ errors: 'boom' }, 500)]]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, [{ type: 'remove', line_item_id: 10, title: 'Item' }]);
    expect(out.body.all_succeeded).toBe(false);
    expect(out.body.results[0]).toMatchObject({ line_item_id: 10, success: false });
    expect(callsTo('/complete.json')).toHaveLength(0);
  });

  it('given Shopify rejects draftOrderUpdate with userErrors, fails the item and does not complete', async () => {
    mockRoutes([
      draftGet([li()]),
      ['POST', '/graphql.json', () => res({ data: { draftOrderUpdate: { userErrors: [{ message: 'Invalid quantity' }] } } })],
    ]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, [{ type: 'partial', line_item_id: 10, title: 'Item', quantity: 0 }]);
    expect(out.body.all_succeeded).toBe(false);
    expect(out.body.results[0].error).toBe('Invalid quantity');
    expect(callsTo('/complete.json')).toHaveLength(0);
  });

  it('given draftOrderUpdate returns a non-ok response with no userErrors, fails the item with the raw errors', async () => {
    mockRoutes([
      draftGet([li()]),
      ['POST', '/graphql.json', () => res({ errors: 'internal' }, 500)],
    ]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, [{ type: 'partial', line_item_id: 10, title: 'Item', quantity: 2 }]);
    expect(out.body.all_succeeded).toBe(false);
    expect(out.body.results[0].error).toContain('internal');
  });

  it('given the merge request throws, fails the item with the thrown message', async () => {
    mockRoutes([['GET', '/draft_orders/5.json', () => { throw new Error('socket hang up'); }]]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, [{ type: 'remove', line_item_id: 10, title: 'Item' }]);
    expect(out.body.results[0]).toMatchObject({ success: false, error: 'socket hang up' });
  });

  it('given a custom line item (no variant_id), sends title and originalUnitPrice instead of a variant override', async () => {
    mockRoutes([
      draftGet([li({ requires_shipping: false })]),
      completeOk, gqlOrderLookup(null),
    ]);
    await completeDraftOrder(BASE, TOKEN, 5, [{ type: 'partial', line_item_id: 10, title: 'Item', quantity: 4 }]);
    const update = callsTo('/graphql.json', 'POST').map(([, o]) => gqlBody(o)).find(b => b.query.includes('draftOrderUpdate'));
    const input = update.variables.input.lineItems[0];
    expect(input).toMatchObject({ title: 'Item', requiresShipping: false, originalUnitPrice: '2.00', quantity: 4 });
    expect(input).not.toHaveProperty('variantId');
  });

  it('given a variant line item, sends a priceOverride and carries properties as customAttributes', async () => {
    mockRoutes([
      draftGet([li({ variant_id: 77, properties: [{ name: 'Weight (lb)', value: '2' }] })]),
      completeOk, gqlOrderLookup(null),
    ]);
    await completeDraftOrder(BASE, TOKEN, 5, [{ type: 'found', line_item_id: 10, title: 'Item' }]);
    const update = callsTo('/graphql.json', 'POST').map(([, o]) => gqlBody(o)).find(b => b.query.includes('draftOrderUpdate'));
    const input = update.variables.input.lineItems[0];
    expect(input.variantId).toBe('gid://shopify/ProductVariant/77');
    expect(input.priceOverride).toEqual({ amount: '2.00', currencyCode: 'USD' });
    expect(input.customAttributes).toEqual([{ key: 'Weight (lb)', value: '2' }]);
  });

  it('given a removed item that also has a price change, the item stays removed', async () => {
    mockRoutes([
      draftGet([li({ id: 10, variant_id: 77 }), li({ id: 11, title: 'Keep', variant_id: 78 })]),
      ['PUT', '/variants/77.json', () => res({})],
      completeOk, gqlOrderLookup(null),
    ]);
    await completeDraftOrder(BASE, TOKEN, 5, [
      { type: 'remove', line_item_id: 10, title: 'Item' },
      { type: 'cost_price', line_item_id: 10, title: 'Item', variant_id: 77, price: '9.00', current_price: '2.00' },
    ]);
    const update = callsTo('/graphql.json', 'POST').map(([, o]) => gqlBody(o)).find(b => b.query.includes('draftOrderUpdate'));
    expect(update.variables.input.lineItems).toHaveLength(1);
    expect(update.variables.input.lineItems[0].variantId).toContain('/78');
  });

  it('given a price-only change whose variant update fails, marks the item failed and does not complete', async () => {
    mockRoutes([['PUT', '/variants/77.json', () => res({ errors: 'locked' }, 422)]]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, [
      { type: 'cost_price', line_item_id: 10, title: 'Item', variant_id: 77, price: '9.00', current_price: '2.00' },
    ]);
    expect(out.body.all_succeeded).toBe(false);
    expect(out.body.results[0]).toMatchObject({ line_item_id: 10, success: false });
    expect(out.body.results[0].error).toContain('locked');
  });

  it('given a cost+price change where the cost step succeeds but the variant price update fails, marks it failed', async () => {
    mockRoutes([
      ['POST', '/graphql.json', () => res({ data: { metafieldsSet: { userErrors: [] } } })],
      ['PUT', '/inventory_items/2001.json', () => res({})],
      ['PUT', '/variants/77.json', () => res({ errors: 'variant locked' }, 422)],
    ]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, [{
      type: 'cost_price', line_item_id: 10, title: 'Item', product_id: 9, variant_id: 77,
      inventory_item_id: 'gid://shopify/InventoryItem/2001',
      cost: '1.00', current_cost: '0.50', price: '3.00', current_price: '2.00',
    }]);
    expect(out.body.all_succeeded).toBe(false);
    expect(out.body.results[0].error).toContain('variant locked');
    expect(callsTo('/complete.json')).toHaveLength(0);
  });

  it('given a cost+price change where everything succeeds, updates variant price and merges the new price into the draft', async () => {
    mockRoutes([
      draftGet([li({ variant_id: 77 })]),
      ['PUT', '/inventory_items/2001.json', () => res({})],
      ['PUT', '/variants/77.json', () => res({})],
      completeOk,
      ['POST', '/graphql.json', (_u, o) => {
        const q = gqlBody(o).query;
        if (q.includes('metafieldsSet')) return res({ data: { metafieldsSet: { userErrors: [] } } });
        if (q.includes('draftOrderUpdate')) return res({ data: { draftOrderUpdate: { userErrors: [] } } });
        return res({ data: { draftOrder: { order: null } } });
      }],
    ]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, [{
      type: 'cost_price', line_item_id: 10, title: 'Item', product_id: 9, variant_id: 77,
      inventory_item_id: 'gid://shopify/InventoryItem/2001',
      cost: '1.00', current_cost: '0.50', price: '3.00', current_price: '2.00',
    }]);
    expect(out.body.all_succeeded).toBe(true);
    expect(callsTo('/variants/77.json', 'PUT')).toHaveLength(1);
    const update = callsTo('/graphql.json', 'POST').map(([, o]) => gqlBody(o)).find(b => b.query.includes('draftOrderUpdate'));
    expect(update.variables.input.lineItems[0].priceOverride.amount).toBe('3.00');
  });

  it('given a cost+price change with no variant_id, skips the variant update but still records the cost', async () => {
    mockRoutes([
      draftGet([li()]),
      ['PUT', '/inventory_items/2001.json', () => res({})],
      completeOk,
      ['POST', '/graphql.json', (_u, o) => {
        const q = gqlBody(o).query;
        if (q.includes('metafieldsSet')) return res({ data: { metafieldsSet: { userErrors: [] } } });
        if (q.includes('draftOrderUpdate')) return res({ data: { draftOrderUpdate: { userErrors: [] } } });
        return res({ data: { draftOrder: { order: null } } });
      }],
    ]);
    const out = await completeDraftOrder(BASE, TOKEN, 5, [{
      type: 'cost_price', line_item_id: 10, title: 'Item', product_id: 9,
      inventory_item_id: 'gid://shopify/InventoryItem/2001',
      cost: '1.00', current_cost: '0.50', price: '3.00', current_price: '2.00',
    }]);
    expect(out.body.all_succeeded).toBe(true);
    expect(callsTo('/variants/')).toHaveLength(0);
    expect(callsTo('/inventory_items/2001.json', 'PUT')).toHaveLength(1);
  });

  it('given a weight resolution plus a price change on the same item, the weight price wins over the price override', async () => {
    mockRoutes([
      draftGet([li({ variant_id: 77, price: '2.00' })]),
      ['PUT', '/variants/77.json', () => res({})],
      completeOk, gqlOrderLookup(null),
    ]);
    await completeDraftOrder(BASE, TOKEN, 5, [
      { type: 'weight', line_item_id: 10, title: 'Item', weights: [2], unit_price: 5 },
      { type: 'cost_price', line_item_id: 10, title: 'Item', variant_id: 77, price: '9.00', current_price: '2.00' },
    ]);
    const update = callsTo('/graphql.json', 'POST').map(([, o]) => gqlBody(o)).find(b => b.query.includes('draftOrderUpdate'));
    expect(update.variables.input.lineItems[0].priceOverride.amount).toBe('10.00');
  });
});

// ── markOrderDelivered ───────────────────────────────────────────────────────

describe('markOrderDelivered — failures', () => {
  it('given the tag PUT fails, throws with the Shopify error', async () => {
    mockRoutes([
      ['GET', '/orders/7.json', () => res({ order: { tags: 'sourced' } })],
      ['PUT', '/orders/7.json', () => res({ errors: 'locked' }, 422)],
    ]);
    await expect(markOrderDelivered(BASE, TOKEN, 7)).rejects.toThrow('locked');
  });

  it('given the order has no tags at all, tags it delivered', async () => {
    mockRoutes([
      ['GET', '/orders/7.json', () => res({ order: {} })],
      ['PUT', '/orders/7.json', (_u, o) => res({ sent: JSON.parse(o.body) })],
    ]);
    await markOrderDelivered(BASE, TOKEN, 7);
    expect(JSON.parse(callsTo('/orders/7.json', 'PUT')[0][1].body).order.tags).toBe('delivered');
  });
});
