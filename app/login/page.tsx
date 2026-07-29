"use client";
import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import LangSwitch from "@/components/ui/lang-switch";
import { useT } from "@/lib/i18n-client";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { t } = useT();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        router.replace(params.get("next") || "/");
        router.refresh();
      } else {
        if (res.status === 503) setError(t("login.configError"));
        else if (res.status === 400) setError(t("login.required"));
        else if (res.status === 401) setError(t("login.invalid"));
        else setError(t("login.unavailable"));
      }
    } catch {
      setError(t("login.unavailable"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card card-pad w-full max-w-sm space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="eyebrow mb-1">Fulfillment Intelligence Team</div>
          <h1 className="text-lg font-semibold">WIOM Control Tower</h1>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            {t("login.subtitle")}
          </p>
        </div>
        <LangSwitch />
      </div>
      <label className="block space-y-1">
        <span className="eyebrow">{t("login.username")}</span>
        <input className="input" value={username} autoComplete="username"
          aria-label={t("login.username")}
          onChange={(e) => setUsername(e.target.value)} required />
      </label>
      <label className="block space-y-1">
        <span className="eyebrow">{t("login.password")}</span>
        <input className="input" type="password" value={password} autoComplete="current-password"
          aria-label={t("login.password")}
          onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && (
        <p role="alert" className="text-xs" style={{ color: "var(--st-critical-fg)" }}>{error}</p>
      )}
      <button className="btn btn-primary w-full justify-center" disabled={busy}>
        {busy ? t("login.checking") : t("login.signIn")}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
