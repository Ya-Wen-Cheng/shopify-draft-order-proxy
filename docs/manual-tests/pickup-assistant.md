# Manual Tests — Pickup Assistant (G19)

## Pre-requisites

- Worker deployed to Cloudflare (`npx wrangler deploy`)
- `SHOPIFY_TOKEN` set in Cloudflare dashboard
- One draft order created in Shopify Admin, tagged `draft-order-tab`, with the 6 line items below
- At least one product tagged `weight` in Shopify Admin (used for items A, B, and C)
- At least one product **without** the `weight` tag (used for items D, E, and F)
- All items have a recorded cost in Shopify Admin (Inventory → cost field) except item B (to verify N/A display)
- At least one previously sourced order (tagged `sourced`) in Shopify Admin to verify the Completed list entry

## Test Order Setup

**Customer:** `8315575304323`
(`https://admin.shopify.com/store/6kaf1n-gt/customers/8315575304323`)

**Tag:** `draft-order-tab`

**Line items:**

| Label | Role | Product ID | Variant ID | Qty | Notes |
|-------|------|-----------|-----------|-----|-------|
| A | Per-item weight | `8954966016131` | `47003491696771` | 3 | Per-item mode test |
| B | Bulk weight | `9190226002051` | `47586084421763` | 17 | Bulk mode test |
| C | Same-weight | `9190226002051` | `47586084421763` | 3 | Same Weight mode + qty reduction (same product as B) |
| D | Unit — Found | `8714649174147` | *(default)* | 2 | Found + price-only update |
| E | Unit — Partial | `8714607886467` | `45685553528963` | 3 | Partial + cost-only update |
| F | Unit — Remove | `8714608181379` | *(default)* | 4 | Remove test |

To recreate via Shopify MCP:
```
graphql_mutation — draftOrderCreate with lineItems referencing the variantIds above,
customerId gid://shopify/Customer/8315575304323,
tags: ["draft-order-tab"]
```

Note the current cost and price for items A, C, and D before testing.

---

## Tests

### 1. Homepage — list view

1. [ ] Navigate to `/pickup` in a mobile browser (or browser devtools mobile view)
2. [ ] Page header shows today's date and a `Clear` button (top-right)
3. [ ] Stats row shows `Incomplete: N` (orange) and `Completed: N` (green) counts
4. [ ] Each order card shows: order name + status badge, customer name, timestamp, first 3 item titles
5. [ ] Incomplete draft orders show an amber `Incomplete` badge
6. [ ] Sourced orders (tagged `sourced`, not yet delivered) show a green `Completed` badge with a `🖨 Print Invoice` button
7. [ ] Sourced orders tagged `delivered` do **not** appear

---

### 2. Navigation — enter and exit detail view

8. [ ] Tap an Incomplete order card — detail view opens for that order
9. [ ] `← Back` button is shown at the top
10. [ ] Tap `← Back` — returns to the list view with stats intact
11. [ ] Tap a Completed (sourced) order card — read-only detail view opens: `✅ Order completed`, real order name, line items with qty/price/properties, `[Print Invoice]`
12. [ ] Tap `← Back` — returns to the list view
13. [ ] Refresh the page while in detail view — stays on the same order (URL hash preserved)

---

### 3. Detail view — initial state (open order)

14. [ ] Navigate into the test draft order
15. [ ] Order name and customer name shown in card header with timestamp
16. [ ] Weight items show `[Update Cost & Price]` and `[Update Weight]` — no Found/Partial/Removed
17. [ ] Unit items show `[Update Cost & Price]` + `[Found It]` `[Partial]` `[Remove]` — no Update Weight
18. [ ] Item B shows `Cost: N/A` and `Margin: N/A` (no cost recorded)
19. [ ] Order summary shows `Cost: N/A` (because item B has no cost)
20. [ ] Complete button is **disabled**

---

### 4. Item A — weight item, per-item mode, cost + price update

21. [ ] Click `[Update Cost & Price]` on A — panel expands
22. [ ] Enter a cost value — suggested prices at 25/20/15% margin update live
23. [ ] Enter a price value — `[Calculate Margin]` shows margin
24. [ ] Click `[Confirm]` — panel closes, **Cost and Price both turn green**; Margin also green
25. [ ] Leave cost field unchanged on another item — Cost does **not** turn green (only changed fields go green)
26. [ ] Click `[Update Weight]` on A — panel expands
27. [ ] Three radios: `Per-Item` / `Same Weight` / `Bulk` — Per-Item selected by default
28. [ ] Price per unit hint shows the just-confirmed price (not the original catalog price)
29. [ ] 2 inputs shown (one per qty)
30. [ ] Enter weights (e.g. `2.5` and `3.0`)
31. [ ] `[Confirm Weight]` — closes, `Weight: 2.5, 3.0 lb` in green

---

### 5. Item B — weight item, bulk mode

32. [ ] `[Update Weight]` on B — panel expands
33. [ ] Select `Bulk` radio — switches to single `Total lbs` input
34. [ ] Enter a total weight (e.g. `8.0`)
35. [ ] `[Confirm Weight]` — closes, `Weight: 8 lb` in green

