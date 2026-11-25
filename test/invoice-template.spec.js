import { describe, it, expect } from 'vitest';
import { renderInvoiceHtml } from '../src/invoice-template.js';

// Pure rendering tests: no mocks needed.

const baseOrder = (over = {}) => ({
  name: '#1001',
  created_at: '2026-07-15T17:30:00Z',
  tags: '',
  subtotal_price: '20.00',
  total_tax: '1.50',
  total_price: '26.50',
  shipping_address: { first_name: 'Mei', last_name: 'Chen', address1: '1 Main St', city: 'LA', province: 'CA', zip: '90001' },
  shipping_lines: [{ price: '5.00' }],
  line_items: [{ title: 'Tomatoes', quantity: 2, price: '2.50' }],
  ...over,
});

// The delivery row is the only row labelled "Delivery" in the summary table.
const deliveryFee = (html) => html.match(/<td>Delivery<\/td><td>\$([^<]*)<\/td>/)[1];

describe('renderInvoiceHtml — delivery fee', () => {
  it('given a non-member order with a shipping line, charges the shipping price', () => {
    expect(deliveryFee(renderInvoiceHtml(baseOrder()))).toBe('5.00');
  });

  it('given a member order, shows $0.00 delivery even when a shipping line exists', () => {
    expect(deliveryFee(renderInvoiceHtml(baseOrder({ tags: 'vip, Member' })))).toBe('0.00');
  });

  it('given member matching is case-insensitive and trims whitespace', () => {
    expect(deliveryFee(renderInvoiceHtml(baseOrder({ tags: '  MEMBER ' })))).toBe('0.00');
  });

  it('given a tag that merely contains "member", does not treat the order as a member', () => {
    expect(deliveryFee(renderInvoiceHtml(baseOrder({ tags: 'ex-member' })))).toBe('5.00');
  });

  it('given a non-member order with no shipping lines, shows $0.00 delivery', () => {
    expect(deliveryFee(renderInvoiceHtml(baseOrder({ shipping_lines: [] })))).toBe('0.00');
  });

  it('given shipping_lines is missing entirely, shows $0.00 delivery', () => {
    const order = baseOrder();
    delete order.shipping_lines;
    expect(deliveryFee(renderInvoiceHtml(order))).toBe('0.00');
  });
});

describe('renderInvoiceHtml — line items', () => {
  it('computes each line total from price times quantity with two decimals', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [{ title: 'Rice', quantity: 3, price: '1.10' }] }));
    expect(html).toContain('<td>$3.30</td>');
  });

  it('shows the variant title after the product title when present', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [{ title: 'Rice', variant_title: '25lb', quantity: 1, price: '18' }] }));
    expect(html).toContain('Rice — 25lb');
  });

  it('omits the variant separator when there is no variant title', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [{ title: 'Rice', variant_title: null, quantity: 1, price: '18' }] }));
    expect(html).not.toContain('Rice —');
  });

  it('renders weight and price-breakdown properties as notes', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [{
      title: 'Tomatoes', quantity: 1, price: '8.75',
      properties: [{ name: 'Weight (lb)', value: '1.5, 2' }, { name: 'Price Breakdown', value: '$2.50/lb × 3.5 lb = $8.75' }],
    }] }));
    expect(html).toContain('Weight (lb): 1.5, 2');
    expect(html).toContain('$2.50/lb × 3.5 lb = $8.75');
  });

  it('given only a weight property, renders the weight note but no breakdown note', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [{
      title: 'Tomatoes', quantity: 1, price: '1', properties: [{ name: 'Weight (lb)', value: '2' }],
    }] }));
    expect(html).toContain('Weight (lb): 2');
    expect((html.match(/class="weight-note"/g) || [])).toHaveLength(1);
  });

  it('ignores unrelated line-item properties', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [{
      title: 'Tomatoes', quantity: 1, price: '1', properties: [{ name: 'Gift note', value: 'secret' }],
    }] }));
    expect(html).not.toContain('secret');
  });

  it('given no line items, still renders a valid empty table body', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [] }));
    expect(html).toContain('<tbody id="line-items-body"></tbody>');
  });

  it('given line_items is missing, does not throw', () => {
    const order = baseOrder();
    delete order.line_items;
    expect(() => renderInvoiceHtml(order)).not.toThrow();
  });
});

describe('renderInvoiceHtml — totals and defaults', () => {
  it('shows subtotal, tax and total from the order', () => {
    const html = renderInvoiceHtml(baseOrder());
    expect(html).toContain('<td>Subtotal</td><td>$20.00</td>');
    expect(html).toContain('<td>Tax</td><td>$1.50</td>');
    expect(html).toContain('<strong>$26.50</strong>');
  });

  it('given missing money fields, falls back to $0.00 rather than "undefined"', () => {
    const html = renderInvoiceHtml(baseOrder({ subtotal_price: undefined, total_tax: undefined, total_price: undefined }));
    expect(html).not.toContain('undefined');
    expect(html).toContain('<td>Subtotal</td><td>$0.00</td>');
    expect(html).toContain('<td>Tax</td><td>$0.00</td>');
    expect(html).toContain('<strong>$0.00</strong>');
  });

  it('given no shipping address, renders blank customer fields rather than "undefined"', () => {
    const order = baseOrder();
    delete order.shipping_address;
    const html = renderInvoiceHtml(order);
    // Inspect only the customer block: the page's inline script legitimately contains "null".
    const block = html.match(/<p id="customer-block">([\s\S]*?)<\/p>/)[1];
    expect(block).not.toContain('undefined');
    expect(block).not.toContain('null');
  });

  it('includes the customer signature line', () => {
    expect(renderInvoiceHtml(baseOrder())).toContain('Customer Signature');
  });
});

describe('renderInvoiceHtml — HTML escaping', () => {
  it('escapes markup in the product title', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [{ title: '<script>alert(1)</script>', quantity: 1, price: '1' }] }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes quotes and ampersands in the customer name and order name', () => {
    const html = renderInvoiceHtml(baseOrder({
      name: '#1"&\'',
      shipping_address: { first_name: '"><img src=x>', last_name: "O'Neil & Co" },
    }));
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&quot;&gt;&lt;img src=x&gt;');
    expect(html).toContain('O&#39;Neil &amp; Co');
    expect(html).toContain('#1&quot;&amp;&#39;');
  });

  it('escapes markup inside weight property values', () => {
    const html = renderInvoiceHtml(baseOrder({ line_items: [{
      title: 'x', quantity: 1, price: '1', properties: [{ name: 'Weight (lb)', value: '<b>1</b>' }],
    }] }));
    expect(html).not.toContain('<b>1</b>');
    expect(html).toContain('&lt;b&gt;1&lt;/b&gt;');
  });
});
