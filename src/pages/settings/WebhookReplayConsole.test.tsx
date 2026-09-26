import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import i18n from "@/i18n";
import WebhookReplayConsolePage from "./WebhookReplayConsole";
import { renderWithProviders } from "@/test/render";

/**
 * The console's job is to tell an operator whether a replay can succeed before
 * they fire one, so these tests pin that behaviour: the queue's per-row
 * assessment is surfaced, a stale event is only offered as a re-stamped
 * replay, and the admin-gated POST is never issued without a token.
 */

// Page chrome pulls in the full nav bar; not what is under test here.
vi.mock("@/components/navigation", () => ({ Navigation: () => null }));
vi.mock("@/components/footer", () => ({ Footer: () => null }));

const WALLET = "GCREATOREXAMPLEADDRESS0000000000000000000000000000AA";

const EVENTS = {
  events: [
    {
      name: "PromptPurchased",
      description: "Listing sold.",
      dispatched: true,
      subscribable: true,
      sampleData: { prompt_id: "42" },
    },
    {
      name: "LicenseTransferred",
      description: "License transferred between wallets.",
      dispatched: false,
      subscribable: true,
      sampleData: {},
    },
  ],
  subscribable: ["PromptPurchased", "LicenseTransferred"],
  acceptanceWindowSeconds: 300,
};

function queueItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "dl1",
    event: "PromptPurchased",
    attempts: 6,
    lastError: "Webhook delivery failed with status 500",
    lastStatusCode: 500,
    resolved: false,
    resolvedAt: null,
    replayCount: 0,
    lastReplayedAt: null,
    createdAt: "2026-02-01T11:00:00.000Z",
    payload: {
      version: 1,
      schemaVersion: "2025-01-01",
      event: "PromptPurchased",
      deliveryId: "delivery-1",
      timestamp: "2026-02-01T11:59:00.000Z",
      data: { prompt_id: "42" },
    },
    subscription: { id: "sub1", url: "https://example.com/hook", active: true },
    replay: {
      deliveryId: "delivery-1",
      event: "PromptPurchased",
      originalTimestamp: "2026-02-01T11:59:00.000Z",
      ageSeconds: 60,
      fingerprint: "a".repeat(64),
      replayable: true,
      stale: false,
      warnings: [],
    },
    ...overrides,
  };
}

function queueResponse(items: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    summary: {
      total: items.length,
      pending: items.length,
      resolved: 0,
      replayable: items.length,
      stale: 0,
      ...overrides,
    },
    items,
    acceptanceWindowSeconds: 300,
  };
}

