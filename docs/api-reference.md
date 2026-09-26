# Prompt Mint API Reference

This is the human-readable reference for the Prompt Mint HTTP API. The machine-readable contract is [`../server/spec/openapi.yaml`](../server/spec/openapi.yaml). An importable Postman collection is [`postman/prompt-mint.postman_collection.json`](postman/prompt-mint.postman_collection.json).

## Environments and headers

| Environment | Base URL |
|---|---|
| Local Express server | `http://localhost:5000` |
| Production | `https://api.promptmint.io` |

Use `Accept: application/json` for JSON endpoints and `Content-Type: application/json` for JSON bodies. Versioned serverless responses include `apiVersion` and `X-API-Version`. Supported `Accept-Version` values are `latest`, `2025-01-01` (default), and `2024-01-01`; an unsupported value returns `400` with `code: "UNSUPPORTED_VERSION"`.

The Postman collection uses `{{baseUrl}}`, `{{walletAddress}}`, `{{promptId}}`, `{{resourceId}}`, and `{{apiKey}}` variables. Set `baseUrl` before sending.

## Authentication

An address in a body or URL identifies a wallet; it is not proof of control unless the endpoint verifies a signature or on-chain entitlement.

| Credential | Header/body | Applies to |
|---|---|---|
| None | No credential | Public reads, health, robots, marketplace reads, license-term reads, vote count/top |
| Wallet challenge | `POST /api/auth/challenge`, then sign the message and call `POST /api/prompts/unlock` | Prompt unlock |
| Admin token | `Authorization: Bearer $ADMIN_API_TOKEN` | Admin-only report and operational routes when enabled |
| API key | `X-Api-Key: pm_<prefix>_<secret>` or `Authorization: Bearer pm_<prefix>_<secret>` | Programmatic Express routes |

API keys are managed at `/api-keys`. Their plaintext is returned only by create/rotate. Scopes are hierarchical: `admin` includes `write`, and `write` includes `read`.

## Rate limits and body limits

Challenge and unlock responses expose `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`.

| Operation | Unauthenticated | Authenticated | Window |
|---|---:|---:|---:|
| Challenge issuance | 5/IP | 10/IP | 60 seconds |
| Unlock IP guard | 3/IP | 3/IP | 60 seconds |
| Unlock wallet guard | n/a | 5/wallet | 60 seconds |
| Analytics events | 60/identifier | 120/identifier | 60 seconds |
| API-key tiers | n/a | free 60, pro 600, enterprise 6,000 | 60 seconds |

Express JSON bodies are limited to `300kb`; serverless bodies are limited to `100kb`. Oversized requests return `413`. State-changing requests may include an `Idempotency-Key`; matching retries replay for 24 hours, while a changed body or in-flight duplicate returns `409`.

## Error codes

Full per-code table — including retry guidance, the Express `AppError` codes, appeal and API-key errors, and the exact envelope shapes — is in the [SDK error-code reference card](./sdk-error-codes.md). That card is verified against `src/lib/api/errorCodes.ts` by `src/test/docs/sdkErrorCodes.test.ts`.

| HTTP | Code/condition | Meaning |
|---:|---|---|
| 400 | `MISSING_FIELDS`, `INVALID_INPUT`, `UNSUPPORTED_VERSION` | Invalid shape, missing data, or unsupported API version |
| 401 | `INVALID_SIGNATURE`, `CHALLENGE_INVALID`, invalid API key | Authentication failed |
| 403 | `ACCESS_NOT_PURCHASED`, insufficient scope/ownership | Authenticated but forbidden |
| 404 | `NOT_FOUND` or `{error}` | Resource is absent |
| 409 | Idempotency conflict, duplicate vote, state conflict | Request cannot be applied safely |
| 413 | body too large | Body exceeds the configured limit |
| 422 | validation failure | Semantically invalid listing or structured input |
| 429 | `RATE_LIMIT_IP`, `RATE_LIMIT_WALLET`, or rate-limit error | Retry after reset |
| 500 | `CONFIGURATION_ERROR` or server error | Deployment/unexpected failure |
| 503/504 | upstream unavailable/timeout | AI proxy dependency failure |

Common validation response:

```json
{"error":"Invalid listing metadata","fields":{"title":"Title must be at least 3 characters long.","price":"Price must be greater than zero."}}
```

## Complete endpoint catalog

