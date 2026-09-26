import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  WebhookApiError,
  getWebhookReplayQueue,
  listWebhookReplayEvents,
  previewWebhookEvent,
  replayWebhookDeadLetter,
} from "./webhooks";

/**
 * Request-shape and error-propagation coverage for the replay-console client.
 * The server side is covered by server/src/tests/webhookReplayConsole.test.ts
 * and server/src/services/webhookReplay.test.ts.
 */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("webhook replay client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the static event catalog from the replay namespace", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ events: [{ name: "PromptPurchased" }], subscribable: [], acceptanceWindowSeconds: 300 }),
    );

    const result = await listWebhookReplayEvents();

    expect(fetch).toHaveBeenCalledWith("/api/webhooks/replay/events", expect.any(Object));
    expect(result.events[0].name).toBe("PromptPurchased");
  });

  it("scopes the queue to the wallet and omits the resolved flag by default", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ summary: {}, items: [] }));

    await getWebhookReplayQueue("GABC");

    expect(fetch).toHaveBeenCalledWith(
      "/api/webhooks/replay/queue?walletAddress=GABC",
      expect.any(Object),
    );
  });

  it("passes the resolved and limit options through as query params", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ summary: {}, items: [] }));

    await getWebhookReplayQueue("GABC", { includeResolved: true, limit: 10 });

    expect(fetch).toHaveBeenCalledWith(
      "/api/webhooks/replay/queue?walletAddress=GABC&resolved=true&limit=10",
      expect.any(Object),
    );
  });

  it("posts the event name to the preview endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ event: "PromptCreated" }));

    await previewWebhookEvent({ event: "PromptCreated" });

    expect(fetch).toHaveBeenCalledWith(
      "/api/webhooks/replay/preview",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ event: "PromptCreated" }) }),
    );
  });

  it("sends the admin token as a bearer credential when replaying", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, replayedAt: "now" }));

    await replayWebhookDeadLetter("dl1", { adminToken: "secret-token" });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/webhooks/dead-letters/dl1/replay");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
  });

  it("defaults refreshTimestamp to false so a replay stays verbatim", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, replayedAt: "now" }));

    await replayWebhookDeadLetter("dl1", { adminToken: "t" });

    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toEqual({
      refreshTimestamp: false,
    });
  });

  it("asks for a re-stamped envelope when refreshTimestamp is set", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, replayedAt: "now" }));

    await replayWebhookDeadLetter("dl1", { adminToken: "t", refreshTimestamp: true });

    expect(JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string)).toEqual({
      refreshTimestamp: true,
    });
  });

  it("percent-encodes the dead letter id in the path", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ success: true, replayedAt: "now" }));

    await replayWebhookDeadLetter("a/b", { adminToken: "t" });

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/webhooks/dead-letters/a%2Fb/replay");
  });

  it("surfaces the server message and error code so the UI can branch on NOT_FOUND", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ message: "No webhook registered for this wallet.", code: "NOT_FOUND" }, 404),
    );

    const error = await getWebhookReplayQueue("GABC").catch((err) => err);

    expect(error).toBeInstanceOf(WebhookApiError);
    expect(error.message).toBe("No webhook registered for this wallet.");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
  });

  it("keeps the raw body when the error response is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    const error = await listWebhookReplayEvents().catch((err) => err);

    expect(error).toBeInstanceOf(WebhookApiError);
    expect(error.message).toContain("502");
    expect(error.code).toBeUndefined();
  });
});
