import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCtx() {
  return createExecutionContext();
}

async function call(request, mockEnv = {}) {
  const ctx = makeCtx();
  const res = await worker.fetch(request, { SHOPIFY_TOKEN: 'test-token', ...mockEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

// ── CORS preflight ────────────────────────────────────────────────────────────

describe('OPTIONS preflight', () => {
  it('returns 200 with CORS headers', async () => {
    const res = await call(new Request('http://example.com/', { method: 'OPTIONS' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

// ── GET /?id= ─────────────────────────────────────────────────────────────────

describe('GET /?id=', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  it('returns 400 when id is missing', async () => {
    const res = await call(new Request('http://example.com/'));
    expect(res.status).toBe(400);
  });

  it('proxies the draft order response', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({ draft_order: { id: 42 } }), { status: 200 })
    );

    const res = await call(new Request('http://example.com/?id=42'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.draft_order.id).toBe(42);
  });
});

// ── POST / ────────────────────────────────────────────────────────────────────

describe('POST /', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  const mockDraftOrder = {
    id: 99,
    name: '#D99',
    email: 'buyer@example.com',
    created_at: '2026-06-26T10:00:00Z',
    shipping_address: {
      first_name: 'Mei', last_name: 'Chen',
      address1: '188 S Valley Blvd', address2: 'Suite 200',
      city: 'San Gabriel', province: 'CA', country: 'US', zip: '91776',
      phone: '',
    },
    line_items: [{ title: 'Roma Tomatoes', variant_title: 'Jumbo', quantity: 2, price: '87.27' }],
    subtotal_price: '174.54',
    total_price: '174.54',
    total_tax: '0.00',
    shipping_line: null,
    note: '',
    tags: 'draft-order',
  };

  const baseCart = {
    items: [{ variant_id: 1, quantity: 2 }],
    email: 'buyer@example.com',
    customerId: '123',
    address: {
      first_name: 'Mei', last_name: 'Chen',
      address1: '188 S Valley Blvd', address2: 'Suite 200',
      city: 'San Gabriel', province: 'CA', country: 'US', zip: '91776',
    },
    tags: 'draft-order',
  };

  function mockFetch(draftOrder = mockDraftOrder, shopifyStatus = 201, invoiceOk = true) {
    globalThis.fetch.mockImplementation((url) => {
      if (url.includes('/send_invoice.json')) {
        return Promise.resolve(new Response(JSON.stringify({ draft_order_invoice: {} }), { status: invoiceOk ? 200 : 500 }));
      }
      // Shopify create draft order call
      return Promise.resolve(
        new Response(JSON.stringify({ draft_order: draftOrder }), { status: shopifyStatus })
      );
    });
  }

  it('builds draft_order with full shipping address', async () => {
    mockFetch();

    const res = await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseCart),
      })
    );

    expect(res.status).toBe(201);
    const [fetchUrl, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.draft_order.shipping_address).toMatchObject({
      first_name: 'Mei', last_name: 'Chen',
      address1: '188 S Valley Blvd', city: 'San Gabriel',
      province: 'CA', zip: '91776',
    });
  });

  it('appends payment method and promo to note', async () => {
    mockFetch();

    const res = await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseCart,
          note: 'Deliver before 9am',
          paymentMethod: { id: 'net30', label: 'Invoice · Net 30' },
          promoCode: 'SUMMER10',
        }),
      })
    );

    expect(res.status).toBe(201);
    const [, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.draft_order.note).toContain('Deliver before 9am');
    expect(body.draft_order.note).toContain('Payment method: Invoice · Net 30');
    expect(body.draft_order.note).toContain('Promo code: SUMMER10');
  });

  it('includes shipping_line when provided', async () => {
    mockFetch();

    const res = await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseCart,
          shippingLine: { title: 'Standard Freight', price: '25.00' },
        }),
      })
    );

    const [, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.draft_order.shipping_line).toMatchObject({ title: 'Standard Freight', price: '25.00' });
  });

  it('includes payment method id in tags', async () => {
    mockFetch();

    await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseCart,
          paymentMethod: { id: 'ach', label: 'Bank Transfer (ACH)' },
        }),
      })
    );

    const [, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.draft_order.tags).toContain('ach');
  });

  it('sends invoice via Shopify on 201', async () => {
    mockFetch();

    await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseCart),
      })
    );

    const invoiceCall = globalThis.fetch.mock.calls.find(
      ([url]) => url.includes('/send_invoice.json')
    );
    expect(invoiceCall).toBeDefined();
    const [invoiceUrl, invoiceOpts] = invoiceCall;
    expect(invoiceUrl).toContain('/draft_orders/99/send_invoice.json');
    expect(invoiceOpts.method).toBe('POST');
    expect(invoiceOpts.headers['X-Shopify-Access-Token']).toBe('test-token');
    const invoiceBody = JSON.parse(invoiceOpts.body);
    expect(invoiceBody).toEqual({ draft_order_invoice: {} });
  });

  it('does not send invoice when Shopify returns non-201', async () => {
    globalThis.fetch.mockImplementation((url) => {
      if (url.includes('/send_invoice.json')) {
        return Promise.resolve(new Response(JSON.stringify({ draft_order_invoice: {} }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ errors: ['Validation failed'] }), { status: 422 })
      );
    });

    await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseCart),
      })
    );

    const invoiceCall = globalThis.fetch.mock.calls.find(
      ([url]) => url.includes('/send_invoice.json')
    );
    expect(invoiceCall).toBeUndefined();
  });

  it('invoice failure does not affect draft order response', async () => {
    mockFetch(mockDraftOrder, 201, false); // send_invoice returns 500

    const res = await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(baseCart),
      })
    );

    // Worker still returns 201 with draft order
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.draft_order.id).toBe(99);
  });

  // Test A — memberDiscounts applied per line item
  it('maps memberDiscounts to per-line-item applied_discount', async () => {
    mockFetch();

    const cartWithDiscount = {
      ...baseCart,
      // variant_id on the item is a number (1); variantId in memberDiscounts may be a number or string
      memberDiscounts: [{ variantId: 1, discountCents: 500, title: 'Member 10% off' }],
    };

    await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cartWithDiscount),
      })
    );

    const [, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    const lineItem = body.draft_order.line_items[0];

    // applied_discount must be present with correct fields
    expect(lineItem.applied_discount).toBeDefined();
    expect(lineItem.applied_discount.value_type).toBe('fixed_amount');
    expect(lineItem.applied_discount.value).toBe('5.00');
    expect(lineItem.applied_discount.description).toBe('Member 10% off');

    // amount must NOT be sent (read-only field computed by Shopify)
    expect(lineItem.applied_discount.amount).toBeUndefined();
  });

  // Test A — string variantId in memberDiscounts also matches number variant_id on item
  it('normalizes variantId keys to strings to prevent type mismatch', async () => {
    mockFetch();

    const cartWithStringKey = {
      ...baseCart,
      // variantId sent as string "1", item.variant_id is number 1
      memberDiscounts: [{ variantId: '1', discountCents: 300, title: 'String-key discount' }],
    };

    await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cartWithStringKey),
      })
    );

    const [, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    const lineItem = body.draft_order.line_items[0];

    expect(lineItem.applied_discount).toBeDefined();
    expect(lineItem.applied_discount.value).toBe('3.00');
  });

  // Test B — promoAmountCents applied as order-level discount
  it('adds order-level applied_discount when promoAmountCents > 0', async () => {
    mockFetch();

    const cartWithPromo = {
      ...baseCart,
      promoCode: 'SAVE5',
      promoAmountCents: 500,
    };

    await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cartWithPromo),
      })
    );

    const [, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    const discount = body.draft_order.applied_discount;

    expect(discount).toBeDefined();
    expect(discount.value_type).toBe('fixed_amount');
    expect(discount.value).toBe('5.00');
    expect(discount.description).toContain('SAVE5');

    // amount must NOT be sent (read-only field computed by Shopify)
    expect(discount.amount).toBeUndefined();
  });

  // Test B — no order-level discount when promoAmountCents is 0 or absent
  it('omits order-level applied_discount when promoAmountCents is 0', async () => {
    mockFetch();

    await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...baseCart, promoAmountCents: 0 }),
      })
    );

    const [, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.draft_order.applied_discount).toBeUndefined();
  });

  // Test C — freeShipping zeros the shipping line
  it('sets shipping_line.price to 0.00 when freeShipping is true', async () => {
    mockFetch();

    const cartWithFreeShipping = {
      ...baseCart,
      shippingLine: { title: 'Standard Freight', price: '25.00' },
      freeShipping: true,
    };

    await call(
      new Request('http://example.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cartWithFreeShipping),
      })
    );

    const [, fetchOpts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    const shippingLine = body.draft_order.shipping_line;

    // price must be zeroed out
    expect(shippingLine.price).toBe('0.00');

    // title must be preserved from the provided shippingLine
    expect(shippingLine.title).toBe('Standard Freight');
  });
});

