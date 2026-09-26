# Event Catalog

Every event the PromptHash contract emits, plus the webhook events the server
delivers. Contract events are defined in
[`contracts/prompt-hash/src/events.rs`](../contracts/prompt-hash/src/events.rs),
which is the source of truth. To consume them, see the
[event subscription guide](./contracts-event-subscription-guide.md).

Each contract event is named after its struct (for example `PromptCreated`),
which is the value the indexer matches on the first topic. Fields marked
**topic** are indexed topics; all other fields are in the event value. `Address`
values are Stellar addresses and amounts (`i128`) are in stroops.

## Contract events

### Listings and pricing

| Event | Topic fields | Data fields |
|---|---|---|
| `PromptCreated` | `prompt_id` | `creator`, `price_stroops`, `asset` |
| `PromptSaleStatusUpdated` | `prompt_id` | `active` |
| `PromptPriceUpdated` | `prompt_id` | `previous_price`, `price_stroops` |
| `PriceBoundsSet` | none | `min_price`, `max_price` (both optional) |
| `ListingExtended` | `prompt_id` | `new_expires_at` |
| `PromptExpiringSoon` | `prompt_id` | `creator`, `expires_at` |
| `ClassificationSet` | `prompt_id` | `classification`, `safety_flags` |
| `ClassificationOverridden` | `prompt_id` | `moderator`, `classification`, `safety_flags`, `reason` |
| `EncryptionRotated` | `prompt_id` | `previous_version`, `new_version`, `rotated_at` |

### Purchases, transfers, tips

| Event | Topic fields | Data fields |
|---|---|---|
| `PromptPurchased` | `prompt_id` | `buyer`, `creator`, `price_stroops`, `referrer` (optional), `creator_amount`, `platform_amount`, `referrer_amount` |
| `LicenseTransferred` | `prompt_id` | `seller`, `buyer`, `creator`, `resale_price`, `royalty_amount` |
| `PromptTipped` | `prompt_id` | `buyer`, `amount_tipped` |

### Referrals, vouchers, discounts, promotions

| Event | Topic fields | Data fields |
|---|---|---|
| `ReferralCodeRegistered` | `referrer` | `code_hash`, `reward_bps` |
| `ReferralRewardPaid` | `prompt_id` | `referrer`, `buyer`, `reward_amount` |
| `VoucherAdded` | `prompt_id` | `hashed_code`, `discount_bps` |
| `VoucherRemoved` | `prompt_id` | `hashed_code` |
| `DiscountSet` | `prompt_id` | `creator`, `discounted_price`, `start_ledger`, `end_ledger` |
| `DiscountCleared` | `prompt_id` | `creator` |
| `PromotionCreated` | `prompt_id` | `promotion_id`, `creator`, `start_time`, `end_time`, `price`, `asset` |
| `PromotionCancelled` | `prompt_id` | `promotion_id`, `creator` |
| `PromotionApplied` | `prompt_id` | `promotion_id`, `buyer`, `effective_price`, `original_price` |

### Subscriptions and bundles

| Event | Topic fields | Data fields |
|---|---|---|
| `SubscriptionConfigured` | `creator` | `duration_secs`, `price`, `asset`, `active` |
| `SubscriptionEligibilityUpdated` | `prompt_id` | `eligible` |
| `SubscriptionRenewed` | `creator` | `subscriber`, `expires_at`, `paid_amount`, `renewal_count` |
| `BundleCreated` | `bundle_id` | `creator`, `price_stroops`, `item_count` |
| `BundlePurchased` | `bundle_id` | `buyer`, `creator`, `price_stroops`, `referrer` (optional) |
| `BundlePriceUpdated` | `bundle_id` | `price_stroops` |
| `BundleActiveUpdated` | `bundle_id` | `active` |
| `BundleItemAdded` | `bundle_id` | `prompt_id` |
| `BundleItemRemoved` | `bundle_id` | `prompt_id` |

### Staking

| Event | Topic fields | Data fields |
|---|---|---|
| `StakeAdded` | `prompt_id` | `creator`, `amount`, `total_staked` |
| `StakeSlashed` | `prompt_id` | `slashed_amount`, `remaining_staked` |
| `StakeWithdrawn` | `prompt_id` | `creator`, `amount`, `remaining_staked` |

### Administration

| Event | Topic fields | Data fields |
|---|---|---|
| `ContractPausedStateChanged` | none | `is_paused` |
| `SchemaMigrated` | none | `previous_version`, `new_version` |
| `FeeUpdated` | `new_fee_percentage` | none |
| `FeeWalletUpdated` | `new_fee_wallet` | none |
| `UpgradeProposed` | `new_wasm_hash` | `proposed_at` |
| `UpgradeConfirmed` | `new_wasm_hash` | `confirmed_at` |
| `UpgradeCancelled` | `cancelled_wasm_hash` | none |

## Webhook events

Creators can subscribe a webhook to the names in
[`server/src/services/webhookReplay.ts`](../server/src/services/webhookReplay.ts),
which is the single source of truth shared by the registration API and the
[replay console](./webhook-replay-console.md). That catalog is also served as
JSON at `GET /api/webhooks/replay/events`. Bodies use the envelope described in
[payload versioning](./payload-versioning.md). The `data` field is what the
emitting code passes to `dispatchEvent`.

| Event | Emitted by | `data` fields |
|---|---|---|
| `PromptCreated` | indexer | `prompt_id`, `creator`, `price_stroops` |
| `PromptPurchased` | indexer | `prompt_id`, `buyer`, `creator`, `txHash` |
| `PromptPriceUpdated` | indexer | `prompt_id`, `price_stroops` |
| `WebhookTest` | `POST /api/webhooks/test` | `message` |
| `LicenseTransferred`, `EncryptionRotated` | not dispatched yet | none |
| `DisputeOpened`, `DisputeResolved` | not dispatched yet | none |

`LicenseTransferred` and `EncryptionRotated` are accepted at registration but the
indexer does not handle them yet. `DisputeOpened` and `DisputeResolved` are
accepted at registration but are not contract events. `WebhookTest` is sent only
to the endpoint under test and cannot be subscribed to.

The indexer in
[`server/src/services/indexer.ts`](../server/src/services/indexer.ts) also
processes `PromptSaleStatusUpdated` to update the database; it does not send a
webhook for it. Its start call in `server/src/server.ts` is currently commented
out.
