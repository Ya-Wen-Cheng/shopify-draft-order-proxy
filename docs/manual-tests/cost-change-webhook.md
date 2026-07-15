# Manual Tests — Cost Change Webhook (T7a)

## Pre-requisites

- Worker deployed to Cloudflare (`npx wrangler deploy`)
- `SHOPIFY_WEBHOOK_SECRET` set in Cloudflare dashboard and `.dev.vars`
- `SHOPIFY_TOKEN` set in Cloudflare dashboard
- Webhook registered in Shopify Admin → Settings → Notifications → Webhooks: topic `inventory_items/update`, URL `https://shopify-draft-order-proxy.<account>.workers.dev/webhook/cost-update`
- At least one product with a recorded cost in Shopify Admin (Inventory → cost field)
- Access to Shopify Admin → Products → [product] → More → Metafields to inspect `custom.last_known_cost`, `custom.cost_change_log`, `custom.cost_change_source`

## Desktop — Admin

### First cost change (self-healing initialization)

1. [ ] Pick a product that has **never** had `custom.last_known_cost` set. Navigate to its Inventory tab in Admin and note the current cost.
2. [ ] Edit the cost field to any value (e.g. change from `$4.00` to `$4.50`) and save.
3. [ ] Wait ~5 seconds, then open the product's Metafields panel (More → Metafields).
4. [ ] `custom.last_known_cost` should contain `{"<variantId>": "<new_cost>"}` → No log entry written (this is the initialization run).
5. [ ] `custom.cost_change_log` should be empty or unchanged.

### Second cost change (log entry written)

6. [ ] Edit the same product's cost again (e.g. `$4.50` → `$4.80`) and save.
7. [ ] Wait ~5 seconds, then refresh the Metafields panel.
8. [ ] `custom.last_known_cost` should now show the new cost (`$4.80`).
9. [ ] `custom.cost_change_log` should contain a line in format: `YYYY-MM-DD | $4.50 → $4.80 | manual`
10. [ ] The date in the log entry should be today's date.

### Multi-variant product

11. [ ] Pick a product with 2+ variants (e.g. 32 oz and 1 gal). Edit the cost of one variant.
12. [ ] After the webhook fires, verify `custom.cost_change_log` includes the variant title: `YYYY-MM-DD | 32 oz | $X.XX → $Y.YY | manual`

### Log accumulation (newest first)

13. [ ] Make a second cost change on the same product.
14. [ ] Verify the new log line appears **above** the previous one in `custom.cost_change_log`.

### Pipeline source attribution

15. [ ] Trigger a price check that causes a cost update via the pricing pipeline (or manually set `custom.cost_change_source` to `order:#D1` then update the cost).
16. [ ] Verify the log entry reads `YYYY-MM-DD | $X.XX → $Y.YY | order:#D1` (or the pipeline source string).
17. [ ] Verify `custom.cost_change_source` is cleared (empty string) after the log is written.

### Unchanged cost (no-op)

18. [ ] Edit a product's cost and save it to the **same value** it already is.
19. [ ] Verify `custom.cost_change_log` is **not** updated (no new entry).

## Cleanup

- No customer data created by these tests
- Optionally reset `custom.cost_change_log` and `custom.last_known_cost` on test products to a clean state