The catalog below matches [`server/spec/openapi.yaml`](../server/spec/openapi.yaml). `Public` means no credential is required. Request and response types are the OpenAPI component names; their complete properties and constraints are in that file.

### Health, SEO, and AI

| Method | Path | Auth | Request -> success |
|---|---|---|---|
| GET | `/health` | Public | none -> `HealthResponse` |
| GET | `/robots.txt` | Public | none -> `text/plain` |
| GET/POST | `/api/seo/controls` | Public / policy | `SEOControls` -> `SEOControls` |
| POST | `/api/improve-proxy` | Public | `text/plain` -> upstream JSON (`503`/`504` possible) |
| POST | `/api/chat` | Public | `TestPromptRequest` -> `text/event-stream` |
| POST | `/api/test-prompt` | Public | `TestPromptRequest` -> `text/event-stream` |
| GET | `/api/creators/reputation` | Public | optional creator query -> reputation JSON |

### Prompts, versions, and libraries

| Method | Path | Auth | Request -> success |
|---|---|---|---|
| GET | `/api/prompts` | Public | `category`, `walletAddress` query -> `Prompt[]` |
| POST | `/api/prompts` | Creator policy | `CreatePromptRequest` -> `201 {message,prompt}` |
| GET | `/api/prompts/{id}` | Public | path `id` -> `Prompt` |
| POST | `/api/prompts/{id}/publish` | Creator | path `id` -> `{success,prompt}` |
| POST | `/api/prompts/{id}/archive` | Creator | path `id` -> `{success,prompt}` |
| POST | `/api/prompts/{id}/submit-review` | Creator | path `id` -> `{success,prompt,checklist}` |
| PATCH | `/api/prompts/{id}/review-checklist` | Creator | `{checklist: ReviewChecklist}` -> `{success,checklist}` |
| POST/DELETE | `/api/prompts/{id}/tags` | Creator | `{tags:string[]}` -> `{success,tags}` |
| POST/GET | `/api/prompts/{id}/versions` | Creator / entitled buyer | `{content,changeDescription}` or none -> `PromptVersion`/`PromptVersion[]` |
| GET | `/api/prompts/{id}/versions/{versionIndex}` | Creator / entitled buyer | path values -> `PromptVersion` |
| GET | `/api/prompts/buyer/{walletAddress}/owned` | Wallet policy | path wallet -> `Prompt[]` |
| GET | `/api/prompts/buyer/{walletAddress}/transactions` | Wallet policy | path wallet -> `MarketplaceTransaction[]` |
| GET | `/api/prompts/buyer/{walletAddress}/saved` | Wallet policy | path wallet -> `Prompt[]` |
| POST | `/api/prompts/buyer/save` | Wallet policy | `{walletAddress,promptId}` -> `{success}` |
| POST | `/api/prompts/buyer/unsave` | Wallet policy | `{walletAddress,promptId}` -> `{success}` |
| GET | `/api/prompts/creator/{walletAddress}/transactions` | Wallet policy | path wallet -> `MarketplaceTransaction[]` |
| GET | `/api/prompts/creator/{walletAddress}/drafts` | Creator | path wallet -> `Prompt[]` |
| POST | `/api/prompts/report` | Public submission | `{promptId,reporterAddress,reason,description?}` -> `201 {success,message,reportId}` |
| GET | `/api/prompts/reports` | Admin token | optional `promptId` -> `Report[]` |
| POST | `/api/prompts/preview` | Public | `{promptId}` -> `{success}` |
| GET | `/api/prompts/preview-stats` | Creator policy | required `walletAddress` query -> stats |

`CreatePromptRequest` requires `image`, `title`, `content`, `walletAddress`, and `price`. Image URLs must be HTTP(S), title length is 3-100, content length is 10-50,000, and price is positive. Categories normalize to `Marketing`, `Creative Writing`, `Programming`, `Music`, `Gaming`, or `Other`.

### Auth, users, and data rights

