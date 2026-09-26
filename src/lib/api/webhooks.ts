/**
 * Client for the webhook replay console endpoints.
 *
 * Mirrors the server contract in `server/src/services/webhookReplay.ts` and
 * `server/src/controllers/webhookControllers.ts`. Types are declared here
 * rather than imported because `src/lib` may not depend on `server/` — see
 * the boundary rules in `docs/monorepo-map.md`.
 *
 * Replaying is admin-gated server-side, so the caller supplies an operator
 * token. It is only ever held in memory by the console; this module does not
 * persist it.
 */

export interface WebhookEventDefinition {
  /** Event name as it appears in the envelope's `event` field. */
  name: string;
  description: string;
  /** Whether the indexer currently emits this event. */
  dispatched: boolean;
  /** Whether a creator may list this event when registering a subscription. */
  subscribable: boolean;
  /** Representative `data` object, so the envelope shape can be previewed. */
  sampleData: Record<string, unknown>;
}

export type ReplayWarningCode =
  | "already_resolved"
  | "stale_event"
  | "unparseable_timestamp"
  | "subscription_missing"
  | "subscription_inactive";

export interface ReplayAssessment {
  /** Unchanged by a replay, so a receiver that already processed the event can dedupe it. */
  deliveryId: string;
  event: string;
  originalTimestamp: string;
  ageSeconds: number | null;
  /** SHA-256 of the canonical payload JSON; identical before and after a verbatim replay. */
  fingerprint: string;
  replayable: boolean;
  /** True when the stored envelope is already past the receiver acceptance window. */
  stale: boolean;
  warnings: ReplayWarningCode[];
}

export interface WebhookPayload {
  version?: number;
  schemaVersion: string;
  event: string;
  deliveryId: string;
  timestamp: string;
  data: Record<string, unknown>;
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
  /** Age beyond which a receiver following the documented rules rejects a delivery. */
  acceptanceWindowSeconds: number;
}

export interface ReplayPreview {
  event: string;
  schemaVersion: string;
  payload: WebhookPayload;
  /** Exact request body a receiver would verify, for this envelope. */
  body: string;
  /** Header set a receiver sees. The signature is computed per delivery from the subscription secret. */
  headers: Record<string, string>;
  acceptanceWindowSeconds: number;
}

export interface ReplayResult {
  success: boolean;
  statusCode?: number;
  error?: string;
  replayedAt: string;
  refreshTimestamp: boolean;
}

const BASE = "/api/webhooks";

/**
 * Carries the server's HTTP status and error code so the console can tell
 * "no webhook registered for this wallet" (NOT_FOUND) apart from a real
 * failure, instead of matching on message text.
 */
export class WebhookApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WebhookApiError";
  }
}

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Request failed with status ${response.status}.`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(text) as { message?: string; code?: string };
      if (parsed.message) message = parsed.message;
      code = parsed.code;
    } catch {
      // Non-JSON error body (proxy error page, empty response) — keep the raw text.
    }
    throw new WebhookApiError(message, response.status, code);
  }
  return response.json() as Promise<T>;
}

/** Static event catalog. Needs no wallet. */
export function listWebhookReplayEvents(): Promise<{
  events: WebhookEventDefinition[];
  subscribable: string[];
  acceptanceWindowSeconds: number;
}> {
  return json(`${BASE}/replay/events`);
}

/**
 * Replay queue for a wallet's subscription. `includeResolved` adds rows that
 * were already replayed successfully.
 */
export function getWebhookReplayQueue(
  walletAddress: string,
  options: { includeResolved?: boolean; limit?: number } = {},
): Promise<ReplayQueue> {
  const params = new URLSearchParams({ walletAddress });
  if (options.includeResolved) params.set("resolved", "true");
  if (options.limit) params.set("limit", String(options.limit));
  return json(`${BASE}/replay/queue?${params.toString()}`);
}

/**
 * Renders the envelope and headers a receiver would see, without delivering
 * anything. Useful for building a receiver against a known-good body.
 */
export function previewWebhookEvent(input: {
  event: string;
  data?: Record<string, unknown>;
}): Promise<ReplayPreview> {
  return json(`${BASE}/replay/preview`, { method: "POST", body: JSON.stringify(input) });
}

/**
 * Replays one dead-lettered event.
 *
 * `refreshTimestamp` re-stamps the envelope with the current time before
 * signing, which is what makes redelivery of an event older than the
 * receiver's acceptance window possible. The default re-sends the stored
 * envelope verbatim.
 */
export function replayWebhookDeadLetter(
  id: string,
  input: { adminToken: string; refreshTimestamp?: boolean },
): Promise<ReplayResult> {
  return json(`${BASE}/dead-letters/${encodeURIComponent(id)}/replay`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.adminToken}`,
    },
    body: JSON.stringify({ refreshTimestamp: input.refreshTimestamp === true }),
  });
}