// ── POST /?action=signup ──────────────────────────────────────────────────────

describe('POST /?action=signup', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  const baseSignup = {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    phone: '555-1234',
    business_name: 'Joe Cafe',
    address: {
      address1: '123 Main St',
      address2: 'Suite 1',
      city: 'Los Angeles',
      province: 'CA',
      zip: '90001',
      country: 'United States',
    },
  };

  // Sequences mock responses for ordered GraphQL calls
  function mockGqlSequence(...responses) {
    for (const r of responses) {
      globalThis.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(r), { status: 200 })
      );
    }
  }

  const customerCreateOk = (id = 'gid://shopify/Customer/7001') => ({
    data: { customerCreate: { customer: { id }, userErrors: [] } },
  });
  const customerCreateDuplicate = {
    data: { customerCreate: { customer: null, userErrors: [{ field: ['email'], message: 'has already been taken' }] } },
  };
  const customerLookupOk = (id = 'gid://shopify/Customer/7001') => ({
    data: { customers: { edges: [{ node: { id } }] } },
  });
  const addressCreateOk = {
    data: { customerAddressCreate: { customerAddress: { id: 'gid://shopify/MailingAddress/1' }, userErrors: [] } },
  };
  const shopMeta = (count = 42) => ({
    data: { shop: { id: 'gid://shopify/Shop/1', metafield: { id: 'gid://shopify/Metafield/1', value: String(count) } } },
  });
  const tagsAddOk = { data: { tagsAdd: { node: { id: 'gid://shopify/Customer/7001' }, userErrors: [] } } };
  const metafieldsSetOk = { data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } } };

  function signupRequest(body) {
    return new Request('http://example.com/?action=signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('happy path — creates customer, saves address, adds founding-member tags, returns { success: true }', async () => {
    mockGqlSequence(customerCreateOk(), addressCreateOk, shopMeta(42), tagsAddOk, metafieldsSetOk);

    const res = await call(signupRequest(baseSignup));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // All calls go to graphql.json
    for (const [url] of globalThis.fetch.mock.calls) {
      expect(url).toContain('/graphql.json');
    }
    expect(globalThis.fetch.mock.calls[0][1].headers['X-Shopify-Access-Token']).toBe('test-token');
  });

  it('adds ["member","founding-member"] tags when count < 100', async () => {
    mockGqlSequence(customerCreateOk(), addressCreateOk, shopMeta(42), tagsAddOk, metafieldsSetOk);

    await call(signupRequest(baseSignup));

    // tagsAdd is call index 3
    const [, tagsOpts] = globalThis.fetch.mock.calls[3];
    const tagsBody = JSON.parse(tagsOpts.body);
    expect(tagsBody.variables.tags).toEqual(expect.arrayContaining(['member', 'founding-member']));

    // metafieldsSet increments to 43
    const [, metaOpts] = globalThis.fetch.mock.calls[4];
    const metaBody = JSON.parse(metaOpts.body);
    expect(metaBody.variables.metafields[0].value).toBe('43');
  });

  it('adds only ["member"] tag and skips counter when count >= 100', async () => {
    mockGqlSequence(customerCreateOk(), addressCreateOk, shopMeta(100), tagsAddOk);

    await call(signupRequest(baseSignup));

    // Only 4 calls: customerCreate + addressCreate + shopMeta + tagsAdd (no metafieldsSet)
    expect(globalThis.fetch.mock.calls).toHaveLength(4);

    const [, tagsOpts] = globalThis.fetch.mock.calls[3];
    const tagsBody = JSON.parse(tagsOpts.body);
    expect(tagsBody.variables.tags).toEqual(['member']);
  });

  it('duplicate email — looks up existing customer by email and proceeds to tag them', async () => {
    mockGqlSequence(customerCreateDuplicate, customerLookupOk(), addressCreateOk, shopMeta(42), tagsAddOk, metafieldsSetOk);

    const res = await call(signupRequest(baseSignup));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // tagsAdd must still be called (call index 4 now due to lookup)
    const [, tagsOpts] = globalThis.fetch.mock.calls[4];
    const tagsBody = JSON.parse(tagsOpts.body);
    expect(tagsBody.variables.id).toBe('gid://shopify/Customer/7001');
  });

  it('duplicate email — skips tagging when customer already has member tag', async () => {
    const customerLookupAlreadyMember = {
      data: { customers: { edges: [{ node: { id: 'gid://shopify/Customer/7001', tags: ['member', 'founding-member'] } }] } },
    };
    mockGqlSequence(customerCreateDuplicate, customerLookupAlreadyMember);

    const res = await call(signupRequest(baseSignup));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // Only 2 calls: customerCreate + customer lookup — no addressCreate or tagsAdd
    expect(globalThis.fetch.mock.calls).toHaveLength(2);
  });

  it('returns 400 validation error when email is missing', async () => {
    const { email: _email, ...noEmail } = baseSignup;
    const res = await call(signupRequest(noEmail));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toContain('email');
  });

  it('returns 400 when address field is missing', async () => {
    const body = signupRequest({
      first_name: 'Test', last_name: 'User', email: 'test@example.com',
      address: { address1: '123 Main St', city: 'NYC', zip: '10001' }
      // province deliberately omitted
    });
    const res = await call(body);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toMatch(/address\.province/i);
  });

  it('returns 400 validation error for invalid email format', async () => {
    const res = await call(signupRequest({ ...baseSignup, email: 'not-an-email' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toContain('Invalid email');
  });

  it('builds note with business name in customerCreate mutation', async () => {
    mockGqlSequence(customerCreateOk(), addressCreateOk, shopMeta(42), tagsAddOk, metafieldsSetOk);

    await call(signupRequest({ ...baseSignup, business_name: 'Joe Cafe' }));

    const [, opts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.variables.input.note).toBe('membership-signup\nBusiness: Joe Cafe');
  });

  it('builds note without business name', async () => {
    mockGqlSequence(customerCreateOk(), addressCreateOk, shopMeta(42), tagsAddOk, metafieldsSetOk);
    const { business_name: _bn, ...noBusinessName } = baseSignup;

    await call(signupRequest(noBusinessName));

    const [, opts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.variables.input.note).toBe('membership-signup');
  });

  it('saves address via customerAddressCreate mutation', async () => {
    mockGqlSequence(customerCreateOk(), addressCreateOk, shopMeta(42), tagsAddOk, metafieldsSetOk);

    await call(signupRequest(baseSignup));

    const [, opts] = globalThis.fetch.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.variables.address).toMatchObject({
      address1: '123 Main St',
      city: 'Los Angeles',
      province: 'CA',
      zip: '90001',
    });
  });

  it('defaults country to United States in address when omitted', async () => {
    mockGqlSequence(customerCreateOk(), addressCreateOk, shopMeta(42), tagsAddOk, metafieldsSetOk);
    const { address: { country: _c, ...addressNoCountry }, ...rest } = baseSignup;

    await call(signupRequest({ ...rest, address: addressNoCountry }));

    const [, opts] = globalThis.fetch.mock.calls[1];
    const body = JSON.parse(opts.body);
    expect(body.variables.address.country).toBe('United States');
  });
});