| Method | Path | Auth | Request -> success |
|---|---|---|---|
| POST | `/api/auth/challenge` | Wallet + rate limit | `{address,promptId}` -> challenge token |
| POST | `/api/prompts/unlock` | Signed challenge + on-chain access | `{token,promptId,address,signedMessage}` -> decrypted prompt |
| POST/GET | `/api/user` | Wallet / policy | `{walletAddress,username?}` or optional query -> user |
| GET/PUT | `/api/user/preferences` | Wallet | `walletAddress` query / `{walletAddress,preferences}` -> preferences |
| POST | `/api/user/export/challenge` | Wallet | `{walletAddress}` -> `{challenge,expiresAt}` |
| POST | `/api/user/export` | Signed wallet challenge | `{walletAddress,signature,challenge}` -> export status |
| GET | `/api/user/export/download/{exportId}` | Export owner | path export ID -> export file |
| POST | `/api/user/delete/challenge` | Wallet | `{address}` -> deletion challenge |
| POST | `/api/user/delete` | Signed wallet challenge | `{address,signature,token}` -> deletion result |

The canonical unlock URLs are `/api/auth/challenge` and `/api/prompts/unlock`; older `/api/unlock/*` links are obsolete.

### Versions and governance

| Method | Path | Auth | Request -> success |
|---|---|---|---|
| POST | `/api/versions/update` | Creator | `{promptId,content,changeDescription}` -> `PromptVersion` |
| GET | `/api/versions/{promptId}/history` | Creator / entitled buyer | path prompt -> `PromptVersion[]` |
| POST | `/api/versions/purchase` | Buyer | `{promptId,buyerWallet,transactionHash}` -> purchase |
| GET | `/api/versions/buyer-version` | Buyer | `promptId`, `buyerWallet` query -> version info |
| POST/DELETE | `/api/governance/vote/{promptId}` | Purchased buyer / voter | `{voterWallet}` -> vote count |
| GET | `/api/governance/votes/{promptId}` | Public | path prompt -> `{promptId,upvotes}` |
| GET | `/api/governance/top` | Public | optional `limit` 1-50 -> ranked prompts |

### Appeals, licensing, webhooks, notifications, ordering, and analytics

| Method | Path | Auth | Request -> success |
|---|---|---|---|
| POST | `/api/appeals` | Appellant | `{decisionId,appellantAddress,statement,evidenceRefs?}` -> appeal |
| GET | `/api/appeals/{id}` | Appeal policy | path ID -> appeal |
| GET | `/api/appeals/decision/{decisionId}` | Appeal policy | path decision -> `{appeals}` |
| POST | `/api/appeals/{id}/resolve` | Moderator | `{resolverAddress,outcome,reason,evidenceRefs?}` -> appeal |
| POST | `/api/appeals/{id}/withdraw` | Appellant | `{appellantAddress,reason?}` -> appeal |
| GET | `/api/license-terms/active` | Public | none -> `LicenseTerm` |
| GET | `/api/license-terms/version/{version}` | Public | path version -> `LicenseTerm` |
| GET | `/api/license-terms/listing/{promptId}` | Public | path prompt -> `LicenseTerm` |
| POST | `/api/license-terms/create` | Admin | `{content,version,isActive?}` -> `LicenseTerm` |
| POST/GET/DELETE | `/api/webhooks` | Owner | subscription body/none -> subscription |
| POST | `/api/webhooks/rotate-secret` | Owner | none -> new secret |
| POST | `/api/webhooks/test` | Owner | none -> delivery ID |
| GET | `/api/webhooks/deliveries` | Owner | none -> `WebhookDelivery[]` |
| GET | `/api/webhooks/dead-letters` | Owner | none -> dead letters |
| POST | `/api/webhooks/dead-letters/{id}/replay` | Admin | path ID, optional `{refreshTimestamp}` -> `{success,replayedAt}` |
| GET | `/api/webhooks/replay/events` | Public | none -> event catalog |
| GET | `/api/webhooks/replay/queue` | Owner | `walletAddress` query -> replay queue with per-row assessments |
| POST | `/api/webhooks/replay/preview` | Public | `{event,data?}` -> envelope preview, nothing delivered |
| GET | `/api/notifications` | User | none -> `Notification[]` |
| PATCH | `/api/notifications/{id}/read` | User | path ID -> `{success}` |
| GET/PUT | `/api/prompt-order` | Wallet | none / `PromptOrder` -> `PromptOrder` |
| GET/POST | `/api-keys` | Key owner | owner query / key body -> key summaries or plaintext once |
| DELETE | `/api-keys/{id}` | Key owner | `{ownerWallet}` -> revoked key |
| POST | `/api-keys/{id}/rotate` | Key owner | `{ownerWallet}` -> new key plaintext once |
| GET | `/api/analytics-rollups` | Admin/analytics | none -> `AnalyticsRollup[]` |
| POST | `/api/analytics-rollups/trigger` | Admin/analytics | none -> `{success}` |