---

### 6. Item C — weight item, same-weight mode, quantity reduction

36. [ ] `[Update Weight]` on C — panel expands
37. [ ] Select `Same Weight` radio — shows `Weight per item (lb)` and `Quantity found`
38. [ ] `Quantity found` pre-filled with original qty
39. [ ] Enter a weight per item (e.g. `40`) and reduce quantity (e.g. from 3 to 2)
40. [ ] `[Confirm Weight]` — closes, `Weight: 40 lb × 2` in green (collapsed display)

---

### 7. localStorage persistence

41. [ ] Tap `← Back` — returns to list
42. [ ] Tap the same order — all confirmed weights, cost/price entries, and resolution states are restored
43. [ ] Refresh the page entirely — list view loads; tap into order — state still restored
44. [ ] Weight panel mode (Per-Item / Same Weight / Bulk) is restored correctly on re-open

---

### 8. Item D — unit item, Found, price-only update

45. [ ] `[Update Cost & Price]` on D — panel expands
46. [ ] Leave cost field unchanged, enter a new price only
47. [ ] `[Confirm]` — **Price turns green, Cost does not**
48. [ ] `[Found It]` — `✓ found` shown with `[Reset]` button

---

### 9. Item E — unit item, Partial, cost-only update

49. [ ] `[Update Cost & Price]` on E — panel expands
50. [ ] Enter a new cost only, leave price unchanged
51. [ ] `[Confirm]` — **Cost turns green, Price does not**
52. [ ] `[Partial]` — inline qty input appears
53. [ ] Enter qty less than original, click `[Confirm]`
54. [ ] `✓ partial` shown with `[Reset]`; Qty shows `X (of Y)` in green

---

### 10. Item F — unit item, Removed

55. [ ] `[Remove]` on F — `✓ remove` shown with `[Reset]` button (button text is "Remove", not "Removed")
56. [ ] Item F remains visible (not hidden)

---

### 11. Reset behaviour

57. [ ] `[Reset]` on D — `[Found It]` `[Partial]` `[Remove]` buttons reappear
58. [ ] Re-mark D as `[Found It]`

---

### 12. Order summary and Complete

59. [ ] Order summary reflects correct totals (weight items use `totalWeight × pricePerLb`, removed items excluded)
60. [ ] Complete button is **enabled**
61. [ ] `[Complete Order]` — `⏳ Updating… please wait` shown
62. [ ] Success banner: `✅ All N items updated successfully.`
63. [ ] `[Print Invoice]` button appears in the detail view

---

### 13. Backend verification

64. [ ] Shopify Admin → Orders — new order exists tagged `sourced`
65. [ ] Weight items: correct price, `Weight (lb)` and `Price Breakdown` properties, linked to original variant
66. [ ] Unit items: correct price/qty/cost updates
67. [ ] Removed item: absent from the order

---

### 14. Print Invoice — from detail view

68. [ ] `[Print Invoice]` in detail view — `/invoice/{orderId}` opens in new tab
69. [ ] Invoice renders correctly with order details and line items
70. [ ] Weight items show `Weight (lb)` and `Price Breakdown` properties

---

### 15. Homepage after completion

71. [ ] Tap `← Back` — list view shows the just-completed order with green `Completed` badge
72. [ ] `Completed: N` stat incremented; `Incomplete: N` decremented
73. [ ] `🖨 Print Invoice` visible on the list card
74. [ ] Tap `🖨 Print Invoice` — invoice opens; badge changes to `Printed`
75. [ ] Refresh — order still shows `Printed` badge

---

### 16. Completed order detail view (sourced order)

76. [ ] Tap a Completed order card — detail view shows real Shopify order name (e.g. `#1234`)
77. [ ] Customer name, timestamp, and line items shown (read-only: title, qty, price, Weight/Breakdown properties)
78. [ ] `[Print Invoice]` button present

---

### 17. Clear — multi-selection

79. [ ] `[Clear]` button visible in the list header (top-right)
80. [ ] Tap `[Clear]` — each card gains a checkbox; `Select all` checkbox appears at top; `[Clear Selected]` and `[Cancel]` buttons appear at bottom
81. [ ] Tapping a card toggles its checkbox (no navigation)
82. [ ] `[Clear Selected]` is disabled (greyed) when nothing is selected
83. [ ] Select one Incomplete draft order — button reads `Clear Selected (1)`
84. [ ] Select one Completed sourced order as well — button reads `Clear Selected (2)`
85. [ ] `[Clear Selected (2)]` — request sent; on success list refreshes
86. [ ] Cleared draft order no longer appears (lost `draft-order-tab` tag in Shopify)
87. [ ] Cleared sourced order no longer appears (gained `delivered` tag in Shopify)
88. [ ] Verify in Shopify Admin: draft order no longer has `draft-order-tab` tag; real order now has `delivered` tag
89. [ ] `[Cancel]` exits selection mode without changes
90. [ ] `Select all` checkbox selects all visible orders at once

---

## Cleanup

- Delete or archive the test order in Shopify Admin after verification
- Re-tag draft order with `draft-order-tab` if you want to reuse it
- Optionally reset costs on test products to their original values
