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
6. [ ] Item B shows `Cost: N/A` and `Margin: N/A` (no cost recorded)
7. [ ] Order summary shows `Cost: N/A` (because item B has no cost)
8. [ ] Complete button is **disabled**

---

### 2. Item A — weight item, per-item mode, cost + price update

9. [ ] Click `[Update Cost & Price]` on item A — cost/price panel expands inline
10. [ ] Enter a cost value — suggested prices at 25/20/15% margin update live below the cost field
11. [ ] Enter a price value — click `[Calculate Margin]` — margin percentage shown
12. [ ] Click `[Confirm]` — panel closes, **Cost and Price both turn green** (both were changed); Margin also green
13. [ ] Click `[Update Weight]` on item A — weight panel expands
14. [ ] Price per unit hint shows the price just confirmed (not the original catalog price)
15. [ ] Verify Per-Item mode is selected by default, with 2 inputs (one per qty)
16. [ ] Enter a weight in each input (e.g. `2.5` and `3.0`)
17. [ ] Click `[Confirm Weight]` — panel closes, `Weight: 2.5, 3.0 lb` shown in green

---

### 3. Item B — weight item, bulk mode, no cost/price update

18. [ ] Click `[Update Weight]` on item B — weight panel expands
19. [ ] Select `Bulk` radio — panel switches to a single `Total lbs` input
20. [ ] Enter a total weight (e.g. `8.0`)
21. [ ] Click `[Confirm Weight]` — panel closes, `Weight: 8 lb` shown in green

---

### 4. Item C — unit item, Found, price-only update

22. [ ] Click `[Update Cost & Price]` on item C — panel expands
23. [ ] Leave cost field unchanged, enter a new price only
24. [ ] Click `[Confirm]` — panel closes, **Price turns green, Cost does not** (only price changed)
25. [ ] Click `[Found It]` — `✓ found` shown with a `[Reset]` button

---

### 5. Item D — unit item, Partial, cost-only update

26. [ ] Click `[Update Cost & Price]` on item D — panel expands
27. [ ] Enter a new cost only, leave price field unchanged
28. [ ] Click `[Confirm]` — panel closes, **Cost turns green, Price does not** (only cost changed)
29. [ ] Click `[Partial]` — an inline quantity input appears (no browser prompt)
30. [ ] Enter a quantity less than 4 (e.g. `2`) and click `[Confirm]`
31. [ ] `✓ partial` shown with `[Reset]` button; Qty shows `2 (of 4)` in green

---

### 6. Item E — unit item, Removed, no update

32. [ ] Click `[Removed]` on item E — `✓ remove` shown with a `[Reset]` button
33. [ ] Item E remains visible in the list (not hidden)

---

### 7. Reset behaviour

34. [ ] Click `[Reset]` on item C — `[Found It]` `[Partial]` `[Removed]` buttons reappear, item is unresolved
35. [ ] Re-mark item C as `[Found It]`

---

### 8. Order summary and Complete

36. [ ] Order summary shows:
    - Cost reflects A's new cost × total weight + D's new cost × partial qty (item B N/A makes total N/A if B still unresolved — complete item B first)
    - Total reflects A's `totalWeight × pricePerLb` + B's `totalWeight × price` + C's new price + D's price × 2 (item E excluded as removed)
    - Margin shown if cost is known for all items
37. [ ] Complete button is now **enabled**
38. [ ] Click `[Complete Order]` — progress indicator `⏳ Updating… please wait` shown
39. [ ] Success banner appears: `✅ All 5 items updated successfully.`
40. [ ] `[Print Invoice]` button appears

---

### 9. Backend verification

41. [ ] In Shopify Admin → Orders — a new order exists, tagged `sourced`
42. [ ] Item A: line item price = `totalWeight × pricePerLb`; `Weight (lb)` property shows `2.5, 3.0`; `Price Breakdown` property shows the calculation; line item still linked to the original product variant
43. [ ] Item A: inventory item cost updated to the value entered in step 10
44. [ ] Item B: line item price = `totalBulkWeight × price`; `Weight (lb)` and `Price Breakdown` properties present
45. [ ] Item C: line item price updated to the new price entered in step 23
46. [ ] Item D: qty is `2` (partial); inventory item cost updated to the value entered in step 27
47. [ ] Item E: line item removed from the order

---

### 10. Print Invoice

48. [ ] Click `[Print Invoice]` — `/invoice/{orderId}` opens in a new tab
49. [ ] Invoice renders at full 8.5×11 width with correct order details and line items
50. [ ] Weight items show `Weight (lb)` and `Price Breakdown` properties

---

## Cleanup

- Delete or archive the test order in Shopify Admin after verification
- Optionally reset costs on test products to their original values
