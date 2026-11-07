import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src';

// Sad-path and error-handling coverage for the routes the other specs only
// exercise on the happy path. External I/O (fetch) is the only thing mocked.

const WEBHOOK_SECRET = 'test-webhook-secret';

async function call(request, mockEnv = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    request,
    { ...env, SHOPIFY_TOKEN: 'test-token', SHOPIFY_WEBHOOK_SECRET: WEBHOOK_SECRET, ...mockEnv },
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function signHmac(rawBody, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status });

const putJson = (path, body) =>
  new Request(`http://example.com${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const postJson = (path, body) =>
  new Request(`http://example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

// ── Routing ──────────────────────────────────────────────────────────────────

describe('unmatched requests', () => {
  it('given an unsupported method, returns 405 without calling Shopify', async () => {
    const res = await call(new Request('http://example.com/', { method: 'DELETE' }));
    expect(res.status).toBe(405);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ── GET /?action=check-phone ─────────────────────────────────────────────────

describe('GET /?action=check-phone', () => {
  const req = (qs = '') => new Request(`http://example.com/?action=check-phone${qs}`);

  it('given no phone param, returns 400 without calling Shopify', async () => {
    const res = await call(req());
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('given a phone that exists on a customer, returns taken: true', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ data: { customers: { edges: [{ node: { id: 'gid://shopify/Customer/1' } }] } } }));
    const res = await call(req('&phone=555-1234'));
    expect(await res.json()).toEqual({ taken: true });
    const body = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(body.variables.q).toBe('phone:555-1234');
  });

  it('given a phone nobody uses, returns taken: false', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ data: { customers: { edges: [] } } }));
    const res = await call(req('&phone=555-1234'));
    expect(await res.json()).toEqual({ taken: false });
  });

  it('given an unexpected Shopify response shape, returns taken: false rather than throwing', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ errors: 'throttled' }));
    const res = await call(req('&phone=555-1234'));
    expect(await res.json()).toEqual({ taken: false });
  });
});

// ── POST /webhook/cost-update ────────────────────────────────────────────────

describe('POST /webhook/cost-update — malformed payloads', () => {
  it('given a validly signed but non-JSON body, returns 400 and does not reach the handler', async () => {
    const raw = 'not json';
    const res = await call(new Request('http://example.com/webhook/cost-update', {
      method: 'POST',
      headers: { 'X-Shopify-Hmac-Sha256': await signHmac(raw, WEBHOOK_SECRET) },
      body: raw,
    }));
    expect(res.status).toBe(400);
  });

  it('given the Durable Object binding throws, returns 500', async () => {
    const raw = JSON.stringify({ id: 1, cost: '2.00' });
    const res = await call(
      new Request('http://example.com/webhook/cost-update', {
        method: 'POST',
        headers: { 'X-Shopify-Hmac-Sha256': await signHmac(raw, WEBHOOK_SECRET) },
        body: raw,
      }),
      { COST_CHANGE_HANDLER: { idFromName: () => { throw new Error('DO unavailable'); } } }
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('DO unavailable');
  });
});

// ── GET /?id= and PUT /?action=complete ──────────────────────────────────────

describe('GET /?id= — failures', () => {
  it('given Shopify is unreachable, returns 500', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const res = await call(new Request('http://example.com/?id=1'));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('network down');
  });

  it('given Shopify returns 404, passes the status through', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ errors: 'Not Found' }, 404));
    const res = await call(new Request('http://example.com/?id=999'));
    expect(res.status).toBe(404);
  });
});

describe('PUT /?id=&action=complete', () => {
  const req = (qs) => new Request(`http://example.com/?action=complete${qs}`, { method: 'PUT' });

  it('given no id, returns 400 without calling Shopify', async () => {
    const res = await call(req(''));
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('given Shopify is unreachable, returns 500', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const res = await call(req('&id=5'));
    expect(res.status).toBe(500);
  });

  it('given Shopify rejects the completion, passes the status and body through', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ errors: 'already completed' }, 422));
    const res = await call(req('&id=5'));
    expect(res.status).toBe(422);
    expect((await res.json()).errors).toBe('already completed');
  });

  it('given a valid id, completes the draft order via PUT', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ draft_order: { id: 5, status: 'completed' } }));
    const res = await call(req('&id=5'));
    expect(res.status).toBe(200);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('/draft_orders/5/complete.json');
    expect(opts.method).toBe('PUT');
  });
});

