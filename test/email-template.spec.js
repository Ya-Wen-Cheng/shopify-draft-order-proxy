import { describe, it, expect } from 'vitest';
import { buildOrderEmailHtml } from '../src/email-template.js';

const sampleDraftOrder = {
  name: '#D100',
  email: 'mei@example.com',
  created_at: '2026-06-26T10:00:00Z',
  shipping_address: {
    first_name: 'Mei', last_name: 'Chen',
    address1: '188 S Valley Blvd', address2: '',
    city: 'San Gabriel', province: 'CA', country: 'US', zip: '91776',
    phone: '',
  },
  line_items: [
    { title: 'Roma Tomatoes', variant_title: 'Jumbo 6x6', quantity: 3, price: '87.27' },
    { title: 'Thai Basil', variant_title: null, quantity: 2, price: '30.78' },
  ],
  subtotal_price: '323.25',
  total_price: '323.25',
  total_tax: '0.00',
  shipping_line: { title: 'Standard Freight', price: '25.00' },
  note: 'Deliver before 9am\n\nPayment method: Invoice · Net 30\nPromo code: SUMMER10',
  tags: 'draft-order, net30',
};

describe('buildOrderEmailHtml', () => {
  it('contains customer first name in header', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toContain('Order received, Mei!');
  });

  it('contains each line item title', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toContain('Roma Tomatoes');
    expect(html).toContain('Thai Basil');
  });

  it('contains the formatted total price', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toContain('323.25');
  });

  it('omits delivery instructions section when note has no instructions', () => {
    const order = { ...sampleDraftOrder, note: 'Payment method: Net 30' };
    const html = buildOrderEmailHtml(order);
    // The CSS section always references delivery instructions, so check for the H2 element
    expect(html).not.toContain('<h2>Delivery instructions</h2>');
  });

  it('shows delivery instructions when note has content before payment method line', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toContain('Deliver before 9am');
  });

  it('omits delivery banner when no shipping_line', () => {
    const order = { ...sampleDraftOrder, shipping_line: null };
    const html = buildOrderEmailHtml(order);
    // CSS always has .delivery-banner; check the actual HTML element is absent
    expect(html).not.toContain('class="delivery-banner"');
  });

  it('shows delivery banner when shipping_line exists', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toContain('class="delivery-banner"');
    expect(html).toContain('Standard Freight');
  });

  it('does not contain item-thumb divs (no product thumbnails)', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).not.toContain('item-thumb');
  });

  it('handles null/undefined shipping_address gracefully', () => {
    const order = { ...sampleDraftOrder, shipping_address: null };
    expect(() => buildOrderEmailHtml(order)).not.toThrow();
  });

  it('escapes HTML in user-supplied fields', () => {
    const order = {
      ...sampleDraftOrder,
      shipping_address: { ...sampleDraftOrder.shipping_address, first_name: '<script>alert(1)</script>' },
    };
    const html = buildOrderEmailHtml(order);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('responsive mobile styles', () => {
  it('includes @media only screen query for mobile breakpoint', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toContain('@media only screen and (max-width: 600px)');
  });

  it('includes inline style fallback on email-shell', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toMatch(/class="email-shell"[^>]*style="/);
  });

  it('includes table-layout:fixed on meta chips table', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toMatch(/class="email-meta__table"[^>]*style="[^"]*table-layout:fixed/);
  });

  it('includes inline padding fallback on email-body', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toMatch(/class="email-body"[^>]*style="[^"]*padding/);
  });

  it('footer link cells have responsive class email-footer__link-cell', () => {
    const html = buildOrderEmailHtml(sampleDraftOrder);
    expect(html).toContain('class="email-footer__link-cell"');
  });
});