// ── POST /?action=activate-membership ────────────────────────────────────────

describe('POST /?action=activate-membership', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });

  function activateRequest(body) {
    return new Request('http://example.com/?action=activate-membership', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Sequences mock responses for ordered GraphQL calls
  function mockGqlSequence(...responses) {
    for (const r of responses) {
      globalThis.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(r), { status: 200 })
      );
    }
  }

  const shopMeta = (count) => ({
    data: { shop: { id: 'gid://shopify/Shop/1', metafield: { id: 'gid://shopify/Metafield/1', value: String(count) } } },
  });
  const tagsAddOk = { data: { tagsAdd: { node: { id: 'gid://shopify/Customer/5001' }, userErrors: [] } } };
  const metafieldsSetOk = { data: { metafieldsSet: { metafields: [{ id: 'gid://shopify/Metafield/1' }], userErrors: [] } } };

  it('adds ["member","founding-member"] tags and increments counter when count < 100', async () => {
    mockGqlSequence(shopMeta(42), tagsAddOk, metafieldsSetOk);

    const res = await call(activateRequest({ customer_id: 5001 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // Call 1: shop metafield read
    // Call 2: tagsAdd — must include founding-member
    const [, tagsAddOpts] = globalThis.fetch.mock.calls[1];
    const tagsAddBody = JSON.parse(tagsAddOpts.body);
    expect(tagsAddBody.variables.id).toBe('gid://shopify/Customer/5001');
    expect(tagsAddBody.variables.tags).toEqual(expect.arrayContaining(['member', 'founding-member']));

    // Call 3: metafieldsSet — must increment to 43
    const [, metaOpts] = globalThis.fetch.mock.calls[2];
    const metaBody = JSON.parse(metaOpts.body);
    expect(metaBody.variables.metafields[0].value).toBe('43');
  });

  it('adds only ["member"] tag and skips counter when count >= 100', async () => {
    mockGqlSequence(shopMeta(100), tagsAddOk);

    const res = await call(activateRequest({ customer_id: 5001 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    // Only 2 calls: shop meta + tagsAdd — no metafieldsSet
    expect(globalThis.fetch.mock.calls).toHaveLength(2);

    const [, tagsAddOpts] = globalThis.fetch.mock.calls[1];
    const tagsAddBody = JSON.parse(tagsAddOpts.body);
    expect(tagsAddBody.variables.tags).toEqual(['member']);
    expect(tagsAddBody.variables.tags).not.toContain('founding-member');
  });

  it('accepts customer_id as a string and constructs the correct GID', async () => {
    mockGqlSequence(shopMeta(42), tagsAddOk, metafieldsSetOk);

    const res = await call(activateRequest({ customer_id: '5001' }));
    expect(res.status).toBe(200);

    const [, tagsAddOpts] = globalThis.fetch.mock.calls[1];
    const body = JSON.parse(tagsAddOpts.body);
    expect(body.variables.id).toBe('gid://shopify/Customer/5001');
  });

  it('returns 400 with "required" message when customer_id is missing', async () => {
    const res = await call(activateRequest({}));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toBe('customer_id is required');
  });

  it('returns 400 with "positive integer" message when customer_id is zero', async () => {
    const res = await call(activateRequest({ customer_id: 0 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toBe('customer_id must be a positive integer');
  });

  it('returns 400 with "positive integer" message when customer_id is negative', async () => {
    const res = await call(activateRequest({ customer_id: -1 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toBe('customer_id must be a positive integer');
  });

  it('returns 400 with "positive integer" message when customer_id is a non-numeric string', async () => {
    const res = await call(activateRequest({ customer_id: 'abc' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toBe('customer_id must be a positive integer');
  });

  it('returns 400 with "positive integer" message when customer_id is a float', async () => {
    const res = await call(activateRequest({ customer_id: 1.5 }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toBe('customer_id must be a positive integer');
  });

  it('returns 500 when tagsAdd returns userErrors', async () => {
    const tagsAddError = { data: { tagsAdd: { node: null, userErrors: [{ field: ['id'], message: 'Invalid customer ID' }] } } };
    mockGqlSequence(shopMeta(42), tagsAddError);

    const res = await call(activateRequest({ customer_id: 5001 }));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toMatch(/Invalid customer ID/);
  });
});
