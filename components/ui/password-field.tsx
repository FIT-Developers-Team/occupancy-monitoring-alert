"use client";

import { useState } from "react";
import { useT } from "@/lib/i18n-client";

export default function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  minLength,
  required = true,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  minLength?: number;
  required?: boolean;
  hint?: string;
}) {
  const { t } = useT();
  const [visible, setVisible] = useState(false);
  // Tombol ini muncul di halaman masuk, tepat di sebelah pemilih bahasa, dan
  // teksnya sebelumnya selalu Bahasa Indonesia — jadi hal pertama yang dilihat
  // pengguna English setelah memilih bahasanya adalah kata yang tidak ikut
  // berganti.
  const action = visible ? t("field.hide") : t("field.show");
  const describe = (visible ? t("field.hideValue") : t("field.showValue"))
    .replace("{field}", label.toLocaleLowerCase());
  return (
    <label className="block space-y-1" htmlFor={id}>
      <span className="eyebrow">{label}</span>
      <span className="password-control">
        <input
          id={id}
          className="input"
          type={visible ? "text" : "password"}
          value={value}
          autoComplete={autoComplete}
          minLength={minLength}
          maxLength={128}
          required={required}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((current) => !current)}
          aria-pressed={visible}
          aria-label={describe}
        >
          {action}
        </button>
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