## Curl examples

```bash
# Public listing
curl -sS "$BASE_URL/api/prompts?category=Marketing" -H 'Accept: application/json'

# Create a listing; use a fresh key for safe retries
curl -sS -X POST "$BASE_URL/api/prompts" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: 7b3a6e2e-8f2b-4b8b-9b7a-6f7c9c9b1a1e' \
  -d '{"image":"https://example.com/cover.png","title":"Launch Strategy Pack","content":"A reusable launch workflow for a product team.","walletAddress":"G...","price":2.5,"category":"marketing"}'

# Request a challenge, sign its returned message in the wallet, then unlock
curl -sS -X POST "$BASE_URL/api/auth/challenge" -H 'Content-Type: application/json' \
  -d '{"address":"G...","promptId":"42"}'
curl -sS -X POST "$BASE_URL/api/prompts/unlock" -H 'Content-Type: application/json' \
  -d '{"token":"<challenge-token>","promptId":"42","address":"G...","signedMessage":"<base64-signature>"}'

# API-key authenticated read
curl -sS "$BASE_URL/api/prompts" -H 'X-Api-Key: pm_<prefix>_<secret>'

# Buyer library mutation
curl -sS -X POST "$BASE_URL/api/prompts/buyer/save" -H 'Content-Type: application/json' \
  -d '{"walletAddress":"G...","promptId":"6650f1abc"}'
```

For every request/response property, enum, and reusable schema, use the OpenAPI contract above. Wallet challenge/unlock and buyer mutation schemas are also documented in [`api-request-schemas.md`](./api-request-schemas.md).

## Serverless handler appendix

These deployed handlers live under `api/` and are not currently represented
in the Express OpenAPI document. They use the same base URL and JSON/error
conventions unless noted.

| Method | Path | Authentication | Request -> success |
|---|---|---|---|
| GET | `/api/status` | Public | none -> versioned service status |
| GET | `/api/sitemap` | Public | none -> XML sitemap |
| POST | `/api/analytics/events` | Public, rate limited | `{event,occurredAt,properties}` -> `202 {accepted:true}` |
| POST | `/api/bundles/unlock` | Signed wallet challenge + bundle entitlement | `{token,bundleId,address,signedMessage}` -> unlocked prompt array |
| GET | `/api/creators/reputation` | Public | creator query -> reputation JSON |
| POST | `/api/images/validate` | Public | `{url}` -> `{valid,contentType,contentLength}` |
| POST | `/api/auth/approveKeyRecovery` | Admin recovery token | `{scenario,operatorReference,fixture}` -> verification result |
| POST | `/api/auth/rotateSecret` | Admin token | none -> versioned rotation result |
| GET | `/api/moderation/data` | Signed moderator wallet | query -> moderation data |
| POST | `/api/moderation/actions` | Signed moderator wallet | `{moderatorAddress,moderatorTimestamp,moderatorSignature,confirmed,actions[]}` -> applied/errors |
| GET | `/api/moderation/logs` | Signed moderator wallet | query -> moderation logs |
| GET | `/api/reviews/data` | Public | `promptId` query -> reviews |
| GET | `/api/reviews/list` | Public | `promptId` query -> reviews |
| GET | `/api/reviews/eligibility` | Buyer wallet policy | `promptId`, `userAddress` query -> eligibility |
| POST | `/api/reviews/submit` | Verified buyer + signature | `{promptId,userAddress,rating,text,signature}` -> review |
| PUT | `/api/reviews/edit` | Review author + on-chain access | `{promptId,reviewId,userAddress,rating,text}` -> updated review |
| POST | `/api/reviews/respond` | Creator policy | response body -> seller response |
| POST | `/api/reviews/vote` | Wallet policy | vote body -> vote result |
| POST | `/api/webhooks` | Webhook policy | webhook body -> delivery/registration result |

Analytics accepts only known taxonomy events, rejects raw wallet addresses,
and has a 20kb body limit. Image validation accepts HTTP(S) URLs only and
allows JPEG, PNG, WebP, and GIF files up to 5MB. Moderator actions accept 1-50
actions and may return `207` when some actions fail.

For external developers integrating against these endpoints, see the
[Public API Survival Guide](./public-api-survival-guide.md) for rate-limit
handling, error recovery patterns, unlock flow gotchas, and the testnet
checklist.
