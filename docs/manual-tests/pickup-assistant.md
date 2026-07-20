# Manual Tests — Pickup Assistant (G19)

## Pre-requisites

- Worker deployed to Cloudflare (`npx wrangler deploy`)
- `SHOPIFY_TOKEN` set in Cloudflare dashboard
- One draft order created in Shopify Admin, tagged `draft-order-tab`, with the 5 line items below
- At least one product tagged `weight` in Shopify Admin (used for items A and B)
- At least one product **without** the `weight` tag (used for items C, D, and E)
- All items have a recorded cost in Shopify Admin (Inventory → cost field) except item B (to verify N/A display)

## Test Order Setup

Create a single draft order in Shopify Admin tagged `draft-order-tab` with these line items:

| Label | Product type | Qty |
|-------|-------------|-----|
| A     | Weight variant | 2 |
| B     | Weight variant (no cost recorded) | 3 |
| C     | Unit variant | 1 |
| D     | Unit variant | 4 |
| E     | Unit variant | 1 |

Note the current cost and price for items A, C, and D before testing.

---

## Tests

### 1. Page load

1. [ ] Navigate to `/pickup` in a mobile browser (or browser devtools mobile view)
2. [ ] Draft order card appears with the correct order name and customer name
3. [ ] Timestamp is shown below the order name
4. [ ] Items A and B show `[Update Cost & Price]` and `[Update Weight]` buttons — no Found/Partial/Removed
5. [ ] Items C, D, and E show `[Update Cost & Price]` and `[Found It]` `[Partial]` `[Removed]` buttons — no Update Weight
6. [ ] Item B shows `Cost: N/A` (no cost recorded)
7. [ ] Order summary shows `Cost: N/A` (because item B has no cost)
8. [ ] Complete button is **disabled**

---

### 2. Item A — weight item, per-item mode, cost + price update

9. [ ] Click `[Update Cost & Price]` on item A — cost/price panel expands inline
10. [ ] Enter a cost value — suggested prices at 25/20/15% margin update live below the cost field
11. [ ] Enter a price value — click `[Calculate Margin]` — margin percentage shown
12. [ ] Click `[Confirm]` — panel closes, price/cost/margin display turns green with new values
13. [ ] Click `[Update Weight]` on item A — weight panel expands
14. [ ] Verify Per-Item mode is selected by default, with 2 inputs (one per qty)
15. [ ] Enter a weight in each input (e.g. `2.5` and `3.0`)
16. [ ] Click `[Confirm Weight]` — panel closes, `Weight: 2.5, 3.0 lb` shown in green, item dims

---

### 3. Item B — weight item, bulk mode, no cost/price update

17. [ ] Click `[Update Weight]` on item B — weight panel expands
18. [ ] Select `Bulk` radio — panel switches to a single `Total lbs` input
19. [ ] Enter a total weight (e.g. `8.0`)
20. [ ] Click `[Confirm Weight]` — panel closes, `Weight: 8 lb` shown in green, item dims

---

### 4. Item C — unit item, Found, price-only update

21. [ ] Click `[Update Cost & Price]` on item C — panel expands
22. [ ] Leave cost field unchanged, enter a new price only
23. [ ] Click `[Confirm]` — panel closes, price display updates green, cost unchanged
24. [ ] Click `[Found It]` — item dims, `✓ found` shown

---

### 5. Item D — unit item, Partial, cost-only update

25. [ ] Click `[Update Cost & Price]` on item D — panel expands
26. [ ] Enter a new cost only, leave price field unchanged
27. [ ] Click `[Confirm]` — panel closes, cost display updates green, price unchanged
28. [ ] Click `[Partial]` — prompt appears asking for quantity found
29. [ ] Enter a quantity less than 4 (e.g. `2`) — item dims, quantity shown as updated

---

### 6. Item E — unit item, Removed, no update

30. [ ] Click `[Removed]` on item E — item dims, `✓ remove` shown

---

### 7. Order summary and Complete

31. [ ] Order summary now shows updated Cost, Total, and Margin reflecting new cost/price values and the partial qty for item D (item E excluded as removed)
32. [ ] Complete button is now **enabled**
33. [ ] Click `[Complete Order]` — progress indicator `⏳ Updating… please wait` shown
34. [ ] Success banner appears: `✅ All 5 items updated successfully.`
35. [ ] `[Print Invoice]` button appears

---

### 8. Backend verification

36. [ ] In Shopify Admin → Orders — a new order exists, tagged `sourced`
37. [ ] Item A: line item price reflects total weight × unit price; `Weight (lb)` property shows `2.5, 3.0`
38. [ ] Item A: inventory item cost updated to the value entered in step 10; product metafield `custom.cost_change_source` cleared
39. [ ] Item B: line item price reflects total bulk weight × unit price
40. [ ] Item C: line item price updated to the new price entered in step 22
41. [ ] Item D: qty is `2` (partial); inventory item cost updated to the value entered in step 26
42. [ ] Item E: line item removed from the order

---

### 9. Print Invoice

43. [ ] Click `[Print Invoice]` — `/invoice/{orderId}` opens in a new tab
44. [ ] Invoice renders at full 8.5×11 width with correct order details and line items

---

## Cleanup

- Delete or archive the test order in Shopify Admin after verification
- Optionally reset costs on test products to their original values
