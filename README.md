# shopify-draft-order-proxy

A Cloudflare Worker that handles backend operations for a B2B restaurant supply store built on Shopify. Running in production.

## Why it exists

Shopify's checkout is designed for retail. The store's customers are restaurants — they order on net terms, pay on delivery, and their orders often need to be adjusted on-site when a product is unavailable or sold by weight. That workflow doesn't fit Shopify's native checkout.

This Worker sits between the storefront and the Shopify Admin API, handling the parts Shopify doesn't do out of the box.

## What it does

**Draft order checkout** — Creates draft orders from cart data, applies per-line-item membership discounts, sends the customer a Shopify invoice, and fires a team notification email via Resend.

**Membership signup and activation** — Two paths: new customers signing up (`POST /?action=signup`), and existing customers activating membership from their account page (`POST /?action=activate-membership`). Both write 16 customer metafields via GraphQL, set a default address, and handle phone conflicts (restaurants often share a number across multiple accounts).

**Pickup assistant** — A mobile UI at `/pickup` for warehouse staff filling orders. Staff can record actual weights for by-weight items, adjust prices, or mark items unavailable. On completion it converts the draft order to a real Shopify order tagged `sourced`.

**Invoice** — `GET /invoice/:order_id` returns a print-ready HTML page for any order.

**Cost tracking** — A Shopify `inventory_items/update` webhook triggers a Durable Object per inventory item. The DO serializes concurrent deliveries for the same SKU so parallel webhook calls don't race each other's metafield reads and writes.

## Architecture

```
Storefront (Liquid + JS)
        │
        ├── POST /                              create draft order
        ├── POST /?action=signup                new member signup
        ├── POST /?action=activate-membership   existing customer
        ├── GET  /pickup                        pickup assistant UI
        ├── GET  /invoice/:id                   printable invoice
        └── POST /webhook/cost-update           inventory cost webhook
                                                        │
                                                 Durable Object
                                                (per inventory_item_id)

Worker calls out to:
  Shopify Admin API (REST + GraphQL)
  Resend (transactional email)
```

## Notable decisions

**Durable Objects for cost webhooks.** Shopify can deliver `inventory_items/update` multiple times for the same item within milliseconds. A Durable Object keyed on `inventory_item_id` serializes execution, preventing concurrent deliveries from racing each other's metafield reads.

**GraphQL for draft order completion.** The REST API silently ignores `price` on variant line items. The pickup completion step uses `draftOrderUpdate` via GraphQL instead, which respects `priceOverride` while keeping `variantId` intact for Shopify analytics.

**Phone conflict retry.** When Shopify rejects a customer creation because the phone number is already taken, the Worker retries without the phone field rather than surfacing an error to the customer — a common edge case when restaurants share a number across accounts.

## Setup

```bash
npm install
npx wrangler dev
```

Create `.dev.vars` with:

```
SHOPIFY_SHOP_NAME=your-store-subdomain
SHOPIFY_TOKEN=...
SHOPIFY_WEBHOOK_SECRET=...
RESEND_API_KEY=...
```

## Tests

```bash
npm test
```

Vitest with the `cloudflare:test` miniflare pool. Covers HMAC verification, membership field validation, phone conflict retry, and pickup completion logic.
