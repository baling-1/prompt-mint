/**
 * Tests for the webhook replay console read model.
 *
 * The queue endpoint exists because `GET /api/webhooks/dead-letters` returns
 * raw documents, which say *that* a delivery failed but not whether replaying
 * it can succeed. `assessReplay` answers that up front: a stored envelope's
 * timestamp never changes on a verbatim replay, so a dead letter that has aged
 * past the documented receiver acceptance window is flagged stale, and the
 * payload fingerprint lets an operator prove a replay was byte-identical.
 *
 * `../../../src/lib/api/payloadVersion` lives outside this package's
 * tsconfig/jest project boundary, so it is mocked here rather than exercised
 * for real — mirroring webhookDispatcher.test.ts.
 */

jest.mock("../../../src/lib/api/payloadVersion", () => ({
  __esModule: true,
  WEBHOOK_SCHEMA_VERSION: "2025-01-01",
}));

jest.mock("../models/WebhookDeadLetter", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

import WebhookDeadLetter from "../models/WebhookDeadLetter";
import {
  REPLAY_ACCEPTANCE_WINDOW_SECONDS,
  SUBSCRIBABLE_WEBHOOK_EVENTS,
  WEBHOOK_EVENT_CATALOG,
  assessReplay,
  buildReplayPreview,
  fingerprintPayload,
  getReplayQueue,
} from "./webhookReplay";

const mockFind = WebhookDeadLetter.find as jest.Mock;

const NOW = new Date("2026-02-01T12:00:00.000Z");
const NOW_MS = NOW.getTime();

function isoSecondsAgo(seconds: number): string {
  return new Date(NOW_MS - seconds * 1000).toISOString();
}

/** Wires `WebhookDeadLetter.find().sort().limit().lean()` to return `result`. */
function leanChain(result: unknown) {
  const lean = jest.fn().mockResolvedValue(result);
  const limit = jest.fn().mockReturnValue({ lean });
  const sort = jest.fn().mockReturnValue({ limit });
  mockFind.mockReturnValue({ sort });
  return { sort, limit, lean };
}

function deadLetterDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: "dl1",
    subscriptionId: "sub1",
    event: "PromptPurchased",
    attempts: 6,
    lastError: "Webhook delivery failed with status 500",
    lastStatusCode: 500,
    resolved: false,
    resolvedAt: null,
    replayCount: 0,
    lastReplayedAt: null,
    createdAt: new Date("2026-01-31T09:00:00.000Z"),
    payload: {
      version: 1,
      schemaVersion: "2025-01-01",
      event: "PromptPurchased",
      deliveryId: "delivery-1",
      timestamp: isoSecondsAgo(60),
      data: { prompt_id: "42" },
    },
    ...overrides,
  };
}

