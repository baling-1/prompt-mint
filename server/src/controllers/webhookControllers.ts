import { randomBytes } from "crypto";
import connectDb from "../db/connectDb";
import WebhookSubscription from "../models/WebhookSubscription";
import WebhookDelivery from "../models/WebhookDelivery";
import WebhookDeadLetter from "../models/WebhookDeadLetter";
import { AppError } from "../lib/AppError";
import { asyncRoute } from "../lib/asyncRoute";
import { validateWebhookUrl } from "../lib/validateWebhookUrl";
import { sendTestEvent, replayDeadLetter } from "../services/webhookDispatcher";
import {
  REPLAY_ACCEPTANCE_WINDOW_SECONDS,
  SUBSCRIBABLE_WEBHOOK_EVENTS,
  WEBHOOK_EVENT_CATALOG,
  buildReplayPreview,
  getReplayQueue,
} from "../services/webhookReplay";
import { isValidAdminToken } from "../services/adminAuth";
import { recordAuditEvent } from "../services/auditTrail";
import { validateBody } from "../middleware/validateRequest";
import { z } from "zod";

/**
 * Real contract events a creator can subscribe a webhook to (issue #23:
 * "listing sales, transfers, disputes, and version updates"). The catalog —
 * descriptions, sample payloads, and whether the indexer emits each event —
 * lives in `services/webhookReplay.ts` so the registration allow-list and the
 * replay console can never drift apart.
 */
const ALLOWED_EVENTS = SUBSCRIBABLE_WEBHOOK_EVENTS;

// #211 — Zod schemas for webhook request validation
const RegisterWebhookBody = z.object({
  walletAddress: z.string().trim().min(1, "walletAddress is required."),
  url: z.string().trim().url("url must be a valid URL."),
  events: z.array(z.string()).optional(),
}).strict();

const WalletAddressBody = z.object({
  walletAddress: z.string().trim().min(1, "walletAddress is required."),
}).strict();

const PreviewWebhookEventBody = z.object({
  event: z.string().trim().min(1, "event is required."),
  data: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const validateRegisterWebhook = validateBody(RegisterWebhookBody);
export const validatePreviewWebhookEvent = validateBody(PreviewWebhookEventBody);

export const RegisterWebhook = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress, url, events } = req.body;

  const urlCheck = await validateWebhookUrl(url);
  if (!urlCheck.valid) {
    throw new AppError(urlCheck.reason ?? "url is not allowed.", 400, "INVALID_INPUT");
  }

  const secret = randomBytes(32).toString("hex");
  const resolvedEvents = Array.isArray(events)
    ? events.filter((e: string) => ALLOWED_EVENTS.includes(e))
    : ["PromptPurchased"];

  const existing = await WebhookSubscription.findOne({
    walletAddress: walletAddress.toLowerCase(),
  });

  if (existing) {
    existing.url = url;
    existing.events = resolvedEvents;
    existing.active = true;
    existing.failureCount = 0;
    await existing.save();
    res.status(200).json({ message: "Webhook updated.", id: existing._id, secret });
    return;
  }

  const sub = new WebhookSubscription({
    walletAddress: walletAddress.toLowerCase(),
    url,
    secret,
    events: resolvedEvents,
  });
  await sub.save();

  res.status(201).json({ message: "Webhook registered.", id: sub._id, secret });
});

export const GetWebhook = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress } = req.query;

  if (!walletAddress) {
    throw new AppError("walletAddress query param is required.", 400, "MISSING_FIELDS");
  }

  const sub = await WebhookSubscription.findOne({
    walletAddress: String(walletAddress).toLowerCase(),
  }).select("-secret");

  if (!sub) {
    throw new AppError("No webhook registered for this wallet.", 404, "NOT_FOUND");
  }

  res.json(sub);
});

export const DeleteWebhook = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress } = req.body;

  if (!walletAddress) {
    throw new AppError("walletAddress is required.", 400, "MISSING_FIELDS");
  }

  await WebhookSubscription.deleteOne({ walletAddress: walletAddress.toLowerCase() });
  res.status(200).json({ message: "Webhook removed." });
});

