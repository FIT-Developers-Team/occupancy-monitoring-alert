"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import LangSwitch from "@/components/ui/lang-switch";
import PasswordField from "@/components/ui/password-field";
import { useT } from "@/lib/i18n-client";

type AuthView = "login" | "signup" | "forgot";

const initialSignup = {
  name: "", username: "", email: "", password: "", confirmPassword: "",
};

function AuthPanel() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useT();
  const [view, setView] = useState<AuthView>("login");
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [signup, setSignup] = useState(initialSignup);
  const [resetEmail, setResetEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/signup-settings", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => setSignupEnabled(Boolean(body?.signupEnabled)))
      .catch(() => setSignupEnabled(false));
  }, []);

  function switchView(next: AuthView) {
    setView(next);
    setError("");
    setNotice("");
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) {
        const requested = params.get("next");
        const destination = requested?.startsWith("/") && !requested.startsWith("//") ? requested : "/";
        router.replace(destination);
        router.refresh();
        return;
      }
      if (response.status === 503) setError(t("login.configError"));
      else if (response.status === 400) setError(t("login.required"));
      else if (response.status === 429) setError(t("auth.rateLimit"));
      else if (response.status === 401) setError(t("login.invalid"));
      else setError(t("login.unavailable"));
    } catch {
      setError(t("login.unavailable"));
    } finally {
      setBusy(false);
    }
  }

  async function createSignup(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    if (signup.password !== signup.confirmPassword) {
      setError(t("auth.signup.passwordMismatch"));
      setBusy(false);
      return;
    }
    try {
      const response = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signup),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t("auth.signup.failed"));
      setSignup(initialSignup);
      setView("login");
      setNotice(t("auth.signup.submitted"));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function requestReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, email: resetEmail }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || t("auth.forgot.failed"));
      setNotice(t("auth.forgot.sent"));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-dialog" aria-labelledby="auth-title">
        <div className="auth-brand">
          <img className="auth-logo" src="/icon.svg" alt="" width="36" height="36" />
          <div>
            <div className="eyebrow">Fulfillment Intelligence Team</div>
            <div className="auth-product">FIT Occupancy Alert and Monitoring</div>
          </div>
          <LangSwitch />
        </div>

        <div className="auth-copy">
          <h1 id="auth-title">
            {view === "login" ? t("auth.login.title") : view === "signup" ? t("auth.signup.title") : t("auth.forgot.title")}
          </h1>
          <p>
            {view === "login" ? t("login.subtitle") : view === "signup" ? t("auth.signup.subtitle") : t("auth.forgot.subtitle")}
          </p>
        </div>

        {view === "login" && (
          <form onSubmit={login} className="auth-form">
            <label className="block space-y-1" htmlFor="login-username">
              <span className="eyebrow">{t("login.username")}</span>
              <input id="login-username" className="input" value={username} autoComplete="username"
                onChange={(event) => setUsername(event.target.value)} required autoFocus />
            </label>
            <PasswordField id="login-password" label={t("login.password")} value={password}
              onChange={setPassword} autoComplete="current-password" />
            <div className="auth-inline-action">
              <button type="button" onClick={() => switchView("forgot")}>{t("auth.forgot.action")}</button>
            </div>
            {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}
            {notice && <p role="status" className="form-alert form-alert-success">{notice}</p>}
            <button className="btn btn-primary w-full justify-center" disabled={busy}>
              {busy ? t("login.checking") : t("login.signIn")}
            </button>
            {signupEnabled && (
              <p className="auth-alternate">
                {t("auth.signup.prompt")} <button type="button" onClick={() => switchView("signup")}>{t("auth.signup.action")}</button>
              </p>
            )}
          </form>
        )}

        {view === "signup" && signupEnabled && (
          <form onSubmit={createSignup} className="auth-form">
            <div className="auth-field-grid">
              <label className="block space-y-1" htmlFor="signup-name">
                <span className="eyebrow">{t("auth.fullName")}</span>
                <input id="signup-name" className="input" value={signup.name} autoComplete="name" required autoFocus
                  onChange={(event) => setSignup({ ...signup, name: event.target.value })} />
              </label>
              <label className="block space-y-1" htmlFor="signup-username">
                <span className="eyebrow">{t("login.username")}</span>
                <input id="signup-username" className="input" value={signup.username} autoComplete="username" required
                  pattern="[a-zA-Z0-9._-]{3,32}" onChange={(event) => setSignup({ ...signup, username: event.target.value })} />
              </label>
            </div>
            <label className="block space-y-1" htmlFor="signup-email">
              <span className="eyebrow">{t("auth.workEmail")}</span>
              <input id="signup-email" className="input" type="email" value={signup.email} autoComplete="email"
                placeholder="nama@astronauts.id" pattern="[^@\s]+@astronauts\.id" required
                onChange={(event) => setSignup({ ...signup, email: event.target.value })} />
              <span className="field-hint">{t("auth.emailHint")}</span>
            </label>
            <div className="auth-field-grid">
              <PasswordField id="signup-password" label={t("login.password")} value={signup.password}
                onChange={(value) => setSignup({ ...signup, password: value })} autoComplete="new-password"
                minLength={5} hint={t("auth.passwordHint")} />
              <PasswordField id="signup-confirm" label={t("auth.confirmPassword")} value={signup.confirmPassword}
                onChange={(value) => setSignup({ ...signup, confirmPassword: value })} autoComplete="new-password" minLength={5} />
            </div>
            {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}
            <div className="auth-actions">
              <button type="button" className="btn" onClick={() => switchView("login")}>{t("action.back")}</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? t("auth.submitting") : t("auth.signup.submit")}</button>
            </div>
          </form>
        )}

        {view === "forgot" && (
          <form onSubmit={requestReset} className="auth-form">
            <label className="block space-y-1" htmlFor="reset-username">
              <span className="eyebrow">{t("login.username")}</span>
              <input id="reset-username" className="input" value={username} autoComplete="username" required autoFocus
                onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label className="block space-y-1" htmlFor="reset-email">
              <span className="eyebrow">{t("auth.workEmail")}</span>
              <input id="reset-email" className="input" type="email" value={resetEmail} autoComplete="email"
                placeholder="nama@astronauts.id" pattern="[^@\s]+@astronauts\.id" required
                onChange={(event) => setResetEmail(event.target.value)} />
            </label>
            {error && <p role="alert" className="form-alert form-alert-error">{error}</p>}
            {notice && <p role="status" className="form-alert form-alert-success">{notice}</p>}
            <div className="auth-actions">
              <button type="button" className="btn" onClick={() => switchView("login")}>{t("action.back")}</button>
              <button className="btn btn-primary" disabled={busy}>{busy ? t("auth.submitting") : t("auth.forgot.submit")}</button>
            </div>
          </form>
        )}

        <p className="auth-security-note">{t("auth.securityNote")}</p>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return <Suspense><AuthPanel /></Suspense>;
}
