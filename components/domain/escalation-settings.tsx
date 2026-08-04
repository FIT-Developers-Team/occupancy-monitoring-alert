"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n-client";
import { isGoogleChatWebhookUrl } from "@/lib/notify/gchat-url";

interface GoogleChatRoute {
  id: string;
  label: string;
  enabled: boolean;
  warehouse_codes: string[];
  webhook_url: string;
  mention_user_ids: string[];
  /** Warehouse PIC addresses; shown on the card, cannot become a Chat ping. */
  mention_emails: string[];
}

interface EscalationLevel {
  level: number;
  name: string;
  delay_minutes: number;
  gchat_routes: GoogleChatRoute[];
  gchat_webhooks: string[];
  emails: string[];
  webhooks: string[];
}

interface RecipientsConfig {
  levels: EscalationLevel[];
  severity_start_level: Record<string, number>;
}

interface DeliveryStatus {
  summary: {
    levels: number;
    routes: number;
    enabled_routes: number;
    coverage: Record<string, number>;
  };
  logs: { at: string; status: string; recipient: string; message: string }[];
}

type Feedback = { tone: "ok" | "error" | "info"; text: string } | null;

function routeId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function splitValues(value: string): string[] {
  return [...new Set(value.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean))];
}

function formatLogTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function migrateLegacy(config: RecipientsConfig): RecipientsConfig {
  return {
    ...config,
    levels: config.levels.map((level) => ({
      ...level,
      gchat_routes: [
        ...(level.gchat_routes ?? []),
        ...(level.gchat_webhooks ?? []).map((webhookUrl, index) => ({
          id: `legacy-${level.level}-${index + 1}`,
          label: `Google Chat L${level.level}`,
          enabled: true,
          warehouse_codes: ["*"],
          webhook_url: webhookUrl,
          mention_user_ids: [],
          mention_emails: [],
        })),
      ],
      gchat_webhooks: [],
    })),
  };
}

