import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import WebhookSubscription from "../models/WebhookSubscription";
import WebhookDelivery from "../models/WebhookDelivery";
import WebhookDeadLetter from "../models/WebhookDeadLetter";
import { WEBHOOK_SCHEMA_VERSION } from "../../../src/lib/api/payloadVersion";
import { recordAuditEvent } from "./auditTrail";

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 3_000;
const MAX_RETRY_DELAY_MS = 243_000;
const MAX_FAILURES_BEFORE_DISABLE = 10;
const pendingDeliveries = new Set<Promise<void>>();

/** Current webhook payload schema version. Bump on any breaking change to the envelope shape. */
export const WEBHOOK_PAYLOAD_VERSION = 1;

/**
 * Shape of every outbound webhook POST body.
 *
 * `schemaVersion` is a stable date-string (matching WEBHOOK_SCHEMA_VERSION)
 * that receiver implementations can use to branch on payload shape without
 * relying on field-presence checks. It is separate from the REST API version
 * because webhook deliveries are push-based and not subject to Accept-Version
 * negotiation — receivers must handle the version they subscribed under.
 * `version` is the older numeric envelope version, kept alongside it for
 * receivers that already branch on `X-PromptHash-Version` / `payload.version`.
 *
 * Current version: 2025-01-01
 *   - version      — numeric envelope version (WEBHOOK_PAYLOAD_VERSION)
 *   - event        — event type name (e.g. "PromptPurchased")
 *   - deliveryId   — UUID, unique per delivery attempt
 *   - timestamp    — ISO-8601 string, UTC
 *   - schemaVersion — WEBHOOK_SCHEMA_VERSION constant
 *   - data         — event-specific payload (see docs/payload-versioning.md)
 */
export interface WebhookPayload {
  /** Numeric envelope version. Optional only so hand-built test fixtures that
   * predate this field can still satisfy the type; buildWebhookPayload always sets it. */
  version?: number;
  /** Stable date-string identifying the webhook payload schema. */
  schemaVersion: typeof WEBHOOK_SCHEMA_VERSION;
  event: string;
  deliveryId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export function signWebhookPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time verification helper for Node.js webhook consumers. */
export function verifyWebhookSignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, body));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/** Bounded exponential backoff: 3s, 9s, 27s, 81s, 243s — capped at MAX_RETRY_DELAY_MS. (#210) */
function retryDelayMs(attempt: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 3 ** attempt, MAX_RETRY_DELAY_MS);
}

async function deliverOnce(url: string, secret: string, payload: WebhookPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = signWebhookPayload(secret, body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PromptHash-Signature": signature,
      "X-PromptHash-Delivery": payload.deliveryId,
      "X-PromptHash-Event": payload.event,
      "X-PromptHash-Version": String(payload.version),
      "X-PromptHash-Schema-Version": payload.schemaVersion,
      // Included in the signed JSON envelope; consumers should enforce a
      // short acceptance window to prevent replay attacks.
      "X-PromptHash-Timestamp": payload.timestamp,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const err = new Error(`Webhook delivery failed with status ${res.status}`) as Error & {
      statusCode?: number;
    };
    err.statusCode = res.status;
    throw err;
  }
}

async function logDeliveryAttempt(params: {
  subscriptionId: string;
  deliveryId: string;
  event: string;
  attempt: number;
  success: boolean;
  statusCode?: number | null;
  error?: string | null;
}): Promise<void> {
  try {
    await WebhookDelivery.create({
      subscriptionId: params.subscriptionId,
      deliveryId: params.deliveryId,
      event: params.event,
      attempt: params.attempt,
      success: params.success,
      statusCode: params.statusCode ?? null,
      error: params.error ?? null,
    });
  } catch (err) {
    // Delivery logging must never take down the actual delivery attempt.
    console.error("[webhookDispatcher] Failed to record delivery history:", err);
  }
}

