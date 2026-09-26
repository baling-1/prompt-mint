# Webhook Event Replay Console

A contract event that exhausts every delivery retry is persisted as a
`WebhookDeadLetter` — the full undelivered payload, not just a failure row. The
replay console is the operator surface for that backlog: see what failed, see
whether replaying it can actually succeed, and redeliver it.

- Console route: `/settings/webhooks/replay` (`src/pages/settings/WebhookReplayConsole.tsx`)
- Read model: `server/src/services/webhookReplay.ts`
- Routes: `server/src/routes/webhookRoutes.ts`
- Client: `src/lib/api/webhooks.ts`

## Why a console was needed

`GET /api/webhooks/dead-letters` returns raw documents. That answers *that* a
delivery failed but not whether a replay will land, and nothing surfaced the
reason old replays get rejected. The console adds a per-row assessment before
the operator spends a delivery on it.

## Replay semantics

`POST /api/webhooks/dead-letters/{id}/replay` re-sends the **stored envelope**,
so `deliveryId` and `timestamp` are preserved by default. That is deliberate:

- `deliveryId` stays the same so a receiver that already processed the event
  can dedupe it and avoid duplicate side effects. A replay never asks a
  receiver to apply an event twice.
- `timestamp` stays the same, which is also the problem. Receivers following
  [`server/docs/webhook-signatures.md`](../server/docs/webhook-signatures.md)
  are told to reject a delivery whose timestamp is more than five minutes old.
  A dead letter is by definition older than that, so a verbatim replay of
  anything recent enough to matter is rejected by a spec-compliant receiver.

Pass `{"refreshTimestamp": true}` to re-stamp `timestamp` with the current time
before signing. The signature covers the body, so the envelope stays internally
consistent, and `deliveryId` is still preserved. This is the only way to
redeliver an event that has aged past the acceptance window.

`refreshTimestamp` defaults to `false`, so existing replay callers keep the
verbatim behaviour.

| Mode | `deliveryId` | `timestamp` | Use when |
|---|---|---|---|
| Default (verbatim) | unchanged | unchanged | The receiver does not enforce the window, or you want byte-identical proof that the replayed body matches the dead-lettered one. |
| `refreshTimestamp: true` | unchanged | now | The receiver enforces the window and the event is older than it. |

The console surfaces the choice as two buttons and only offers the re-stamped
one when the queue has flagged the event as stale.

## Replay assessment

`assessReplay()` in `server/src/services/webhookReplay.ts` produces the verdict
the console renders:

| Field | Meaning |
|---|---|
| `deliveryId` | Delivery ID of the stored envelope; unchanged by a replay. |
| `originalTimestamp` | When the event originally occurred. |
| `ageSeconds` | Age of the stored envelope, or `null` when the timestamp is unreadable. |
| `fingerprint` | SHA-256 over the canonical (sorted-key) payload JSON. Identical before and after a verbatim replay, so it proves the body was not mutated. |
| `replayable` | `false` only when the dead letter is already resolved. |
| `stale` | `true` when the envelope is past `acceptanceWindowSeconds` (300). |
| `warnings` | `already_resolved`, `stale_event`, `unparseable_timestamp`, `subscription_missing`, `subscription_inactive`. |

`stale` is a warning, not a block: a receiver that ignores the window will
accept a verbatim replay, and the operator is in a better position to judge
that than the server is.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/webhooks/replay/events` | none | Event catalog: names, descriptions, whether the indexer emits each one, and a representative `data` object. Static metadata. |
| GET | `/api/webhooks/replay/queue?walletAddress=…` | wallet-scoped | Dead letters for that wallet's subscription, each with its assessment. `resolved=true` includes replayed rows; `limit` is clamped to 1–200. |
| POST | `/api/webhooks/replay/preview` | none | Builds the exact body and headers a receiver would see for `{event, data?}`. Delivers nothing. |
| POST | `/api/webhooks/dead-letters/{id}/replay` | admin token | Replays one event. Optional `{refreshTimestamp}`. |

`GET /api/webhooks/replay/events` returns the same catalog that
`POST /api/webhooks` validates against, so the list in the console and the
registration allow-list cannot drift. See the
[event catalog](./event-catalog.md) for the events themselves.

## Authorization

- Reading the queue is wallet-scoped: it requires the wallet to have a
  registered subscription and returns only that subscription's dead letters.
  The subscription secret is never included in a response.
- Replaying stays admin-token gated (`ADMIN_API_TOKEN`, compared with
  `timingSafeEqual`) because it triggers an outbound HTTP call on demand —
  the same trust boundary as `GET /api/prompts/reports`. Every replay writes an
  `admin_action` audit event, and a rejected token writes an `auth_failure`.
- The console holds the token in component state only. It is never written to
  `localStorage` or `sessionStorage`.

## Envelope preview

`POST /api/webhooks/replay/preview` returns the body and header set a receiver
would see for an event, using a fresh `deliveryId` and timestamp. Use it to
build and unit-test a receiver against a known-good envelope without standing
up a destination.

A preview is **not** what a dead-letter replay sends. A replay re-sends the
stored envelope. That distinction is why the queue reports an age per event and
the preview does not.

## Validation

```bash
# Server: replay read model + console controllers
cd server && npm test -- webhookReplay

# Frontend: replay client + console page
yarn test:frontend webhooks WebhookReplayConsole
```

## Operational notes

- `replayCount` and `lastReplayedAt` on a dead letter are incremented on every
  replay, successful or not, so the console can show how often an event has
  already been retried by hand.
- A replay is one-shot. It is not re-queued into the automatic retry loop, and
  a failed replay only increments `attempts` and updates `lastError`.
- The automatic retry ladder (3s, 9s, 27s, 81s, 243s) and the
  `MAX_FAILURES_BEFORE_DISABLE` auto-disable threshold are unchanged by this
  feature; a dead letter is still only created once every retry is exhausted.
