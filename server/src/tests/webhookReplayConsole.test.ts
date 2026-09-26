import httpMocks from "node-mocks-http";

/**
 * Controller coverage for the webhook replay console: the static event
 * catalog, the wallet-scoped replay queue, the side-effect-free envelope
 * preview, and the admin-gated replay that the console drives.
 *
 * The `src/lib/api/payloadVersion` import pulled in by the dispatcher lives
 * outside this package's jest project boundary, so it is mocked here — the
 * same treatment webhookDeadLetter.test.ts gives it.
 */

jest.mock("../../../src/lib/api/payloadVersion", () => ({
  __esModule: true,
  WEBHOOK_SCHEMA_VERSION: "2025-01-01",
}));

jest.mock("../db/connectDb");
jest.mock("../models/WebhookSubscription", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../models/WebhookDelivery", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));
jest.mock("../models/WebhookDeadLetter", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));
jest.mock("../services/auditTrail", () => ({
  __esModule: true,
  recordAuditEvent: jest.fn(),
}));
jest.mock("../services/webhookDispatcher", () => ({
  __esModule: true,
  replayDeadLetter: jest.fn(),
  // The preview path builds its envelope through this helper; keep a real
  // implementation so the rendered headers are actually exercised.
  buildWebhookPayload: jest.fn((event: string, data: Record<string, unknown>) => ({
    version: 1,
    schemaVersion: "2025-01-01",
    event,
    deliveryId: "preview-delivery-id",
    timestamp: new Date().toISOString(),
    data,
  })),
}));

import connectDb from "../db/connectDb";
import WebhookSubscription from "../models/WebhookSubscription";
import WebhookDeadLetter from "../models/WebhookDeadLetter";
import { replayDeadLetter } from "../services/webhookDispatcher";
import {
  GetWebhookReplayEvents,
  GetWebhookReplayQueue,
  PreviewWebhookReplay,
  ReplayWebhookDeadLetter,
} from "../controllers/webhookControllers";

const mockFindOne = WebhookSubscription.findOne as jest.Mock;
const mockDeadLetterFind = WebhookDeadLetter.find as jest.Mock;
const mockReplayDeadLetter = replayDeadLetter as jest.Mock;

const WALLET = "GCREATOR0000000000000000000000000000000000000000000000000A";

function leanChain(result: unknown) {
  const lean = jest.fn().mockResolvedValue(result);
  const limit = jest.fn().mockReturnValue({ lean });
  const sort = jest.fn().mockReturnValue({ limit });
  mockDeadLetterFind.mockReturnValue({ sort });
  return { sort, limit };
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
    createdAt: new Date(),
    payload: {
      event: "PromptPurchased",
      deliveryId: "delivery-1",
      timestamp: new Date().toISOString(),
      data: { prompt_id: "42" },
    },
    ...overrides,
  };
}