// ── POST /?action=add-address ────────────────────────────────────────────────

describe('POST /?action=add-address', () => {
  const path = '/?action=add-address';
  const address = { address1: '1 Main St', city: 'LA', province: 'CA', zip: '90001' };

  it.each([
    ['customerId missing', { address }],
    ['address missing', { customerId: 1 }],
    ['address1 missing', { customerId: 1, address: { city: 'LA' } }],
  ])('given %s, returns 400 without calling Shopify', async (_label, body) => {
    const res = await call(postJson(path, body));
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('given a malformed JSON body, returns 500 instead of crashing', async () => {
    const res = await call(postJson(path, '{oops'));
    expect(res.status).toBe(500);
  });

  it('given Shopify returns userErrors, returns 422 with the first message', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({
      data: { customerUpdate: { customer: null, userErrors: [{ field: ['addresses'], message: 'Zip is invalid' }] } },
    }));
    const res = await call(postJson(path, { customerId: 1, address }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Zip is invalid');
  });

  it('given Shopify is unreachable, returns 500', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const res = await call(postJson(path, { customerId: 1, address }));
    expect(res.status).toBe(500);
  });

  it('given a valid address, sends it to the right customer and returns success', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({
      data: { customerUpdate: { customer: { id: 'gid://shopify/Customer/42' }, userErrors: [] } },
    }));
    const res = await call(postJson(path, { customerId: 42, address }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.variables.input.id).toBe('gid://shopify/Customer/42');
    expect(sent.variables.input.addresses[0].address1).toBe('1 Main St');
  });
});

// ── POST /?action=signup — validation ────────────────────────────────────────