type Route = (url: string, init?: RequestInit) => Response | null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function routeFetch(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.startsWith(pattern)) {
        const res = handler(url, init);
        if (res) return res;
      }
    }
    // CurrencyProvider prices XLM on mount; keep that from failing the render.
    if (url.startsWith("https://api.coingecko.com")) {
      return json({ stellar: { usd: 0.1 } });
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("WebhookReplayConsole", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the creator to connect a wallet before showing any queue", () => {
    routeFetch({ "/api/webhooks/replay": () => json(EVENTS) });

    renderWithProviders(<WebhookReplayConsolePage />);

    expect(
      screen.getByText(/Connect your Stellar wallet to inspect the replay queue/i),
    ).toBeInTheDocument();
  });

  it("renders each dead letter with its fingerprint, age, and last error", async () => {
    routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () => json(queueResponse([queueItem()])),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    expect(await screen.findByText("PromptPurchased")).toBeInTheDocument();
    expect(screen.getByText("a".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("delivery-1")).toBeInTheDocument();
    expect(screen.getByText("60s")).toBeInTheDocument();
    expect(screen.getByText("Webhook delivery failed with status 500")).toBeInTheDocument();
    expect(screen.getByText(/6 delivery attempts/)).toBeInTheDocument();
  });

  it("offers a fresh-timestamp replay for a stale event and explains why", async () => {
    routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () =>
        json(
          queueResponse([
            queueItem({
              replay: {
                deliveryId: "delivery-1",
                event: "PromptPurchased",
                originalTimestamp: "2026-01-01T00:00:00.000Z",
                ageSeconds: 90000,
                fingerprint: "b".repeat(64),
                replayable: true,
                stale: true,
                warnings: ["stale_event"],
              },
            }),
          ]),
        ),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    expect(await screen.findByRole("button", { name: /Replay with fresh timestamp/i })).toBeInTheDocument();
    expect(screen.getByText(/older than the 300-second acceptance window/i)).toBeInTheDocument();
  });

  it("does not offer a re-stamped replay for a fresh event", async () => {
    routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () => json(queueResponse([queueItem()])),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    expect(await screen.findByRole("button", { name: /Replay verbatim/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Replay with fresh timestamp/i })).toBeNull();
  });

  it("disables replay for an already-resolved event", async () => {
    routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () =>
        json(
          queueResponse([
            queueItem({
              resolved: true,
              replay: { ...queueItem().replay, replayable: false, warnings: ["already_resolved"] },
            }),
          ]),
        ),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    expect(await screen.findByRole("button", { name: /Replay verbatim/i })).toBeDisabled();
    expect(screen.getByText(/already delivered successfully/i)).toBeInTheDocument();
  });

  it("points an unregistered wallet at the profile instead of showing an error", async () => {
    routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () =>
        json({ message: "No webhook registered for this wallet.", code: "NOT_FOUND" }, 404),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    expect(await screen.findByText(/No webhook is registered for this wallet yet/i)).toBeInTheDocument();
  });

  it("shows an empty state when nothing needs replaying", async () => {
    routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () => json(queueResponse([])),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    expect(await screen.findByText(/Every webhook delivery has landed/i)).toBeInTheDocument();
  });

  it("refuses to issue a replay when no admin token has been entered", async () => {
    const fetchMock = routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () => json(queueResponse([queueItem()])),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    await userEvent.click(await screen.findByRole("button", { name: /Replay verbatim/i }));

    expect(await screen.findByText(/Enter an admin token before replaying/i)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes("/dead-letters/")),
    ).toBe(false);
  });

  it("replays a stale event with a refreshed timestamp and reports the outcome", async () => {
    const fetchMock = routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () =>
        json(
          queueResponse([
            queueItem({
              replay: {
                ...queueItem().replay,
                ageSeconds: 90000,
                stale: true,
                warnings: ["stale_event"],
              },
            }),
          ]),
        ),
      "/api/webhooks/dead-letters/dl1/replay": () =>
        json({ success: true, replayedAt: "2026-02-01T12:00:00.000Z", refreshTimestamp: true }),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    await userEvent.type(screen.getByLabelText(/Admin API token/i), "operator-token");
    await userEvent.click(await screen.findByRole("button", { name: /Replay with fresh timestamp/i }));

    expect(await screen.findByText(/receiver accepted the event/i)).toBeInTheDocument();

    const replayCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("/dead-letters/dl1/replay"),
    );
    expect(replayCall).toBeDefined();
    expect(replayCall?.[1]?.headers).toMatchObject({ Authorization: "Bearer operator-token" });
    expect(JSON.parse(String(replayCall?.[1]?.body))).toEqual({ refreshTimestamp: true });
  });

  it("surfaces a failed replay without clearing the queue", async () => {
    routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () => json(queueResponse([queueItem()])),
      "/api/webhooks/dead-letters/dl1/replay": () =>
        json({ success: false, statusCode: 503, error: "upstream unavailable" }),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    await userEvent.type(screen.getByLabelText(/Admin API token/i), "operator-token");
    await userEvent.click(await screen.findByRole("button", { name: /Replay verbatim/i }));

    expect(await screen.findByText(/upstream unavailable/i)).toBeInTheDocument();
  });

  it("builds an envelope preview without delivering anything", async () => {
    const fetchMock = routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () => json(queueResponse([])),
      "/api/webhooks/replay/preview": () => {
        const payload = {
          version: 1,
          schemaVersion: "2025-01-01",
          event: "PromptPurchased",
          deliveryId: "preview-id",
          timestamp: "2026-02-01T12:00:00.000Z",
          data: { prompt_id: "42" },
        };
        return json({
          event: "PromptPurchased",
          schemaVersion: "2025-01-01",
          payload,
          body: JSON.stringify(payload),
          headers: { "X-PromptHash-Event": "PromptPurchased" },
          acceptanceWindowSeconds: 300,
        });
      },
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    await userEvent.click(await screen.findByRole("button", { name: /Build preview/i }));

    expect(await screen.findByText(/"deliveryId":"preview-id"/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/dead-letters/"))).toBe(false);
  });

  it("lists the catalog and marks events the indexer does not emit yet", async () => {
    routeFetch({
      "/api/webhooks/replay/events": () => json(EVENTS),
      "/api/webhooks/replay/queue": () => json(queueResponse([])),
    });

    renderWithProviders(<WebhookReplayConsolePage />, { wallet: { address: WALLET } });

    expect(await screen.findByText("LicenseTransferred")).toBeInTheDocument();
    expect(screen.getByText("Not dispatched yet")).toBeInTheDocument();
    expect(screen.getByText("Dispatched")).toBeInTheDocument();
  });
});