export default function EscalationSettings() {
  const { t, lang } = useT();
  const [config, setConfig] = useState<RecipientsConfig | null>(null);
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [delivery, setDelivery] = useState<DeliveryStatus | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [attemptedSave, setAttemptedSave] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const initialJson = useRef("");

  async function refreshStatus(): Promise<void> {
    const response = await fetch("/api/notifications/gchat", { cache: "no-store" });
    if (response.ok) setDelivery(await response.json());
  }

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/config/recipients", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/config/warehouses", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/notifications/gchat", { cache: "no-store" }).then((response) => response.json()),
    ]).then(([recipientBody, warehouseBody, statusBody]) => {
      if (!active) return;
      if (!recipientBody.data) throw new Error(recipientBody.error || t("set.ui.loadError"));
      const migrated = migrateLegacy(recipientBody.data as RecipientsConfig);
      setConfig(migrated);
      initialJson.current = JSON.stringify(migrated);
      setWarehouses((warehouseBody.data?.warehouses ?? []).map((item: { code: string }) => item.code));
      if (statusBody.summary) setDelivery(statusBody as DeliveryStatus);
    }).catch((error) => {
      if (active) setFeedback({ tone: "error", text: (error as Error).message });
    });
    return () => { active = false; };
    // Load once per mount. A language switch must not discard unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(
    () => Boolean(config) && JSON.stringify(config) !== initialJson.current,
    [config],
  );
  const routeCount = config?.levels.reduce((total, level) => total + level.gchat_routes.length, 0) ?? 0;
  const enabledRouteCount = config?.levels.reduce(
    (total, level) => total + level.gchat_routes.filter((route) => route.enabled).length,
    0,
  ) ?? 0;

  function updateLevel(index: number, patch: Partial<EscalationLevel>): void {
    if (!config) return;
    const levels = [...config.levels];
    levels[index] = { ...levels[index], ...patch };
    setConfig({ ...config, levels });
  }

  function updateRoute(levelIndex: number, routeIndex: number, patch: Partial<GoogleChatRoute>): void {
    if (!config) return;
    const level = config.levels[levelIndex];
    const routes = [...level.gchat_routes];
    routes[routeIndex] = { ...routes[routeIndex], ...patch };
    updateLevel(levelIndex, { gchat_routes: routes });
  }

  function applyLevelOrder(levelsInNewOrder: EscalationLevel[]): void {
    if (!config) return;
    const oldToNew = new Map(levelsInNewOrder.map((level, index) => [level.level, index + 1]));
    const levels = levelsInNewOrder.map((level, index) => ({
      ...level,
      level: index + 1,
      delay_minutes: index === 0 ? 0 : Math.max(1, level.delay_minutes),
    }));
    const severityStart = Object.fromEntries(
      Object.entries(config.severity_start_level).map(([severity, oldLevel]) => [
        severity,
        oldToNew.get(oldLevel) ?? Math.min(oldLevel, levels.length),
      ]),
    );
    setConfig({ ...config, levels, severity_start_level: severityStart });
  }

  function moveLevel(index: number, direction: -1 | 1): void {
    if (!config) return;
    const target = index + direction;
    if (target < 0 || target >= config.levels.length) return;
    const levels = [...config.levels];
    [levels[index], levels[target]] = [levels[target], levels[index]];
    applyLevelOrder(levels);
  }

  function removeLevel(index: number): void {
    if (!config || config.levels.length === 1) return;
    applyLevelOrder(config.levels.filter((_, itemIndex) => itemIndex !== index));
  }

  function toggleWarehouse(levelIndex: number, routeIndex: number, warehouse: string): void {
    if (!config) return;
    const current = config.levels[levelIndex].gchat_routes[routeIndex].warehouse_codes;
    if (warehouse === "*") {
      updateRoute(levelIndex, routeIndex, { warehouse_codes: ["*"] });
      return;
    }
    const scoped = current.filter((code) => code !== "*");
    const next = scoped.includes(warehouse)
      ? scoped.filter((code) => code !== warehouse)
      : [...scoped, warehouse];
    updateRoute(levelIndex, routeIndex, { warehouse_codes: next.length ? next : ["*"] });
  }

  function addRoute(levelIndex: number): void {
    if (!config) return;
    const level = config.levels[levelIndex];
    updateLevel(levelIndex, {
      gchat_routes: [...level.gchat_routes, {
        id: routeId(),
        label: `${t("set.ui.recipients.googleChat")} ${level.gchat_routes.length + 1}`,
        enabled: true,
        warehouse_codes: ["*"],
        webhook_url: "",
        mention_user_ids: [],
        mention_emails: [],
      }],
    });
  }

  function removeRoute(levelIndex: number, routeIndex: number): void {
    if (!config) return;
    const level = config.levels[levelIndex];
    updateLevel(levelIndex, { gchat_routes: level.gchat_routes.filter((_, index) => index !== routeIndex) });
  }

  async function testRoute(level: EscalationLevel, route: GoogleChatRoute): Promise<void> {
    if (!isGoogleChatWebhookUrl(route.webhook_url.trim())) {
      setFeedback({ tone: "error", text: t("set.ui.recipients.webhookRequired") });
      return;
    }
    setTesting(route.id);
    setFeedback({ tone: "info", text: t("set.ui.recipients.testing") });
    try {
      const response = await fetch("/api/notifications/gchat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          webhook_url: route.webhook_url,
          mention_user_ids: route.mention_user_ids,
          mention_emails: route.mention_emails,
          label: route.label,
          warehouse_code: route.warehouse_codes.includes("*")
            ? t("set.ui.recipients.allWarehouses")
            : route.warehouse_codes.join(", "),
          level: level.level,
        }),
      });
      const body = await response.json().catch(() => ({}));
      setFeedback({
        tone: response.ok ? "ok" : "error",
        text: response.ok ? t("set.ui.recipients.testSuccess") : body.error || t("set.ui.recipients.testFailed"),
      });
    } catch (error) {
      setFeedback({ tone: "error", text: (error as Error).message || t("set.ui.recipients.testFailed") });
    } finally {
      setTesting(null);
    }
  }

  async function save(): Promise<void> {
    if (!config) return;
    const incomplete = config.levels.flatMap((level) => level.gchat_routes)
      .find((route) => !route.label.trim() || !isGoogleChatWebhookUrl(route.webhook_url.trim()) || route.warehouse_codes.length === 0);
    if (incomplete) {
      setAttemptedSave(true);
      setFeedback({ tone: "error", text: t("set.ui.recipients.incompleteRoute") });
      return;
    }
    setBusy(true);
    setFeedback({ tone: "info", text: t("set.ui.saving") });
    try {
      const response = await fetch("/api/config/recipients", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t("set.ui.saveError"));
      const saved = migrateLegacy(body.data as RecipientsConfig);
      setConfig(saved);
      setAttemptedSave(false);
      initialJson.current = JSON.stringify(saved);
      setFeedback({ tone: "ok", text: t("set.ui.recipients.saved") });
      await refreshStatus().catch(() => undefined);
    } catch (error) {
      setFeedback({ tone: "error", text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!config) {
    return (
      <div className="settings-panel-loading" role="status" aria-live="polite">
        <div className="settings-panel-loading-head"><span /><strong /></div>
        <div className="settings-panel-loading-grid"><span /><span /></div>
        <span className="sr-only">{t("set.ui.loading")}</span>
      </div>
    );
  }

  return (
    <div className="escalation-settings">
      <section className="escalation-mode" aria-labelledby="escalation-mode-title">
        <div>
          <span className="eyebrow">{t("set.ui.recipients.activeTrigger")}</span>
          <h3 id="escalation-mode-title">{t("set.ui.recipients.zoneBreachOnly")}</h3>
          <p>{t("set.ui.recipients.zoneBreachDescription")}</p>
        </div>
        <div className="escalation-mode-facts">
          <div><span>{t("set.ui.recipients.levels")}</span><strong className="num">{config.levels.length}</strong></div>
          <div><span>{t("set.ui.recipients.routes")}</span><strong className="num">{enabledRouteCount}/{routeCount}</strong></div>
          <label>
            <span>{t("set.ui.recipients.breachStartsAt")}</span>
            <select
              className="input"
              value={config.severity_start_level.CRITICAL ?? 1}
              onChange={(event) => setConfig({
                ...config,
                severity_start_level: {
                  ...config.severity_start_level,
                  CRITICAL: Number(event.target.value),
                },
              })}>
              {config.levels.map((level) => (
                <option key={level.level} value={level.level}>L{level.level} · {level.name}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="escalation-coverage" aria-labelledby="escalation-coverage-title">
        <div>
          <span className="eyebrow">{t("set.ui.recipients.routeCoverage")}</span>
          <h3 id="escalation-coverage-title">{t("set.ui.recipients.autoTagPerWarehouse")}</h3>
        </div>
        <div className="escalation-coverage-chips">
          {warehouses.map((warehouse) => {
            const count = config.levels.reduce((total, level) => total + level.gchat_routes.filter((route) =>
              route.enabled && (route.warehouse_codes.includes("*") || route.warehouse_codes.includes(warehouse))).length, 0);
            return (
              <span key={warehouse} className={`chip ${count ? "chip-accent" : "escalation-chip-missing"}`}>
                <b>{warehouse}</b> · {count || t("set.ui.recipients.noRoute")}
              </span>
            );
          })}
        </div>
      </section>

      <div className="escalation-levels">
        {config.levels.map((level, levelIndex) => (
          <section className="escalation-level" key={level.level} data-testid={`escalation-level-${level.level}`} aria-labelledby={`level-${level.level}-title`}>
            <header className="escalation-level-head">
              <span className="escalation-level-number">L{level.level}</span>
              <div>
                <label className="sr-only" htmlFor={`level-name-${level.level}`}>{t("set.ui.recipients.tierName")}</label>
                <input
                  id={`level-name-${level.level}`}
                  className="input escalation-level-name"
                  value={level.name}
                  onChange={(event) => updateLevel(levelIndex, { name: event.target.value })}
                />
                <p id={`level-${level.level}-title`}>
                  {level.level === 1
                    ? t("set.ui.recipients.immediate")
                    : t("set.ui.recipients.advanceAfter")}
                </p>
              </div>
              <label className="escalation-delay">
                <span>{t("set.ui.recipients.delay")}</span>
                <span><input
                  type="number"
                  min={level.level === 1 ? 0 : 1}
                  className="input num"
                  value={level.delay_minutes}
                  disabled={level.level === 1}
                  onChange={(event) => updateLevel(levelIndex, { delay_minutes: Number(event.target.value) })}
                /> {t("set.ui.recipients.minutes")}</span>
              </label>
              <div className="escalation-level-actions" aria-label={t("set.ui.recipients.levelActions")}>
                <button className="btn btn-ghost btn-sm" disabled={levelIndex === 0} onClick={() => moveLevel(levelIndex, -1)} aria-label={t("set.ui.recipients.moveUp")}>{t("set.ui.recipients.moveUpShort")}</button>
                <button className="btn btn-ghost btn-sm" disabled={levelIndex === config.levels.length - 1} onClick={() => moveLevel(levelIndex, 1)} aria-label={t("set.ui.recipients.moveDown")}>{t("set.ui.recipients.moveDownShort")}</button>
                <button className="btn btn-ghost btn-sm" disabled={config.levels.length === 1} onClick={() => removeLevel(levelIndex)}>{t("set.ui.recipients.removeLevel")}</button>
              </div>
            </header>

            <div className="escalation-route-list">
              {level.gchat_routes.length === 0 && (
                <div className="escalation-empty">
                  <strong>{t("set.ui.recipients.noGoogleChatRoute")}</strong>
                  <span>{t("set.ui.recipients.noGoogleChatRouteHint")}</span>
                </div>
              )}
              {level.gchat_routes.map((route, routeIndex) => {
                const routeKey = `${level.level}:${route.id}`;
                return (
                  <article className={`escalation-route ${route.enabled ? "" : "is-disabled"}`} key={route.id}>
                    <div className="escalation-route-head">
                      <label className="sync-toggle">
                        <input type="checkbox" checked={route.enabled} onChange={(event) => updateRoute(levelIndex, routeIndex, { enabled: event.target.checked })} />
                        <span>{t("set.ui.recipients.routeActive")}</span>
                      </label>
                      <button className="btn btn-ghost btn-sm" onClick={() => removeRoute(levelIndex, routeIndex)}>{t("set.ui.recipients.removeRoute")}</button>
                    </div>
                    <div className="escalation-route-grid">
                      <label>
                        <span>{t("set.ui.recipients.routeName")}</span>
                        <input className="input" aria-invalid={attemptedSave && !route.label.trim()} value={route.label} onChange={(event) => updateRoute(levelIndex, routeIndex, { label: event.target.value })} />
                      </label>
                      <label className="escalation-webhook-field">
                        <span>{t("set.ui.recipients.webhookUrl")}</span>
                        <span className="escalation-secret-row">
                          <input
                            className="input num"
                            aria-invalid={attemptedSave && !isGoogleChatWebhookUrl(route.webhook_url.trim())}
                            type={revealed.has(routeKey) ? "text" : "password"}
                            autoComplete="off"
                            placeholder="https://chat.googleapis.com/v1/spaces/..."
                            value={route.webhook_url}
                            onChange={(event) => updateRoute(levelIndex, routeIndex, { webhook_url: event.target.value.trim() })}
                          />
                          <button className="btn btn-sm" type="button" onClick={() => setRevealed((current) => {
                            const next = new Set(current);
                            if (next.has(routeKey)) next.delete(routeKey); else next.add(routeKey);
                            return next;
                          })}>{revealed.has(routeKey) ? t("set.ui.recipients.hide") : t("set.ui.recipients.show")}</button>
                        </span>
                        {attemptedSave && !isGoogleChatWebhookUrl(route.webhook_url.trim()) && (
                          <small className="escalation-field-error">{t("set.ui.recipients.webhookInvalid")}</small>
                        )}
                      </label>
                      <fieldset className="escalation-wh-scope">
                        <legend>{t("set.ui.recipients.warehouseScope")}</legend>
                        <div>
                          {["*", ...warehouses].map((warehouse) => {
                            const selected = route.warehouse_codes.includes(warehouse);
                            return (
                              <label key={warehouse} className={`chip escalation-choice ${selected ? "chip-accent" : ""}`}>
                                <input type="checkbox" checked={selected} onChange={() => toggleWarehouse(levelIndex, routeIndex, warehouse)} />
                                <span>{warehouse === "*" ? t("set.ui.recipients.allWarehouses") : warehouse}</span>
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                      <label>
                        <span>{t("set.ui.recipients.mentionIds")}</span>
                        <textarea
                          className="input num escalation-mentions"
                          rows={2}
                          placeholder="12345678901234567890, all"
                          value={route.mention_user_ids.join(", ")}
                          onChange={(event) => updateRoute(levelIndex, routeIndex, { mention_user_ids: splitValues(event.target.value) })}
                        />
                        <small>{t("set.ui.recipients.mentionHint")}</small>
                      </label>
                      <label>
                        <span>{t("set.ui.recipients.mentionEmails")}</span>
                        <textarea
                          className="input escalation-mentions"
                          rows={2}
                          placeholder="ops.cbt@astronauts.id, spv.cbt@astronauts.id"
                          value={route.mention_emails.join(", ")}
                          onChange={(event) => updateRoute(levelIndex, routeIndex, { mention_emails: splitValues(event.target.value) })}
                        />
                        <small>{t("set.ui.recipients.mentionEmailsHint")}</small>
                      </label>
                    </div>
                    <div className="escalation-route-footer">
                      <span>{route.warehouse_codes.includes("*") ? t("set.ui.recipients.allWarehouses") : route.warehouse_codes.join(" · ")}</span>
                      <button className="btn btn-sm" disabled={testing === route.id} onClick={() => testRoute(level, route)}>
                        {testing === route.id ? t("set.ui.recipients.testing") : t("set.ui.recipients.testConnection")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="escalation-level-footer">
              <button className="btn btn-sm" data-testid={`add-gchat-route-${level.level}`} onClick={() => addRoute(levelIndex)}>+ {t("set.ui.recipients.addGoogleChatRoute")}</button>
              <details>
                <summary>{t("set.ui.recipients.otherChannels")}</summary>
                <div className="escalation-other-grid">
                  <label><span>{t("set.ui.recipients.email")}</span><textarea className="input" rows={2} value={level.emails.join(", ")} onChange={(event) => updateLevel(levelIndex, { emails: splitValues(event.target.value) })} /></label>
                  <label><span>{t("set.ui.recipients.otherWebhook")}</span><textarea className="input num" rows={2} value={level.webhooks.join(", ")} onChange={(event) => updateLevel(levelIndex, { webhooks: splitValues(event.target.value) })} /></label>
                </div>
              </details>
            </div>
          </section>
        ))}
      </div>

      <button className="btn escalation-add-level" onClick={() => setConfig({
        ...config,
        levels: [...config.levels, {
          level: config.levels.length + 1,
          name: `${t("set.ui.recipients.level")} ${config.levels.length + 1}`,
          delay_minutes: 30,
          gchat_routes: [],
          gchat_webhooks: [],
          emails: [],
          webhooks: [],
        }],
      })}>+ {t("set.ui.recipients.addLevel")}</button>

      {delivery?.logs.length ? (
        <details className="escalation-delivery-log">
          <summary>{t("set.ui.recipients.recentDelivery")}</summary>
          <ul>
            {delivery.logs.map((log, index) => (
              <li key={`${log.at}-${index}`}>
                <span className={`sync-test-dot ${log.status === "SENT" ? "is-ok" : "is-error"}`} aria-hidden="true" />
                <div><strong>{log.recipient}</strong><span>{log.message}</span></div>
                <time dateTime={log.at}>{formatLogTime(log.at, lang === "en" ? "en-GB" : "id-ID")}</time>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {(dirty || feedback) && (
        <div className="escalation-savebar">
          <div aria-live="polite">
            {feedback && <p className={`escalation-feedback is-${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.text}</p>}
            {!feedback && <p>{t("set.ui.recipients.unsaved")}</p>}
          </div>
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>
            {busy ? t("set.ui.saving") : t("set.ui.recipients.save")}
          </button>
        </div>
      )}
    </div>
  );
}