/** Rotates the HMAC secret for a wallet's webhook. The old secret stops working immediately. */
export const RotateWebhookSecret = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress } = req.body;

  if (!walletAddress) {
    throw new AppError("walletAddress is required.", 400, "MISSING_FIELDS");
  }

  const sub = await WebhookSubscription.findOne({
    walletAddress: walletAddress.toLowerCase(),
  });
  if (!sub) {
    throw new AppError("No webhook registered for this wallet.", 404, "NOT_FOUND");
  }

  const secret = randomBytes(32).toString("hex");
  sub.secret = secret;
  await sub.save();

  res.status(200).json({ message: "Secret rotated.", secret });
});

/** Sends a synthetic test event to the registered endpoint and reports the outcome inline. */
export const TestWebhook = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress } = req.body;

  if (!walletAddress) {
    throw new AppError("walletAddress is required.", 400, "MISSING_FIELDS");
  }

  const sub = await WebhookSubscription.findOne({
    walletAddress: walletAddress.toLowerCase(),
  });
  if (!sub) {
    throw new AppError("No webhook registered for this wallet.", 404, "NOT_FOUND");
  }

  const result = await sendTestEvent(sub);
  res.status(200).json(result);
});

/** Lists recent delivery attempts for a wallet's webhook so creators can inspect history. */
export const GetWebhookDeliveries = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress } = req.query;

  if (!walletAddress) {
    throw new AppError("walletAddress query param is required.", 400, "MISSING_FIELDS");
  }

  const sub = await WebhookSubscription.findOne({
    walletAddress: String(walletAddress).toLowerCase(),
  });
  if (!sub) {
    throw new AppError("No webhook registered for this wallet.", 404, "NOT_FOUND");
  }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const deliveries = await WebhookDelivery.find({ subscriptionId: sub._id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json(deliveries);
});

/**
 * Reports the health of a wallet's webhook endpoint from its stored delivery
 * state: "disabled" once auto-disabled after repeated failures, "degraded"
 * while consecutive failures are outstanding, otherwise "healthy".
 */
export const GetWebhookHealth = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress } = req.query;

  if (!walletAddress) {
    throw new AppError("walletAddress query param is required.", 400, "MISSING_FIELDS");
  }

  const sub = await WebhookSubscription.findOne({
    walletAddress: String(walletAddress).toLowerCase(),
  });
  if (!sub) {
    throw new AppError("No webhook registered for this wallet.", 404, "NOT_FOUND");
  }

  const status = !sub.active ? "disabled" : sub.failureCount > 0 ? "degraded" : "healthy";
  const lastAttempt = await WebhookDelivery.findOne({ subscriptionId: sub._id })
    .sort({ createdAt: -1 })
    .select("success statusCode error createdAt")
    .lean();

  res.json({
    status,
    active: sub.active,
    failureCount: sub.failureCount,
    lastDeliveredAt: sub.lastDeliveredAt,
    lastAttempt,
  });
});

/**
 * Lists events that exhausted every delivery retry for a wallet's webhook
 * (issue #97), so a creator can see which contract events their endpoint
 * never actually received and decide whether to replay them.
 */
export const GetWebhookDeadLetters = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress } = req.query;

  if (!walletAddress) {
    throw new AppError("walletAddress query param is required.", 400, "MISSING_FIELDS");
  }

  const sub = await WebhookSubscription.findOne({
    walletAddress: String(walletAddress).toLowerCase(),
  });
  if (!sub) {
    throw new AppError("No webhook registered for this wallet.", 404, "NOT_FOUND");
  }

  const onlyUnresolved = req.query.resolved !== "true";
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const deadLetters = await WebhookDeadLetter.find({
    subscriptionId: sub._id,
    ...(onlyUnresolved ? { resolved: false } : {}),
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json(deadLetters);
});

/**
 * Lists the event catalog the replay console renders: which events a creator
 * may subscribe to, which the indexer actually emits, and a representative
 * `data` object for each. Static metadata, so it needs no wallet.
 */