async function recordDeadLetter(params: {
  subscriptionId: string;
  event: string;
  payload: WebhookPayload;
  attempts: number;
  lastError?: string | null;
  lastStatusCode?: number | null;
}): Promise<void> {
  try {
    await WebhookDeadLetter.create({
      subscriptionId: params.subscriptionId,
      event: params.event,
      payload: params.payload,
      attempts: params.attempts,
      lastError: params.lastError ?? null,
      lastStatusCode: params.lastStatusCode ?? null,
    });
  } catch (err) {
    // Same fail-open rationale as logDeliveryAttempt: recording the dead
    // letter must never throw back into the delivery loop.
    console.error("[webhookDispatcher] Failed to record dead letter:", err);
  }
}

async function deliverWithRetry(
  subscriptionId: string,
  url: string,
  secret: string,
  payload: WebhookPayload,
): Promise<void> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      await deliverOnce(url, secret, payload);
      await logDeliveryAttempt({
        subscriptionId,
        deliveryId: payload.deliveryId,
        event: payload.event,
        attempt,
        success: true,
      });
      await WebhookSubscription.findByIdAndUpdate(subscriptionId, {
        lastDeliveredAt: new Date(),
        $set: { failureCount: 0 },
      });
      return;
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? null;
      const message = err instanceof Error ? err.message : String(err);
      await logDeliveryAttempt({
        subscriptionId,
        deliveryId: payload.deliveryId,
        event: payload.event,
        attempt,
        success: false,
        statusCode,
        error: message,
      });

      const isLastAttempt = attempt === MAX_RETRIES;
      if (!isLastAttempt) {
        await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
        continue;
      }

      // Every retry is exhausted and the event is still unprocessable —
      // persist the full payload as a dead letter (issue #97) so it can
      // be inspected or replayed later. Without this, the event data
      // itself is lost; only the pass/fail history in WebhookDelivery
      // survives.
      await recordDeadLetter({
        subscriptionId,
        event: payload.event,
        payload,
        attempts: attempt + 1,
        lastError: message,
        lastStatusCode: statusCode,
      });
      void recordAuditEvent({
        action: "webhook_delivery_failure",
        result: "failure",
        reason: "retries_exhausted",
        metadata: { subscriptionId, event: payload.event, statusCode },
      });

      const updated = await WebhookSubscription.findByIdAndUpdate(
        subscriptionId,
        { $inc: { failureCount: 1 } },
        { new: true },
      );

      if (updated && updated.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
        await WebhookSubscription.findByIdAndUpdate(subscriptionId, { active: false });
      }
    }
  }
}

/**
 * Builds the versioned, uniquely-identified, timestamped envelope for an
 * event. Exposed separately from `dispatchEvent` so `test`-endpoint code
 * can build (and deliver) a payload without going through subscription
 * lookup by wallet.
 */
export function buildWebhookPayload(event: string, data: Record<string, unknown>): WebhookPayload {
  return {
    version: WEBHOOK_PAYLOAD_VERSION,
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    event,
    deliveryId: randomUUID(),
    timestamp: new Date().toISOString(),
    data,
  };
}

export async function dispatchEvent(
  creatorWallet: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const subscriptions = await WebhookSubscription.find({
    walletAddress: creatorWallet.toLowerCase(),
    active: true,
    events: event,
  });

  const payload = buildWebhookPayload(event, data);

  const work = Promise.allSettled(
    subscriptions.map((sub) => deliverWithRetry(String(sub._id), sub.url, sub.secret, payload)),
  ).then(() => undefined);
  pendingDeliveries.add(work);
  try {
    await work;
  } finally {
    pendingDeliveries.delete(work);
  }
}

/** Wait for in-flight outbound deliveries during graceful shutdown. */
export async function flushPendingWebhooks(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pendingDeliveries.size > 0) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await Promise.race([
      Promise.allSettled([...pendingDeliveries]),
      new Promise<void>((resolve) => setTimeout(resolve, remaining)),
    ]);
  }
  return true;
}

