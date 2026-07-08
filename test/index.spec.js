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

// ── GET /payment-methods ──────────────────────────────────────────────────────

describe('GET /payment-methods', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns filtered manual gateways with chips', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          payment_gateways: [
            { id: 1, name: 'Bank Transfer (ACH)', type: 'manual', enabled: true, description: 'Wire details on invoice' },
            { id: 2, name: 'Net 30', type: 'manual', enabled: true, description: 'Pay within 30 days' },
            { id: 3, name: 'Credit Card', type: 'manual', enabled: true, description: 'Via invoice' },
            { id: 4, name: 'Shopify Payments', type: 'hosted', enabled: true, description: '' },
            { id: 5, name: 'Business Check', type: 'manual', enabled: false, description: '' },
          ],
        }),
        { status: 200 }
      )
    );

    const res = await call(new Request('http://example.com/payment-methods'));
    expect(res.status).toBe(200);

    const data = await res.json();
    // hosted and disabled gateways are excluded
    expect(data).toHaveLength(3);
    expect(data[0]).toMatchObject({ id: '1', name: 'Bank Transfer (ACH)', chips: ['ACH'] });
    expect(data[1]).toMatchObject({ id: '2', name: 'Net 30', chips: ['NET 30'] });
    expect(data[2]).toMatchObject({ id: '3', name: 'Credit Card', chips: ['VISA', 'MC', 'AMEX'] });
  });

  it('returns 500 when Shopify errors', async () => {
    globalThis.fetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const res = await call(new Request('http://example.com/payment-methods'));
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toMatch(/Shopify error/);
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

  function mockShopifyCustomer(customer = { id: 7001, email: 'jane@example.com' }, status = 201) {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({ customer }), { status })
    );
  }

  function signupRequest(body) {
    return new Request('http://example.com/?action=signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('happy path — calls customers.json and returns success with customer id and email', async () => {
    mockShopifyCustomer({ id: 7001, email: 'jane@example.com' });

    const res = await call(signupRequest(baseSignup));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ success: true, customer: { id: 7001, email: 'jane@example.com' } });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('/customers.json');
    expect(opts.method).toBe('POST');
    expect(opts.headers['X-Shopify-Access-Token']).toBe('test-token');
  });

  it('returns 400 validation error when email is missing', async () => {
    const { email: _email, ...noEmail } = baseSignup;
    const res = await call(signupRequest(noEmail));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toContain('email');
  });

  it('returns 400 validation error for invalid email format', async () => {
    const res = await call(signupRequest({ ...baseSignup, email: 'not-an-email' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toContain('Invalid email');
  });

  it('returns 409 duplicate_email when Shopify returns 422 with errors.email', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({ errors: { email: ['has already been taken'] } }), { status: 422 })
    );

    const res = await call(signupRequest(baseSignup));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('duplicate_email');
  });

  it('builds note with business name', async () => {
    mockShopifyCustomer();

    await call(signupRequest({ ...baseSignup, business_name: 'Joe Cafe' }));

    const [, opts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.customer.note).toBe('membership-signup\nBusiness: Joe Cafe');
  });

  it('builds note without business name', async () => {
    mockShopifyCustomer();
    const { business_name: _bn, ...noBusinessName } = baseSignup;

    await call(signupRequest(noBusinessName));

    const [, opts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.customer.note).toBe('membership-signup');
  });

  it('includes address in customer payload', async () => {
    mockShopifyCustomer();

    await call(signupRequest(baseSignup));

    const [, opts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.customer.addresses).toHaveLength(1);
    expect(body.customer.addresses[0]).toMatchObject({
      address1: '123 Main St',
      city: 'Los Angeles',
      province: 'CA',
      zip: '90001',
    });
  });

  it('defaults country to United States when omitted', async () => {
    mockShopifyCustomer();
    const { address: { country: _c, ...addressNoCountry }, ...rest } = baseSignup;

    await call(signupRequest({ ...rest, address: addressNoCountry }));

    const [, opts] = globalThis.fetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.customer.addresses[0].country).toBe('United States');
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

  it('happy path — calls customers/{id}.json PUT and returns success', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({ customer: { id: 5001, note: 'membership-signup' } }), { status: 200 })
    );

    const res = await call(activateRequest({ customer_id: 5001 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('/customers/5001.json');
    expect(opts.method).toBe('PUT');
    const body = JSON.parse(opts.body);
    expect(body).toEqual({ customer: { id: 5001, note: 'membership-signup' } });
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

  it('returns 422 shopify_error when Shopify returns non-200', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({ errors: 'Customer not found' }), { status: 404 })
    );

    const res = await call(activateRequest({ customer_id: 9999 }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('shopify_error');
  });
});
