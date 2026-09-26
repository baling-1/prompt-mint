import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Copy,
  Fingerprint,
  Loader2,
  RefreshCw,
  Repeat,
  Send,
  Terminal,
} from "lucide-react";
import { Navigation } from "@/components/navigation";
import { Footer } from "@/components/footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useWallet } from "@/hooks/useWallet";
import { copyToClipboard } from "@/lib/clipboard/secureClipboard";
import {
  WebhookApiError,
  getWebhookReplayQueue,
  listWebhookReplayEvents,
  previewWebhookEvent,
  replayWebhookDeadLetter,
  type ReplayPreview,
  type ReplayQueueItem,
  type ReplayWarningCode,
} from "@/lib/api/webhooks";

/** Renders an ISO timestamp in the reader's locale, never a hard-coded one. */
function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined);
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "warning" | "good";
}) {
  const toneClass =
    tone === "warning" ? "text-amber-300" : tone === "good" ? "text-emerald-300" : "text-white";
  return (
    <div className="rounded-xl border border-white/10 bg-slate-950/40 p-4">
      <p className="text-[11px] uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

export default function WebhookReplayConsolePage() {
  const { t } = useTranslation();
  const { address } = useWallet();
  const queryClient = useQueryClient();

  const [adminToken, setAdminToken] = useState("");
  const [includeResolved, setIncludeResolved] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [previewEvent, setPreviewEvent] = useState("");
  const [preview, setPreview] = useState<ReplayPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const queueKey = ["webhook-replay-queue", address, includeResolved] as const;

  const eventsQuery = useQuery({
    queryKey: ["webhook-replay-events"],
    queryFn: listWebhookReplayEvents,
    staleTime: 5 * 60 * 1000,
  });

  const queueQuery = useQuery({
    queryKey: queueKey,
    queryFn: () => getWebhookReplayQueue(address as string, { includeResolved }),
    enabled: Boolean(address),
  });

  const events = eventsQuery.data?.events ?? [];
  const selectedEvent = previewEvent || events[0]?.name || "";
  const queue = queueQuery.data;
  const notRegistered =
    queueQuery.error instanceof WebhookApiError && queueQuery.error.code === "NOT_FOUND";

  const warningMessages = useMemo(() => {
    const map: Record<ReplayWarningCode, string> = {
      stale_event: t("webhook_replay.warning.stale_event", {
        seconds: queue?.acceptanceWindowSeconds ?? 300,
      }),
      already_resolved: t("webhook_replay.warning.already_resolved"),
      unparseable_timestamp: t("webhook_replay.warning.unparseable_timestamp"),
      subscription_missing: t("webhook_replay.warning.subscription_missing"),
      subscription_inactive: t("webhook_replay.warning.subscription_inactive"),
    };
    return map;
  }, [t, queue?.acceptanceWindowSeconds]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queueKey });
  };

  const handleReplay = async (item: ReplayQueueItem, refreshTimestamp: boolean) => {
    if (!adminToken.trim()) {
      setNotice({ tone: "bad", text: t("webhook_replay.admin_token_missing") });
      return;
    }
    setBusyId(item.id);
    setNotice(null);
    try {
      const result = await replayWebhookDeadLetter(item.id, {
        adminToken: adminToken.trim(),
        refreshTimestamp,
      });
      setNotice(
        result.success
          ? { tone: "good", text: t("webhook_replay.result.success") }
          : {
              tone: "bad",
              text: t("webhook_replay.result.failed", {
                error: result.error ?? t("webhook_replay.result.unknown_error"),
              }),
            },
      );
      refresh();
    } catch (err) {
      setNotice({
        tone: "bad",
        text: err instanceof Error ? err.message : t("webhook_replay.result.unknown_error"),
      });
    } finally {
      setBusyId(null);
    }
  };

  const handlePreview = async () => {
    if (!selectedEvent) return;
    setPreviewBusy(true);
    setPreviewError(null);
    try {
      setPreview(await previewWebhookEvent({ event: selectedEvent }));
    } catch (err) {
      setPreview(null);
      setPreviewError(err instanceof Error ? err.message : t("webhook_replay.result.unknown_error"));
    } finally {
      setPreviewBusy(false);
    }
  };

  const copyPreview = async () => {
    if (!preview) return;
    const res = await copyToClipboard(preview.body);
    if (res.success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }
  };

  const summary = queue?.summary;

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <Navigation />
      <main className="mx-auto max-w-5xl space-y-8 px-4 py-10">
        <header className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-400/10 text-amber-200">
            <Repeat className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{t("webhook_replay.title")}</h1>
            <p className="text-sm text-slate-400">{t("webhook_replay.subtitle")}</p>
          </div>
        </header>

        {!address ? (
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-slate-300">
            {t("webhook_replay.connect_wallet")}
          </div>
        ) : (
          <>
            {notice ? (
              <div
                className={`rounded-2xl border px-4 py-3 text-sm ${
                  notice.tone === "good"
                    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"
                    : "border-red-400/20 bg-red-500/10 text-red-200"
                }`}
              >
                {notice.text}
              </div>
            ) : null}

            <section className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-6">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1">
                  <label
                    htmlFor="admin-token"
                    className="text-xs uppercase tracking-wider text-slate-400"
                  >
                    {t("webhook_replay.admin_token_label")}
                  </label>
                  <Input
                    id="admin-token"
                    type="password"
                    autoComplete="off"
                    value={adminToken}
                    onChange={(e) => setAdminToken(e.target.value)}
                    placeholder={t("webhook_replay.admin_token_placeholder")}
                    className="border-white/10 bg-slate-950/60 text-slate-100 text-sm"
                  />
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-cyan-400"
                      checked={includeResolved}
                      onChange={(e) => setIncludeResolved(e.target.checked)}
                    />
                    {t("webhook_replay.include_resolved")}
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={refresh}
                    className="border-white/10 hover:bg-white/5"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t("webhook_replay.refresh")}
                  </Button>
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                {t("webhook_replay.admin_token_help")}
              </p>
            </section>

            {notRegistered ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-slate-300">
                {t("webhook_replay.register_first")}
              </div>
            ) : queueQuery.isLoading ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-slate-300">
                {t("webhook_replay.loading")}
              </div>
            ) : (
              <>
                <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <StatCard
                    label={t("webhook_replay.summary.pending")}
                    value={summary?.pending ?? 0}
                    tone="warning"
                  />
                  <StatCard
                    label={t("webhook_replay.summary.replayable")}
                    value={summary?.replayable ?? 0}
                    tone="good"
                  />
                  <StatCard
                    label={t("webhook_replay.summary.stale")}
                    value={summary?.stale ?? 0}
                    tone={summary?.stale ? "warning" : "default"}
                  />
                  <StatCard
                    label={t("webhook_replay.summary.resolved")}
                    value={summary?.resolved ?? 0}
                    tone="default"
                  />
                </section>

                <p className="flex items-start gap-2 text-[11px] leading-relaxed text-slate-500">
                  <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {t("webhook_replay.acceptance_window", {
                    seconds: queue?.acceptanceWindowSeconds ?? 300,
                  })}
                </p>

                {queueQuery.isError ? (
                  <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    {queueQuery.error instanceof Error
                      ? queueQuery.error.message
                      : t("webhook_replay.result.unknown_error")}
                  </div>
                ) : null}

                {queue && queue.items.length === 0 ? (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-slate-400">
                    {t("webhook_replay.empty")}
                  </div>
                ) : (
                  <ul className="space-y-3">
                    {(queue?.items ?? []).map((item) => (
                      <li
                        key={item.id}
                        className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-5"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-base font-semibold">{item.event}</span>
                              {item.resolved ? (
                                <Badge className="border-emerald-400/30 bg-emerald-500/15 text-emerald-200">
                                  {t("webhook_replay.badge.resolved")}
                                </Badge>
                              ) : null}
                              {item.replay.stale ? (
                                <Badge className="border-amber-400/30 bg-amber-500/15 text-amber-200">
                                  {t("webhook_replay.badge.stale")}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="text-xs text-slate-400">
                              {t("webhook_replay.row.dead_lettered", {
                                date: formatTimestamp(item.createdAt),
                              })}{" "}
                              ·{" "}
                              {t("webhook_replay.row.attempts", { count: item.attempts })}
                            </p>
                          </div>

                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-white/10 hover:bg-white/5 text-xs"
                              disabled={!item.replay.replayable || busyId === item.id}
                              onClick={() => void handleReplay(item, false)}
                            >
                              {busyId === item.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Repeat className="h-3.5 w-3.5" />
                              )}
                              {t("webhook_replay.row.replay_verbatim")}
                            </Button>
                            {item.replay.stale ? (
                              <Button
                                size="sm"
                                className="bg-amber-300 text-slate-950 hover:bg-amber-200 text-xs font-semibold"
                                disabled={!item.replay.replayable || busyId === item.id}
                                onClick={() => void handleReplay(item, true)}
                              >
                                {busyId === item.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Send className="h-3.5 w-3.5" />
                                )}
                                {t("webhook_replay.row.replay_restamp")}
                              </Button>
                            ) : null}
                          </div>
                        </div>

                        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
                          <div className="flex items-center gap-2 text-slate-400">
                            <Fingerprint className="h-3.5 w-3.5 shrink-0" />
                            <dt className="sr-only">{t("webhook_replay.row.fingerprint")}</dt>
                            <dd className="truncate font-mono text-slate-300" title={item.replay.fingerprint}>
                              {item.replay.fingerprint}
                            </dd>
                          </div>
                          <div className="text-slate-400">
                            <dt className="inline">{t("webhook_replay.row.delivery_id")}:</dt>{" "}
                            <dd className="inline font-mono text-slate-300">
                              {item.replay.deliveryId}
                            </dd>
                          </div>
                          <div className="text-slate-400">
                            <dt className="inline">{t("webhook_replay.row.age")}:</dt>{" "}
                            <dd className="inline text-slate-300">
                              {formatAge(item.replay.ageSeconds)}
                            </dd>
                          </div>
                          <div className="text-slate-400">
                            <dt className="inline">{t("webhook_replay.row.replay_count")}:</dt>{" "}
                            <dd className="inline text-slate-300">{item.replayCount}</dd>
                            {item.lastReplayedAt ? (
                              <span className="ml-1">
                                ({t("webhook_replay.row.last_replayed", {
                                  date: formatTimestamp(item.lastReplayedAt),
                                })})
                              </span>
                            ) : null}
                          </div>
                        </dl>

                        {item.lastError ? (
                          <div className="space-y-1">
                            <p className="text-xs text-slate-400">
                              {t("webhook_replay.row.last_error")}
                              {item.lastStatusCode
                                ? ` — ${t("webhook_replay.row.status_code", {
                                    code: item.lastStatusCode,
                                  })}`
                                : ""}
                            </p>
                            <pre className="overflow-x-auto rounded-xl border border-white/5 bg-slate-950 p-3 font-mono text-xs text-rose-200">
                              {item.lastError}
                            </pre>
                          </div>
                        ) : null}

                        {item.replay.warnings.length > 0 ? (
                          <div className="space-y-1 rounded-xl border border-amber-400/20 bg-amber-500/5 p-3">
                            <p className="flex items-center gap-2 text-xs font-medium text-amber-200">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {t("webhook_replay.row.warnings_label")}
                            </p>
                            <ul className="list-disc space-y-1 pl-8 text-[11px] text-amber-100/80">
                              {item.replay.warnings.map((warning) => (
                                <li key={warning}>{warningMessages[warning]}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        <details className="text-xs">
                          <summary className="cursor-pointer text-slate-400 hover:text-slate-200">
                            {t("webhook_replay.row.payload")}
                          </summary>
                          <pre className="mt-2 max-h-64 overflow-auto rounded-xl border border-white/5 bg-slate-950 p-3 font-mono text-[11px] text-slate-300">
                            {JSON.stringify(item.payload, null, 2)}
                          </pre>
                        </details>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}

        <section className="space-y-4 rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-cyan-300" />
            <h2 className="text-lg font-semibold">{t("webhook_replay.preview.title")}</h2>
          </div>
          <p className="text-sm text-slate-400">{t("webhook_replay.preview.description")}</p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 space-y-1">
              <label
                htmlFor="preview-event"
                className="text-xs uppercase tracking-wider text-slate-400"
              >
                {t("webhook_replay.preview.event_label")}
              </label>
              <select
                id="preview-event"
                value={selectedEvent}
                onChange={(e) => {
                  setPreviewEvent(e.target.value);
                  setPreview(null);
                }}
                className="h-10 w-full rounded-md border border-white/10 bg-slate-950/60 px-3 py-2 text-sm text-slate-100"
              >
                {events.map((event) => (
                  <option key={event.name} value={event.name}>
                    {event.name}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handlePreview()}
              disabled={previewBusy || !selectedEvent}
              className="border-white/10 hover:bg-white/5"
            >
              {previewBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {t("webhook_replay.preview.build")}
            </Button>
          </div>

          {previewError ? (
            <div className="rounded-xl border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {previewError}
            </div>
          ) : null}

          {preview ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase tracking-wider text-slate-400">
                  {t("webhook_replay.preview.body")}
                </p>
                <button
                  type="button"
                  onClick={() => void copyPreview()}
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-white"
                >
                  {copied ? (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? t("webhook_replay.preview.copied") : t("webhook_replay.preview.copy")}
                </button>
              </div>
              <pre className="overflow-x-auto rounded-xl border border-white/5 bg-slate-950 p-3 font-mono text-xs text-slate-300">
                {preview.body}
              </pre>
              <p className="text-xs uppercase tracking-wider text-slate-400">
                {t("webhook_replay.preview.headers")}
              </p>
              <pre className="overflow-x-auto rounded-xl border border-white/5 bg-slate-950 p-3 font-mono text-xs text-slate-300">
                {JSON.stringify(preview.headers, null, 2)}
              </pre>
            </div>
          ) : null}

          <p className="text-[11px] leading-relaxed text-slate-500">
            {t("webhook_replay.preview.note")}
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("webhook_replay.catalog.title")}</h2>
          <p className="text-sm text-slate-400">{t("webhook_replay.catalog.description")}</p>
          <ul className="space-y-2">
            {events.map((event) => (
              <li
                key={event.name}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
              >
                <div>
                  <p className="font-mono text-sm text-slate-200">{event.name}</p>
                  <p className="text-xs text-slate-400">{event.description}</p>
                </div>
                <Badge
                  variant="outline"
                  className={
                    event.dispatched
                      ? "border-emerald-400/30 text-emerald-200"
                      : "border-white/10 text-slate-400"
                  }
                >
                  {event.dispatched
                    ? t("webhook_replay.catalog.dispatched")
                    : t("webhook_replay.catalog.undispatched")}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      </main>
      <Footer />
    </div>
  );
}