describe("WEBHOOK_EVENT_CATALOG", () => {
  it("covers every event the registration allow-list accepts", () => {
    for (const name of SUBSCRIBABLE_WEBHOOK_EVENTS) {
      expect(WEBHOOK_EVENT_CATALOG.some((event) => event.name === name)).toBe(true);
    }
  });

  it("keeps WebhookTest out of the subscribable set because it is sent only to the endpoint under test", () => {
    expect(SUBSCRIBABLE_WEBHOOK_EVENTS).not.toContain("WebhookTest");
    expect(WEBHOOK_EVENT_CATALOG.find((e) => e.name === "WebhookTest")?.subscribable).toBe(false);
  });

  it("does not duplicate event names", () => {
    const names = WEBHOOK_EVENT_CATALOG.map((event) => event.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every event a description and a sample payload", () => {
    for (const event of WEBHOOK_EVENT_CATALOG) {
      expect(event.description.length).toBeGreaterThan(0);
      expect(typeof event.sampleData).toBe("object");
    }
  });
});

describe("fingerprintPayload", () => {
  it("is stable across key insertion order", () => {
    expect(fingerprintPayload({ a: 1, b: { c: 2, d: 3 } })).toBe(
      fingerprintPayload({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("changes when a single field changes", () => {
    expect(fingerprintPayload({ prompt_id: "42" })).not.toBe(
      fingerprintPayload({ prompt_id: "43" }),
    );
  });
});

describe("assessReplay", () => {
  it("marks a fresh dead letter replayable with no warnings", () => {
    const assessment = assessReplay(deadLetterDoc(), { subscription: { active: true }, now: NOW });

    expect(assessment.replayable).toBe(true);
    expect(assessment.stale).toBe(false);
    expect(assessment.warnings).toEqual([]);
    expect(assessment.deliveryId).toBe("delivery-1");
    expect(assessment.ageSeconds).toBe(60);
  });

  it("flags a dead letter that has aged past the acceptance window", () => {
    const doc = deadLetterDoc({
      payload: {
        event: "PromptPurchased",
        deliveryId: "delivery-1",
        timestamp: isoSecondsAgo(REPLAY_ACCEPTANCE_WINDOW_SECONDS + 60),
        data: {},
      },
    });

    const assessment = assessReplay(doc, { subscription: { active: true }, now: NOW });

    expect(assessment.stale).toBe(true);
    expect(assessment.warnings).toContain("stale_event");
    // Stale is a warning, not a block: the receiver may not enforce the window.
    expect(assessment.replayable).toBe(true);
  });

  it("does not flag an envelope exactly at the window boundary", () => {
    const doc = deadLetterDoc({
      payload: {
        event: "PromptPurchased",
        deliveryId: "delivery-1",
        timestamp: isoSecondsAgo(REPLAY_ACCEPTANCE_WINDOW_SECONDS),
        data: {},
      },
    });

    expect(assessReplay(doc, { now: NOW }).stale).toBe(false);
  });

  it("blocks replay of an already-resolved dead letter", () => {
    const assessment = assessReplay(deadLetterDoc({ resolved: true }), { now: NOW });

    expect(assessment.replayable).toBe(false);
    expect(assessment.warnings).toContain("already_resolved");
  });

  it("reports an unparseable timestamp instead of throwing", () => {
    const doc = deadLetterDoc({
      payload: { event: "PromptPurchased", deliveryId: "d", timestamp: "not-a-date", data: {} },
    });

    const assessment = assessReplay(doc, { now: NOW });

    expect(assessment.ageSeconds).toBeNull();
    expect(assessment.warnings).toContain("unparseable_timestamp");
  });

  it("warns when the subscription is gone or paused", () => {
    expect(assessReplay(deadLetterDoc(), { subscription: null }).warnings).toContain(
      "subscription_missing",
    );
    expect(assessReplay(deadLetterDoc(), { subscription: { active: false } }).warnings).toContain(
      "subscription_inactive",
    );
  });

  it("keeps the fingerprint stable so a verbatim replay can be proven byte-identical", () => {
    const doc = deadLetterDoc();

    expect(assessReplay(doc, { now: NOW }).fingerprint).toBe(fingerprintPayload(doc.payload));

    // Same envelope, keys in a different insertion order: the digest must not
    // move, otherwise a stored envelope and its replayed copy would not match.
    const payload = doc.payload as Record<string, unknown>;
    const reordered = { ...doc, payload: Object.fromEntries(Object.entries(payload).reverse()) };
    expect(assessReplay(reordered, { now: NOW }).fingerprint).toBe(
      assessReplay(doc, { now: NOW }).fingerprint,
    );
  });
});

describe("getReplayQueue", () => {
  const subscription = { _id: "sub1", url: "https://example.com/hook", active: true };

  beforeEach(() => {
    jest.clearAllMocks();
    // getReplayQueue stamps assessments with the wall clock; pin it so the
    // stale/fresh split below is deterministic.
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns an assessment per dead letter and a matching summary", async () => {
    leanChain([
      deadLetterDoc(),
      deadLetterDoc({
        _id: "dl2",
        resolved: true,
        resolvedAt: new Date("2026-01-31T10:00:00.000Z"),
        payload: {
          event: "PromptCreated",
          deliveryId: "delivery-2",
          timestamp: isoSecondsAgo(REPLAY_ACCEPTANCE_WINDOW_SECONDS * 10),
          data: {},
        },
      }),
    ]);

    const queue = await getReplayQueue(subscription, { includeResolved: true });

    expect(queue.items).toHaveLength(2);
    expect(queue.items[0].id).toBe("dl1");
    expect(queue.items[0].replay.replayable).toBe(true);
    expect(queue.items[0].replay.stale).toBe(false);
    expect(queue.items[1].replay.replayable).toBe(false);
    expect(queue.items[1].replay.stale).toBe(true);
    expect(queue.summary).toEqual({ total: 2, pending: 1, resolved: 1, replayable: 1, stale: 1 });
    expect(queue.acceptanceWindowSeconds).toBe(REPLAY_ACCEPTANCE_WINDOW_SECONDS);
  });

  it("hides resolved dead letters unless they are explicitly requested", async () => {
    leanChain([deadLetterDoc()]);

    await getReplayQueue(subscription);

    expect(mockFind).toHaveBeenCalledWith({ subscriptionId: "sub1", resolved: false });
  });

  it("clamps the requested limit to a sane range", async () => {
    const high = leanChain([]);
    await getReplayQueue(subscription, { limit: 100_000 });
    expect(high.limit).toHaveBeenCalledWith(200);

    const low = leanChain([]);
    await getReplayQueue(subscription, { limit: 0 });
    expect(low.limit).toHaveBeenCalledWith(1);
  });

  it("never exposes the subscription secret", async () => {
    leanChain([deadLetterDoc()]);

    // A real document carries the secret; the read model must not echo it back.
    const subscription = {
      _id: "sub1",
      url: "https://example.com/hook",
      active: true,
      secret: "super-secret",
    };
    const queue = await getReplayQueue(subscription);

    expect(JSON.stringify(queue)).not.toContain("super-secret");
    expect(queue.items[0].subscription).toEqual({
      id: "sub1",
      url: "https://example.com/hook",
      active: true,
    });
  });
});

describe("buildReplayPreview", () => {
  it("returns the exact body a receiver would verify for a known event", () => {
    const preview = buildReplayPreview({ event: "PromptPurchased" });

    expect(preview.event).toBe("PromptPurchased");
    expect(preview.body).toBe(JSON.stringify(preview.payload));
    expect(preview.headers["X-PromptHash-Delivery"]).toBe(preview.payload.deliveryId);
    expect(preview.headers["X-PromptHash-Event"]).toBe("PromptPurchased");
    expect(preview.headers["X-PromptHash-Schema-Version"]).toBe("2025-01-01");
    expect(preview.acceptanceWindowSeconds).toBe(REPLAY_ACCEPTANCE_WINDOW_SECONDS);
  });

  it("uses the catalog sample data unless the caller overrides it", () => {
    expect(buildReplayPreview({ event: "PromptPriceUpdated" }).payload.data).toEqual({
      prompt_id: "42",
      price_stroops: 30000000,
    });
    expect(buildReplayPreview({ event: "PromptPriceUpdated", data: { prompt_id: "7" } }).payload.data).toEqual({
      prompt_id: "7",
    });
  });

  it("issues a fresh deliveryId per preview so two previews are distinguishable", () => {
    const first = buildReplayPreview({ event: "PromptCreated" });
    const second = buildReplayPreview({ event: "PromptCreated" });

    expect(first.payload.deliveryId).not.toBe(second.payload.deliveryId);
  });

  it("rejects an event that is not in the catalog", () => {
    expect(() => buildReplayPreview({ event: "NotAnEvent" })).toThrow("Unknown webhook event");
  });
});