export const GetWebhookReplayEvents = asyncRoute(async (_req, res) => {
  res.json({
    events: WEBHOOK_EVENT_CATALOG,
    subscribable: SUBSCRIBABLE_WEBHOOK_EVENTS,
    acceptanceWindowSeconds: REPLAY_ACCEPTANCE_WINDOW_SECONDS,
  });
});

/**
 * Replay-console read model for one wallet: every dead-lettered event plus a
 * per-row assessment of whether replaying it can succeed. Extends
 * `GET /api/webhooks/dead-letters` (raw documents) with the operator-facing
 * signal the raw rows lack — in particular whether the stored envelope is
 * already older than the receiver acceptance window documented in
 * server/docs/webhook-signatures.md, which is the usual reason a replay of an
 * old event is rejected.
 */
export const GetWebhookReplayQueue = asyncRoute(async (req, res) => {
  await connectDb();
  const { walletAddress } = req.query;

  if (!walletAddress) {
    throw new AppError("walletAddress query param is required.", 400, "MISSING_FIELDS");
  }

  const sub = await WebhookSubscription.findOne({
    walletAddress: String(walletAddress).toLowerCase(),
  });
  if (!sub) {
    throw new AppError("No webhook registered for this wallet.", 404, "NOT_FOUND");
  }

  const queue = await getReplayQueue(sub, {
    includeResolved: req.query.resolved === "true",
    limit: Number(req.query.limit) || 50,
  });

  res.json(queue);
});

/**
 * Renders the exact envelope and header set a receiver would see for an event
 * without delivering anything — the dry-run half of the console, used to build
 * a receiver against a known-good body.
 */
export const PreviewWebhookReplay = asyncRoute(async (req, res) => {
  const { event, data } = req.body as { event: string; data?: Record<string, unknown> };

  try {
    res.json(buildReplayPreview({ event, data }));
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : "Unknown webhook event.", 400, "INVALID_INPUT");
  }
});

/**
 * Re-attempts delivery of a single dead-lettered event. Admin-token gated
 * (rather than wallet-scoped like the other webhook endpoints) since it
 * triggers an outbound HTTP call on demand, same trust boundary as the
 * other admin-only actions in this codebase (see GetPromptReports).
 *
 * Body (all optional): `{ "refreshTimestamp": true }` re-stamps the envelope
 * timestamp with the current time before signing, which is required to
 * redeliver an event that has aged past a receiver's acceptance window. The
 * default re-sends the stored envelope verbatim. `deliveryId` is preserved in
 * both modes so a receiver that already processed the event can dedupe it.
 */
export const ReplayWebhookDeadLetter = asyncRoute(async (req, res) => {
  await connectDb();

  if (!isValidAdminToken(req.headers.authorization, process.env.ADMIN_API_TOKEN)) {
    void recordAuditEvent({ action: "auth_failure", result: "failure", reason: "invalid_admin_token", clientIp: req.ip });
    throw new AppError("Unauthorized: a valid admin token is required", 401);
  }

  const { id } = req.params;
  if (!id) {
    throw new AppError("Dead letter id is required.", 400, "MISSING_FIELDS");
  }

  // express.json() leaves req.body undefined for a body-less POST, and this
  // route predates request validation, so the flag is read defensively.
  const refreshTimestamp = (req.body as { refreshTimestamp?: unknown } | undefined)?.refreshTimestamp === true;

  try {
    const result = await replayDeadLetter(id, { refreshTimestamp });
    void recordAuditEvent({
      action: "admin_action",
      result: "success",
      reason: "replay_webhook_dead_letter",
      clientIp: req.ip,
      metadata: { deadLetterId: id, refreshTimestamp },
    });
    res.status(200).json({ ...result, replayedAt: new Date().toISOString(), refreshTimestamp });
  } catch (err) {
    throw new AppError(err instanceof Error ? err.message : "Replay failed.", 404, "NOT_FOUND");
  }
});