/**
 * Delivers a single test event directly to one subscription and returns
 * the outcome inline, instead of the usual fire-and-forget dispatch — so
 * a creator testing their endpoint gets an immediate answer.
 */
export async function sendTestEvent(
  subscription: { _id: unknown; url: string; secret: string },
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const payload = buildWebhookPayload("WebhookTest", {
    message: "This is a test event from PromptMint.",
  });
  const subscriptionId = String(subscription._id);

  try {
    await deliverOnce(subscription.url, subscription.secret, payload);
    await logDeliveryAttempt({
      subscriptionId,
      deliveryId: payload.deliveryId,
      event: payload.event,
      attempt: 0,
      success: true,
    });
    return { success: true };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    await logDeliveryAttempt({
      subscriptionId,
      deliveryId: payload.deliveryId,
      event: payload.event,
      attempt: 0,
      success: false,
      statusCode: statusCode ?? null,
      error: message,
    });
    return { success: false, statusCode, error: message };
  }
}

/**
 * Re-attempts delivery of a single dead-lettered event (issue #97). On
 * success the dead letter is marked resolved; on failure it's left
 * unresolved with its error/attempt count updated so it can be retried
 * again later, and it is NOT re-queued into the automatic retry loop —
 * replay is an explicit, one-shot operator action.
 *
 * The stored envelope is re-sent byte-for-byte by default, so `deliveryId`
 * and `timestamp` are preserved and a receiver can still dedupe an event it
 * already processed. `refreshTimestamp` re-stamps `timestamp` with the current
 * time before signing: the signature covers the body, so the result stays
 * internally consistent, and it is the only way to redeliver an event that is
 * now older than a receiver's acceptance window. `deliveryId` is deliberately
 * left alone in both modes.
 */
export async function replayDeadLetter(
  deadLetterId: string,
  options: { refreshTimestamp?: boolean } = {},
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const deadLetter = await WebhookDeadLetter.findById(deadLetterId);
  if (!deadLetter) {
    throw new Error(`Dead letter ${deadLetterId} not found`);
  }

  const subscription = await WebhookSubscription.findById(deadLetter.subscriptionId);
  if (!subscription) {
    throw new Error(`Subscription ${deadLetter.subscriptionId} for dead letter ${deadLetterId} not found`);
  }

  const stored = deadLetter.payload as WebhookPayload;
  const payload: WebhookPayload = options.refreshTimestamp
    ? { ...stored, timestamp: new Date().toISOString() }
    : stored;

  try {
    await deliverOnce(subscription.url, subscription.secret, payload);
    await logDeliveryAttempt({
      subscriptionId: String(subscription._id),
      deliveryId: payload.deliveryId,
      event: payload.event,
      attempt: deadLetter.attempts,
      success: true,
    });
    deadLetter.resolved = true;
    deadLetter.resolvedAt = new Date();
    trackReplay(deadLetter);
    await deadLetter.save();
    return { success: true };
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    await logDeliveryAttempt({
      subscriptionId: String(subscription._id),
      deliveryId: payload.deliveryId,
      event: payload.event,
      attempt: deadLetter.attempts,
      success: false,
      statusCode: statusCode ?? null,
      error: message,
    });
    deadLetter.attempts += 1;
    deadLetter.lastError = message;
    deadLetter.lastStatusCode = statusCode ?? null;
    trackReplay(deadLetter);
    await deadLetter.save();
    return { success: false, statusCode, error: message };
  }
}

/** Records replay attempt bookkeeping for the replay console. */
function trackReplay(deadLetter: { replayCount?: number; lastReplayedAt?: Date | null }): void {
  deadLetter.replayCount = (deadLetter.replayCount ?? 0) + 1;
  deadLetter.lastReplayedAt = new Date();
}
