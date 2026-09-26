import { createHash } from "crypto";
import WebhookDeadLetter from "../models/WebhookDeadLetter";
import { WEBHOOK_SCHEMA_VERSION } from "../../../src/lib/api/payloadVersion";
import { buildWebhookPayload, type WebhookPayload } from "./webhookDispatcher";

/**
 * Read model behind the webhook event replay console.
 *
 * Two things live here on purpose:
 *
 * 1. `WEBHOOK_EVENT_CATALOG` — the single source of truth for which events a
 *    webhook may subscribe to. It used to be an inline array in
 *    `webhookControllers.ts`; the console has to render the same list, and a
 *    second hardcoded copy in the browser is how the two drift apart. The
 *    controller derives its allow-list from this catalog.
 *
 * 2. The replay queue read model. `GET /api/webhooks/dead-letters` returns raw
 *    documents, which tells an operator *that* a delivery failed but not
 *    whether replaying it can possibly succeed. The assessment below answers
 *    that up front, so the console can warn before an operator fires a replay
 *    that a spec-compliant receiver is going to reject.
 */

/**
 * How old a delivery may be, in seconds, before a receiver following
 * `server/docs/webhook-signatures.md` is expected to reject it. Mirrors the
 * documented "more than five minutes old" rule; keep the two in step.
 */
export const REPLAY_ACCEPTANCE_WINDOW_SECONDS = 300;

export interface WebhookEventDefinition {
  /** Event name as it appears in the envelope's `event` field. */
  name: string;
  /** Short operator-facing summary shown in the console. */
  description: string;
  /** Whether the indexer currently emits this event. */
  dispatched: boolean;
  /** Whether a creator may list this event when registering a subscription. */
  subscribable: boolean;
  /** Representative `data` object, so the envelope shape can be previewed. */
  sampleData: Record<string, unknown>;
}

export const WEBHOOK_EVENT_CATALOG: WebhookEventDefinition[] = [
  {
    name: "PromptCreated",
    description: "New listing created.",
    dispatched: true,
    subscribable: true,
    sampleData: { prompt_id: "42", creator: "G...", price_stroops: 25000000 },
  },
  {
    name: "PromptPurchased",
    description: "Listing sold.",
    dispatched: true,
    subscribable: true,
    sampleData: { prompt_id: "42", buyer: "G...", creator: "G...", txHash: "..." },
  },
  {
    name: "PromptPriceUpdated",
    description: "Listing price changed.",
    dispatched: true,
    subscribable: true,
    sampleData: { prompt_id: "42", price_stroops: 30000000 },
  },
  {
    name: "LicenseTransferred",
    description: "License transferred between wallets.",
    dispatched: false,
    subscribable: true,
    sampleData: { prompt_id: "42", seller: "G...", buyer: "G...", creator: "G..." },
  },
  {
    name: "DisputeOpened",
    description: "Dispute opened against a license.",
    dispatched: false,
    subscribable: true,
    sampleData: { prompt_id: "42", disputer: "G...", reason: "..." },
  },
  {
    name: "DisputeResolved",
    description: "Dispute resolved.",
    dispatched: false,
    subscribable: true,
    sampleData: { prompt_id: "42", resolution: "refunded" },
  },
  {
    name: "EncryptionRotated",
    description: "Prompt encryption key version rotated.",
    dispatched: false,
    subscribable: true,
    sampleData: { prompt_id: "42", previous_version: 1, new_version: 2 },
  },
  {
    // Not subscribable: sent only to the endpoint under test.
    name: "WebhookTest",
    description: "Synthetic test event sent by POST /api/webhooks/test.",
    dispatched: false,
    subscribable: false,
    sampleData: { message: "This is a test event from PromptMint." },
  },
];

/** Event names a creator may subscribe to at registration time. */
export const SUBSCRIBABLE_WEBHOOK_EVENTS: string[] = WEBHOOK_EVENT_CATALOG.filter(
  (event) => event.subscribable,
).map((event) => event.name);