describe('POST /?action=signup — validation', () => {
  const full = {
    first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '555-1234',
    restaurant_name: 'Joe Cafe', restaurant_phone: '555-9999',
    business_type: 'restaurant', business_subtype: 'casual',
    emergency_name: 'Bob', emergency_phone: '555-0000', ordering_method: ['online'],
    address: { address1: '1 Main St', city: 'LA', province: 'CA', zip: '90001' },
  };

  it('given a non-JSON body, returns 400 validation error', async () => {
    const res = await call(postJson('/?action=signup', '{oops'));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Invalid JSON body');
  });

  it.each([
    'first_name', 'last_name', 'phone', 'restaurant_name', 'restaurant_phone',
    'business_type', 'business_subtype', 'emergency_name', 'emergency_phone',
  ])('given %s is missing, names it in the 400 message and does not call Shopify', async (field) => {
    const { [field]: _omit, ...body } = full;
    const res = await call(postJson('/?action=signup', body));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain(field);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('given an empty ordering_method array, returns 400', async () => {
    const res = await call(postJson('/?action=signup', { ...full, ordering_method: [] }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('ordering_method');
  });

  it.each(['address1', 'city', 'zip'])('given address.%s is missing, returns 400', async (field) => {
    const address = { ...full.address };
    delete address[field];
    const res = await call(postJson('/?action=signup', { ...full, address }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain(`address.${field}`);
  });
});

// ── POST /?action=activate-membership — error paths ──────────────────────────

describe('POST /?action=activate-membership — error paths', () => {
  const full = {
    customer_id: 5001,
    first_name: 'Jane', last_name: 'Doe',
    restaurant_name: 'Joe Cafe', restaurant_phone: '555-9999',
    business_type: 'restaurant', business_subtype: 'casual',
    emergency_name: 'Bob', emergency_phone: '555-0000', ordering_method: ['online'],
    address: { address1: '1 Main St', city: 'LA', province: 'CA', zip: '90001' },
  };
  const path = '/?action=activate-membership';
  const updateOk = jsonRes({ data: { customerUpdate: { customer: { id: 'x' }, userErrors: [] } } });

  it('given a non-JSON body, returns 400', async () => {
    const res = await call(postJson(path, '{oops'));
    expect(res.status).toBe(400);
  });

  it.each([
    'first_name', 'last_name', 'restaurant_name', 'restaurant_phone',
    'business_type', 'business_subtype', 'emergency_name', 'emergency_phone',
  ])('given %s is missing, returns 400 naming it and never fetches the customer', async (field) => {
    const { [field]: _omit, ...body } = full;
    const res = await call(postJson(path, body));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain(field);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('given an empty ordering_method, returns 400', async () => {
    const res = await call(postJson(path, { ...full, ordering_method: [] }));
    expect(res.status).toBe(400);
  });

  it.each(['address1', 'city', 'province', 'zip'])('given address.%s is missing, returns 400', async (field) => {
    const address = { ...full.address };
    delete address[field];
    const res = await call(postJson(path, { ...full, address }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain(`address.${field}`);
  });

  it('given customerUpdate returns userErrors, returns 422 and skips address creation', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(jsonRes({ customer: { id: 5001, note: null } }))
      .mockResolvedValueOnce(jsonRes({ data: { customerUpdate: { customer: null, userErrors: [{ field: ['tags'], message: 'Bad tag' }] } } }));
    const res = await call(postJson(path, full));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Bad tag');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('given the phone is already taken, retries without the phone and reports phone_skipped', async () => {
    globalThis.fetch
      .mockResolvedValueOnce(jsonRes({ customer: { id: 5001, note: null } }))
      .mockResolvedValueOnce(jsonRes({ data: { customerUpdate: { customer: null, userErrors: [{ field: ['phone'], message: 'Phone has already been taken' }] } } }))
      .mockResolvedValue(updateOk);
    const res = await call(postJson(path, { ...full, phone: '555-1234' }));
    expect(res.status).toBe(200);
    expect((await res.json()).phone_skipped).toBe(true);
    const retryInput = JSON.parse(globalThis.fetch.mock.calls[2][1].body).variables.input;
    expect(retryInput).not.toHaveProperty('phone');
    expect(retryInput.tags).toEqual(['member']);
  });

  it('given Shopify is unreachable, returns 500', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const res = await call(postJson(path, full));
    expect(res.status).toBe(500);
  });
});

// ── /pickup/* — failure handling ─────────────────────────────────────────────

describe('PUT /pickup/update — failure handling', () => {
  it('given a non-JSON body, returns 500 rather than crashing', async () => {
    const res = await call(putJson('/pickup/update', '{oops'));
    expect(res.status).toBe(500);
  });

  it('given updates is not an array, returns 400 without calling Shopify', async () => {
    const res = await call(putJson('/pickup/update', { draft_order_id: 1, updates: 'nope' }));
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('PUT /pickup/complete — failure handling', () => {
  it('given a non-JSON body, returns 500 rather than crashing', async () => {
    const res = await call(putJson('/pickup/complete', '{oops'));
    expect(res.status).toBe(500);
  });

  it('given Shopify is unreachable, returns 500 and the draft is not reported complete', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const res = await call(putJson('/pickup/complete', { draft_order_id: 7 }));
    expect(res.status).toBe(500);
  });
});

describe('PUT /pickup/deliver — failure handling', () => {
  it('given a non-JSON body, returns 500 rather than crashing', async () => {
    const res = await call(putJson('/pickup/deliver', '{oops'));
    expect(res.status).toBe(500);
  });
});

describe('GET /pickup/data — unreachable Shopify', () => {
  it('returns 500 when a Shopify request rejects', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const res = await call(new Request('http://example.com/pickup/data'));
    expect(res.status).toBe(500);
  });
});

// ── GET /invoice/:id ─────────────────────────────────────────────────────────

describe('GET /invoice/:id — failures', () => {
  it('given an empty order id, returns 400 without calling Shopify', async () => {
    const res = await call(new Request('http://example.com/invoice/'));
    expect(res.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('given Shopify is unreachable, returns 500', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const res = await call(new Request('http://example.com/invoice/123'));
    expect(res.status).toBe(500);
  });
});

// ── POST / — draft order creation failures ───────────────────────────────────

describe('POST / — failures', () => {
  const cart = {
    items: [{ variantId: 1, quantity: 1 }],
    customerEmail: 'a@b.com',
  };

  it('given Shopify is unreachable, returns 500 and sends no invoice', async () => {
    globalThis.fetch.mockRejectedValue(new Error('network down'));
    const res = await call(postJson('/', cart));
    expect(res.status).toBe(500);
  });
});