describe("webhook replay console controllers", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, ADMIN_API_TOKEN: "the-real-admin-token" };
    (connectDb as jest.Mock).mockResolvedValue(true);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("GetWebhookReplayEvents", () => {
    it("returns the catalog, the subscribable subset, and the acceptance window", async () => {
      const res = httpMocks.createResponse();

      await GetWebhookReplayEvents(
        httpMocks.createRequest({ method: "GET", url: "/api/webhooks/replay/events" }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const body = res._getJSONData();
      expect(body.acceptanceWindowSeconds).toBe(300);
      expect(body.events.map((e: { name: string }) => e.name)).toContain("PromptPurchased");
      expect(body.subscribable).toContain("PromptCreated");
      expect(body.subscribable).not.toContain("WebhookTest");
    });

    it("needs no wallet and no database", async () => {
      await GetWebhookReplayEvents(
        httpMocks.createRequest({ method: "GET", url: "/api/webhooks/replay/events" }),
        httpMocks.createResponse(),
      );

      expect(connectDb).not.toHaveBeenCalled();
      expect(mockFindOne).not.toHaveBeenCalled();
    });
  });

  describe("GetWebhookReplayQueue", () => {
    it("rejects a request with no walletAddress", async () => {
      const res = httpMocks.createResponse();

      await GetWebhookReplayQueue(
        httpMocks.createRequest({ method: "GET", url: "/api/webhooks/replay/queue" }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData().message).toContain("walletAddress");
    });

    it("returns 404 when the wallet has never registered a webhook", async () => {
      mockFindOne.mockResolvedValue(null);
      const res = httpMocks.createResponse();

      await GetWebhookReplayQueue(
        httpMocks.createRequest({ method: "GET", url: `/api/webhooks/replay/queue?walletAddress=${WALLET}` }),
        res,
      );

      expect(res.statusCode).toBe(404);
    });

    it("scopes the query to the wallet's own subscription", async () => {
      mockFindOne.mockResolvedValue({ _id: "sub1", url: "https://example.com/hook", active: true });
      leanChain([deadLetterDoc()]);

      await GetWebhookReplayQueue(
        httpMocks.createRequest({ method: "GET", url: `/api/webhooks/replay/queue?walletAddress=${WALLET}` }),
        httpMocks.createResponse(),
      );

      expect(mockFindOne).toHaveBeenCalledWith({ walletAddress: WALLET.toLowerCase() });
      expect(mockDeadLetterFind).toHaveBeenCalledWith({ subscriptionId: "sub1", resolved: false });
    });

    it("includes resolved rows and a per-row assessment when asked", async () => {
      mockFindOne.mockResolvedValue({ _id: "sub1", url: "https://example.com/hook", active: true });
      leanChain([deadLetterDoc()]);
      const res = httpMocks.createResponse();

      await GetWebhookReplayQueue(
        httpMocks.createRequest({
          method: "GET",
          url: `/api/webhooks/replay/queue?walletAddress=${WALLET}&resolved=true`,
        }),
        res,
      );

      const body = res._getJSONData();
      expect(mockDeadLetterFind).toHaveBeenCalledWith({ subscriptionId: "sub1" });
      expect(body.items[0].replay.replayable).toBe(true);
      expect(body.items[0].replay.fingerprint).toEqual(expect.any(String));
      expect(body.items[0].subscription).toEqual({
        id: "sub1",
        url: "https://example.com/hook",
        active: true,
      });
      expect(body.summary.total).toBe(1);
    });
  });

  describe("PreviewWebhookReplay", () => {
    it("returns the body and headers a receiver would see", async () => {
      const res = httpMocks.createResponse();

      await PreviewWebhookReplay(
        httpMocks.createRequest({
          method: "POST",
          url: "/api/webhooks/replay/preview",
          body: { event: "PromptPurchased" },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const body = res._getJSONData();
      expect(body.body).toBe(JSON.stringify(body.payload));
      expect(body.headers["X-PromptHash-Event"]).toBe("PromptPurchased");
    });

    it("returns 400 for an event outside the catalog", async () => {
      const res = httpMocks.createResponse();

      await PreviewWebhookReplay(
        httpMocks.createRequest({
          method: "POST",
          url: "/api/webhooks/replay/preview",
          body: { event: "NotAnEvent" },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res._getJSONData().message).toContain("Unknown webhook event");
    });

    it("delivers nothing", async () => {
      const fetchSpy = jest.fn();
      const originalFetch = global.fetch;
      global.fetch = fetchSpy as unknown as typeof global.fetch;

      try {
        await PreviewWebhookReplay(
          httpMocks.createRequest({
            method: "POST",
            url: "/api/webhooks/replay/preview",
            body: { event: "PromptCreated" },
          }),
          httpMocks.createResponse(),
        );
      } finally {
        global.fetch = originalFetch;
      }

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("ReplayWebhookDeadLetter", () => {
    it("rejects a replay with no admin token", async () => {
      const res = httpMocks.createResponse();

      await ReplayWebhookDeadLetter(
        httpMocks.createRequest({
          method: "POST",
          url: "/api/webhooks/dead-letters/dl1/replay",
          params: { id: "dl1" },
        }),
        res,
      );

      expect(res.statusCode).toBe(401);
      expect(mockReplayDeadLetter).not.toHaveBeenCalled();
    });

    it("replays verbatim by default", async () => {
      mockReplayDeadLetter.mockResolvedValue({ success: true });
      const res = httpMocks.createResponse();

      await ReplayWebhookDeadLetter(
        httpMocks.createRequest({
          method: "POST",
          url: "/api/webhooks/dead-letters/dl1/replay",
          params: { id: "dl1" },
          headers: { authorization: "Bearer the-real-admin-token" },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(mockReplayDeadLetter).toHaveBeenCalledWith("dl1", { refreshTimestamp: false });
      expect(res._getJSONData()).toEqual(
        expect.objectContaining({ success: true, refreshTimestamp: false }),
      );
      expect(res._getJSONData().replayedAt).toEqual(expect.any(String));
    });

    it("re-stamps the envelope only when the console asks for it", async () => {
      mockReplayDeadLetter.mockResolvedValue({ success: true });

      await ReplayWebhookDeadLetter(
        httpMocks.createRequest({
          method: "POST",
          url: "/api/webhooks/dead-letters/dl1/replay",
          params: { id: "dl1" },
          headers: { authorization: "Bearer the-real-admin-token" },
          body: { refreshTimestamp: true },
        }),
        httpMocks.createResponse(),
      );

      expect(mockReplayDeadLetter).toHaveBeenCalledWith("dl1", { refreshTimestamp: true });
    });

    it("surfaces a failed delivery without turning it into an HTTP error", async () => {
      mockReplayDeadLetter.mockResolvedValue({ success: false, statusCode: 503, error: "boom" });
      const res = httpMocks.createResponse();

      await ReplayWebhookDeadLetter(
        httpMocks.createRequest({
          method: "POST",
          url: "/api/webhooks/dead-letters/dl1/replay",
          params: { id: "dl1" },
          headers: { authorization: "Bearer the-real-admin-token" },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res._getJSONData()).toEqual(
        expect.objectContaining({ success: false, statusCode: 503, error: "boom" }),
      );
    });

    it("maps a missing dead letter to 404", async () => {
      mockReplayDeadLetter.mockRejectedValue(new Error("Dead letter missing not found"));
      const res = httpMocks.createResponse();

      await ReplayWebhookDeadLetter(
        httpMocks.createRequest({
          method: "POST",
          url: "/api/webhooks/dead-letters/missing/replay",
          params: { id: "missing" },
          headers: { authorization: "Bearer the-real-admin-token" },
        }),
        res,
      );

      expect(res.statusCode).toBe(404);
    });
  });
});