export type ReplayWarningCode =
  | "already_resolved"
  | "stale_event"
  | "unparseable_timestamp"
  | "subscription_missing"
  | "subscription_inactive";

export interface ReplayAssessment {
  /** `deliveryId` of the stored envelope — unchanged by a replay, so a receiver that already processed the event can dedupe it. */
  deliveryId: string;
  event: string;
  /** The timestamp inside the stored envelope, i.e. when the event originally occurred. */
  originalTimestamp: string;
  /** Age of the stored envelope in seconds, or null when the timestamp is unparseable. */
  ageSeconds: number | null;
  /** SHA-256 of the canonical payload JSON. Identical before and after a verbatim replay. */
  fingerprint: string;
  /** True when nothing blocks the replay. Stale events stay replayable — the receiver may not enforce the window. */
  replayable: boolean;
  /** True when the stored timestamp is already outside the documented acceptance window. */
  stale: boolean;
  warnings: ReplayWarningCode[];
}

export interface ReplayQueueItem {
  id: string;
  event: string;
  attempts: number;
  lastError: string | null;
  lastStatusCode: number | null;
  resolved: boolean;
  resolvedAt: string | null;
  replayCount: number;
  lastReplayedAt: string | null;
  createdAt: string;
  payload: WebhookPayload;
  /** Never includes the subscription secret. */
  subscription: { id: string; url: string; active: boolean } | null;
  replay: ReplayAssessment;
}

export interface ReplayQueueSummary {
  total: number;
  pending: number;
  resolved: number;
  replayable: number;
  stale: number;
}

export interface ReplayQueue {
  summary: ReplayQueueSummary;
  items: ReplayQueueItem[];
  acceptanceWindowSeconds: number;
}

export interface ReplayPreview {
  event: string;
  schemaVersion: typeof WEBHOOK_SCHEMA_VERSION;
  payload: WebhookPayload;
  /** Exact request body a receiver would verify, for this envelope. */
  body: string;
  /** Header set a receiver sees. The signature is computed per delivery from the subscription secret. */
  headers: Record<string, string>;
  acceptanceWindowSeconds: number;
}

