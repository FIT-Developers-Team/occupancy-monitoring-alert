"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PasswordField from "@/components/ui/password-field";
import { useT } from "@/lib/i18n-client";
import type { Role } from "@/types";

type Status = "pending" | "active" | "rejected" | "disabled";
interface Account {
  id: string; username: string; name: string; email: string; role: Role; status: Status;
  created_at: string; created_by: string; updated_at: string;
  reset_requested_at?: string;
  reset_contact_email?: string;
}

const emptyForm = { name: "", username: "", email: "", password: "", role: "supervisor" as Role };

export default function AccountManagement() {
  const { t } = useT();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [resetAccount, setResetAccount] = useState<Account | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/admin/accounts", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t("accounts.loadFailed"));
      setAccounts(body.accounts ?? []);
      setSignupEnabled(Boolean(body.settings?.signup_enabled));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!formOpen && !resetAccount) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setFormOpen(false);
      setResetAccount(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [formOpen, resetAccount]);

  const pendingCount = useMemo(() => accounts.filter((item) => item.status === "pending").length, [accounts]);
  const resetCount = useMemo(() => accounts.filter((item) => item.reset_requested_at).length, [accounts]);

  async function toggleSignup() {
    const next = !signupEnabled;
    setBusyId("signup"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/accounts/signup-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t("accounts.updateFailed"));
      setSignupEnabled(next);
      setMessage(next ? t("accounts.signupOpened") : t("accounts.signupClosed"));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusyId("");
    }
  }

  async function act(account: Account, action: string, extra: Record<string, unknown> = {}) {
    setBusyId(account.id); setError(""); setMessage("");
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t("accounts.updateFailed"));
      setAccounts((items) => items.map((item) => item.id === account.id ? body.account : item));
      setMessage(t("accounts.updated"));
      if (action === "reset_password") {
        setResetAccount(null);
        setResetPassword("");
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusyId("");
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusyId("create"); setError(""); setMessage("");
    try {
      const response = await fetch("/api/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t("accounts.createFailed"));
      setAccounts((items) => [body.account, ...items]);
      setForm(emptyForm);
      setFormOpen(false);
      setMessage(t("accounts.created"));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusyId("");
    }
  }

  return (
    <div className="account-admin space-y-4">
      <div className="account-admin-summary">
        <div>
          <span className="eyebrow">{t("accounts.accessGate")}</span>
          <strong>{signupEnabled ? t("accounts.signupOpen") : t("accounts.signupClosedLabel")}</strong>
          <p>{signupEnabled ? t("accounts.signupOpenHint") : t("accounts.signupClosedHint")}</p>
        </div>
        <button className={`btn ${signupEnabled ? "btn-danger" : "btn-primary"}`} onClick={toggleSignup}
          disabled={busyId === "signup"} aria-pressed={signupEnabled}>
          {signupEnabled ? t("accounts.closeSignup") : t("accounts.openSignup")}
        </button>
      </div>

      <div className="account-admin-toolbar">
        <div className="account-admin-counts">
          <span className="chip">{accounts.length} {t("accounts.total")}</span>
          {pendingCount > 0 && <span className="badge badge-monitor">{pendingCount} {t("accounts.pending")}</span>}
          {resetCount > 0 && <span className="badge badge-warning">{resetCount} {t("accounts.resetRequests")}</span>}
        </div>
        <button className="btn btn-primary" onClick={() => { setFormOpen(true); setError(""); }}>{t("accounts.create")}</button>
      </div>

      {error && <p className="form-alert form-alert-error" role="alert">{error}</p>}
      {message && <p className="form-alert form-alert-success" role="status">{message}</p>}

      {loading ? (
        <div className="account-list-placeholder" role="status">{t("accounts.loading")}</div>
      ) : (
        <div className="account-list">
          {accounts.map((account) => (
            <article className="account-row-card" key={account.id}>
              <div className="account-row-identity">
                <div className="account-avatar" aria-hidden>{account.name.slice(0, 1).toUpperCase()}</div>
                <div className="min-w-0">
                  <div className="account-row-title">
                    <strong>{account.name}</strong>
                    <span className={`badge ${account.status === "active" ? "badge-normal" : account.status === "pending" ? "badge-monitor" : "badge-critical"}`}>
                      {t(`accounts.status.${account.status}`)}
                    </span>
                  </div>
                  <p className="num">@{account.username}{account.email ? ` · ${account.email}` : ""}</p>
                  <span>{account.role === "admin" ? t("accounts.adminView") : t("accounts.spvView")}</span>
                </div>
              </div>
              <div className="account-row-meta">
                {account.reset_requested_at && <span className="account-reset-flag">
                  {t("accounts.resetRequested")}{account.reset_contact_email ? ` · ${account.reset_contact_email}` : ""}
                </span>}
                <span>{t("accounts.createdBy")} {account.created_by}</span>
              </div>
              <div className="account-row-actions">
                {account.status === "pending" && <>
                  <button className="btn btn-primary btn-sm" disabled={busyId === account.id}
                    onClick={() => act(account, "approve")}>{t("accounts.approve")}</button>
                  <button className="btn btn-danger btn-sm" disabled={busyId === account.id}
                    onClick={() => act(account, "reject")}>{t("accounts.reject")}</button>
                </>}
                {account.status === "active" && <>
                  <select className="input account-role-select" value={account.role} aria-label={t("accounts.access")}
                    disabled={busyId === account.id}
                    onChange={(event) => act(account, "set_role", { role: event.target.value })}>
                    <option value="supervisor">{t("accounts.spvView")}</option>
                    <option value="admin">{t("accounts.adminView")}</option>
                  </select>
                  <button className="btn btn-sm" onClick={() => { setResetAccount(account); setResetPassword(""); }}>
                    {t("accounts.resetPassword")}
                  </button>
                  <button className="btn btn-danger btn-sm" disabled={busyId === account.id}
                    onClick={() => act(account, "disable")}>{t("accounts.disable")}</button>
                </>}
                {(account.status === "disabled" || account.status === "rejected") && (
                  <button className="btn btn-sm" disabled={busyId === account.id}
                    onClick={() => act(account, "activate")}>{t("accounts.activate")}</button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {formOpen && (
        <div className="modal-backdrop" onMouseDown={() => setFormOpen(false)}>
          <form className="modal-card" role="dialog" aria-modal="true" aria-labelledby="create-account-title"
            onSubmit={create} onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><span className="eyebrow">{t("accounts.adminBypass")}</span><h2 id="create-account-title">{t("accounts.createTitle")}</h2></div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFormOpen(false)}>{t("action.close")}</button>
            </div>
            <div className="account-form-grid">
              <label className="block space-y-1"><span className="eyebrow">{t("auth.fullName")}</span>
                <input className="input" value={form.name} autoComplete="name" required autoFocus onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label className="block space-y-1"><span className="eyebrow">{t("login.username")}</span>
                <input className="input" value={form.username} autoComplete="off" required pattern="[a-zA-Z0-9._-]{3,32}"
                  onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
            </div>
            <label className="block space-y-1"><span className="eyebrow">{t("auth.workEmail")}</span>
              <input className="input" type="email" value={form.email} placeholder="nama@astronauts.id" required
                pattern="[^@\s]+@astronauts\.id" onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
            <PasswordField id="admin-create-password" label={t("login.password")} value={form.password}
              onChange={(value) => setForm({ ...form, password: value })} autoComplete="new-password" minLength={5} hint={t("auth.passwordHint")} />
            <label className="block space-y-1"><span className="eyebrow">{t("accounts.access")}</span>
              <select className="input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>
                <option value="supervisor">{t("accounts.spvView")}</option><option value="admin">{t("accounts.adminView")}</option>
              </select></label>
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setFormOpen(false)}>{t("action.close")}</button>
              <button className="btn btn-primary" disabled={busyId === "create"}>{t("accounts.create")}</button>
            </div>
          </form>
        </div>
      )}

      {resetAccount && (
        <div className="modal-backdrop" onMouseDown={() => setResetAccount(null)}>
          <form className="modal-card modal-card-sm" role="dialog" aria-modal="true" aria-labelledby="reset-password-title"
            onSubmit={(event) => { event.preventDefault(); void act(resetAccount, "reset_password", { password: resetPassword }); }}
            onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <div><span className="eyebrow">@{resetAccount.username}</span><h2 id="reset-password-title">{t("accounts.resetPassword")}</h2></div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResetAccount(null)}>{t("action.close")}</button>
            </div>
            <p className="modal-copy">{t("accounts.resetHint")}</p>
            <PasswordField id="admin-reset-password" label={t("accounts.newPassword")} value={resetPassword}
              onChange={setResetPassword} autoComplete="new-password" minLength={5} hint={t("auth.passwordHint")} />
            <div className="modal-actions">
              <button type="button" className="btn" onClick={() => setResetAccount(null)}>{t("action.close")}</button>
              <button className="btn btn-primary" disabled={busyId === resetAccount.id}>{t("action.save")}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
