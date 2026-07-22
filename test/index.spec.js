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

  // All required fields for the signup handler
  const baseSignup = {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@example.com',
    phone: '555-1234',
    restaurant_name: 'Joe Cafe',
    restaurant_phone: '555-9999',
    business_type: 'restaurant',
    business_subtype: 'casual',
    emergency_name: 'Bob',
    emergency_phone: '555-0000',
    ordering_method: ['online'],
    address: {
      address1: '123 Main St',
      address2: 'Suite 1',
      city: 'Los Angeles',
      province: 'CA',
      zip: '90001',
    },
  };

  function signupRequest(body) {
    return new Request('http://example.com/?action=signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Mock a successful customerCreate GraphQL response
  function mockCreateSuccess(customer = { id: 'gid://shopify/Customer/7001', email: 'jane@example.com' }) {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({
        data: { customerCreate: { customer, userErrors: [] } },
      }), { status: 200 })
    );
  }

  it('happy path — calls /graphql.json with customerCreate and returns success', async () => {
    mockCreateSuccess();

    const res = await call(signupRequest(baseSignup));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.customer.id).toBe('gid://shopify/Customer/7001');
    expect(data.customer.email).toBe('jane@example.com');

    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('/graphql.json');
    expect(opts.method).toBe('POST');
    expect(opts.headers['X-Shopify-Access-Token']).toBe('test-token');

    const reqBody = JSON.parse(opts.body);
    expect(reqBody.query).toContain('customerCreate');
    expect(reqBody.variables.input.email).toBe('jane@example.com');
    expect(reqBody.variables.input.firstName).toBe('Jane');
    // metafields array should be present (filtering removes empties, so at least ordering_method)
    expect(Array.isArray(reqBody.variables.input.metafields)).toBe(true);
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

  it('returns 400 when address.province is missing', async () => {
    const { province: _p, ...addressNoProvince } = baseSignup.address;
    const res = await call(signupRequest({ ...baseSignup, address: addressNoProvince }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('validation');
    expect(data.message).toMatch(/address\.province/i);
  });

  it('duplicate email — finds customer via GraphQL, then calls customerUpdate, returns success', async () => {
    // Call 1: customerCreate returns CUSTOMER_ALREADY_EXISTS
    // Call 2: customers query returns existing customer
    // Call 3: customerUpdate returns success
    globalThis.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: {
            customerCreate: {
              customer: null,
              userErrors: [{ field: ['email'], message: 'Email has already been taken', code: 'CUSTOMER_ALREADY_EXISTS' }],
            },
          },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: {
            customers: {
              edges: [{
                node: { id: 'gid://shopify/Customer/7001', email: 'jane@example.com', note: null, tags: [] },
              }],
            },
          },
        }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: { customerUpdate: { customer: { id: 'gid://shopify/Customer/7001' }, userErrors: [] } },
        }), { status: 200 })
      );

    const res = await call(signupRequest(baseSignup));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Second call should be the find-by-email GraphQL query
    const [findUrl, findOpts] = globalThis.fetch.mock.calls[1];
    expect(findUrl).toContain('/graphql.json');
    const findBody = JSON.parse(findOpts.body);
    expect(findBody.query).toContain('customers');
    expect(findBody.variables.query).toContain('jane@example.com');

    // Third call should be customerUpdate using GID directly
    const [, updateOpts] = globalThis.fetch.mock.calls[2];
    const updateBody = JSON.parse(updateOpts.body);
    expect(updateBody.query).toContain('customerUpdate');
    expect(updateBody.variables.input.id).toBe('gid://shopify/Customer/7001');
  });

  it('returns 422 when Shopify returns a non-duplicate userError', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({
        data: {
          customerCreate: {
            customer: null,
            userErrors: [{ field: ['phone'], message: 'Phone is invalid', code: 'INVALID' }],
          },
        },
      }), { status: 200 })
    );

    const res = await call(signupRequest(baseSignup));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('shopify_error');
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

  // Helper: mock GET (REST) then GraphQL customerUpdate
  function mockGetThenGraphQL(existingNote = null, updateUserErrors = []) {
    globalThis.fetch.mockImplementation((url, opts) => {
      const method = (opts && opts.method) ? opts.method.toUpperCase() : 'GET';
      // First call: REST GET for existing customer
      if (method === 'GET') {
        return Promise.resolve(
          new Response(
            JSON.stringify({ customer: { id: 5001, note: existingNote } }),
            { status: 200 }
          )
        );
      }
      // Second call: GraphQL customerUpdate
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: {
              customerUpdate: {
                customer: { id: 'gid://shopify/Customer/5001' },
                userErrors: updateUserErrors,
              },
            },
          }),
          { status: 200 }
        )
      );
    });
  }

  it('happy path — GETs customer first, then calls GraphQL customerUpdate and returns success', async () => {
    mockGetThenGraphQL(null); // no existing note

    const res = await call(activateRequest({ customer_id: 5001 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });

    // First call must be REST GET
    const [getUrl, getOpts] = globalThis.fetch.mock.calls[0];
    expect(getUrl).toContain('/customers/5001.json');
    expect((getOpts && getOpts.method) || 'GET').not.toBe('POST');

    // Second call must be GraphQL customerUpdate
    const [gqlUrl, gqlOpts] = globalThis.fetch.mock.calls[1];
    expect(gqlUrl).toContain('/graphql.json');
    expect(gqlOpts.method).toBe('POST');
    const gqlBody = JSON.parse(gqlOpts.body);
    expect(gqlBody.query).toContain('customerUpdate');
    expect(gqlBody.variables.input.id).toBe('gid://shopify/Customer/5001');
    expect(gqlBody.variables.input.note).toBe('membership-signup');
  });

  it('prepends membership-signup to existing note when note is present', async () => {
    mockGetThenGraphQL('Some existing note');

    await call(activateRequest({ customer_id: 5001 }));

    const [, gqlOpts] = globalThis.fetch.mock.calls[1];
    const gqlBody = JSON.parse(gqlOpts.body);
    expect(gqlBody.variables.input.note).toBe('membership-signup\nSome existing note');
  });

  it('always writes metafields even if note already starts with membership-signup (no idempotency early-return)', async () => {
    // Note already starts with membership-signup — we must NOT early-return, still call customerUpdate
    mockGetThenGraphQL('membership-signup\nOld note');

    const res = await call(activateRequest({ customer_id: 5001 }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ success: true });

    // Both calls must have been made (GET + GraphQL customerUpdate)
    expect(globalThis.fetch.mock.calls).toHaveLength(2);
    const [, gqlOpts] = globalThis.fetch.mock.calls[1];
    const gqlBody = JSON.parse(gqlOpts.body);
    expect(gqlBody.query).toContain('customerUpdate');
  });

  it('accepts customer_id as a string and coerces it to a number', async () => {
    mockGetThenGraphQL(null);

    const res = await call(activateRequest({ customer_id: '5001' }));
    expect(res.status).toBe(200);
    expect(res.status).toBe(200);

    const [getUrl] = globalThis.fetch.mock.calls[0];
    expect(getUrl).toContain('/customers/5001.json');
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

  it('returns 422 shopify_error when Shopify GET returns non-200', async () => {
    globalThis.fetch.mockResolvedValue(
      new Response(JSON.stringify({ errors: 'Customer not found' }), { status: 404 })
    );

    const res = await call(activateRequest({ customer_id: 9999 }));
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toBe('shopify_error');
  });
});