/**
 * Deterministic JSON with sorted object keys, so two structurally equal
 * payloads fingerprint identically regardless of key insertion order. Mirrors
 * the canonical form used by the hash-chained audit log
 * (`services/auditTrail.ts`).
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 fingerprint of a stored payload, used to prove a replay was verbatim. */
export function fingerprintPayload(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

interface AssessableDeadLetter {
  event?: unknown;
  payload?: unknown;
  resolved?: unknown;
}

/**
 * Works out whether a dead letter can usefully be replayed, and what an
 * operator should know before trying.
 *
 * `subscription` is optional so the same assessment can be computed straight
 * from a stored document (tests, post-replay reporting) or from the live
 * subscription state.
 */
export function assessReplay(
  deadLetter: AssessableDeadLetter,
  options: { subscription?: { active?: boolean } | null; now?: Date } = {},
): ReplayAssessment {
  const now = options.now ?? new Date();
  const payload = (deadLetter.payload ?? {}) as Partial<WebhookPayload>;
  const event = typeof deadLetter.event === "string" ? deadLetter.event : String(payload.event ?? "unknown");
  const deliveryId = typeof payload.deliveryId === "string" ? payload.deliveryId : "unknown";
  const originalTimestamp = typeof payload.timestamp === "string" ? payload.timestamp : "";

  const warnings: ReplayWarningCode[] = [];
  const resolved = deadLetter.resolved === true;
  if (resolved) warnings.push("already_resolved");

  let ageSeconds: number | null = null;
  if (!originalTimestamp) {
    warnings.push("unparseable_timestamp");
  } else {
    const deliveredAt = Date.parse(originalTimestamp);
    if (Number.isNaN(deliveredAt)) {
      warnings.push("unparseable_timestamp");
    } else {
      ageSeconds = Math.max(0, Math.floor((now.getTime() - deliveredAt) / 1000));
      if (ageSeconds > REPLAY_ACCEPTANCE_WINDOW_SECONDS) warnings.push("stale_event");
    }
  }

  const subscription = options.subscription;
  if (subscription === null) {
    warnings.push("subscription_missing");
  } else if (subscription?.active === false) {
    warnings.push("subscription_inactive");
  }

  return {
    deliveryId,
    event,
    originalTimestamp,
    ageSeconds,
    fingerprint: fingerprintPayload(deadLetter.payload),
    replayable: !resolved,
    stale: warnings.includes("stale_event"),
    warnings,
  };
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The replay queue for one subscription: every dead letter plus the assessment
 * that decides whether replaying it is worth attempting.
 */
export async function getReplayQueue(
  subscription: { _id: unknown; url?: string; active?: boolean },
  options: { includeResolved?: boolean; limit?: number } = {},
): Promise<ReplayQueue> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const subscriptionId = String(subscription._id);

  const query: Record<string, unknown> = { subscriptionId };
  if (!options.includeResolved) query.resolved = false;

  const deadLetters = await WebhookDeadLetter.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  const now = new Date();
  const items: ReplayQueueItem[] = deadLetters.map((doc) => {
    const record = doc as unknown as Record<string, unknown>;
    return {
      id: String(record._id),
      event: String(record.event ?? ""),
      attempts: Number(record.attempts ?? 0),
      lastError: (record.lastError as string | null) ?? null,
      lastStatusCode: (record.lastStatusCode as number | null) ?? null,
      resolved: record.resolved === true,
      resolvedAt: toIso(record.resolvedAt),
      replayCount: Number(record.replayCount ?? 0),
      lastReplayedAt: toIso(record.lastReplayedAt),
      createdAt: toIso(record.createdAt) ?? "",
      payload: record.payload as WebhookPayload,
      subscription: subscription.url
        ? { id: subscriptionId, url: String(subscription.url), active: subscription.active !== false }
        : null,
      replay: assessReplay(record, { subscription, now }),
    };
  });

  return {
    summary: {
      total: items.length,
      pending: items.filter((item) => !item.resolved).length,
      resolved: items.filter((item) => item.resolved).length,
      replayable: items.filter((item) => item.replay.replayable).length,
      stale: items.filter((item) => item.replay.stale).length,
    },
    items,
    acceptanceWindowSeconds: REPLAY_ACCEPTANCE_WINDOW_SECONDS,
  };
}

/**
 * Renders the exact envelope and header set a receiver would see for `event`,
 * without contacting anything. The preview always carries a fresh
 * `deliveryId` and timestamp; replaying a dead letter re-sends the *stored*
 * envelope, so use the queue's assessment to reason about that case.
 */
export function buildReplayPreview(input: {
  event: string;
  data?: Record<string, unknown>;
}): ReplayPreview {
  const definition = WEBHOOK_EVENT_CATALOG.find((entry) => entry.name === input.event);
  if (!definition) {
    throw new Error(`Unknown webhook event: ${input.event}`);
  }

  const payload = buildWebhookPayload(definition.name, input.data ?? definition.sampleData);

  return {
    event: definition.name,
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    payload,
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
      "X-PromptHash-Signature": "<HMAC-SHA256 of body, per-delivery secret>",
      "X-PromptHash-Delivery": payload.deliveryId,
      "X-PromptHash-Event": payload.event,
      "X-PromptHash-Version": String(payload.version),
      "X-PromptHash-Schema-Version": payload.schemaVersion,
      "X-PromptHash-Timestamp": payload.timestamp,
    },
    acceptanceWindowSeconds: REPLAY_ACCEPTANCE_WINDOW_SECONDS,
  };
}
