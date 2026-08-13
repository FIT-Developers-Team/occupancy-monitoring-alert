"use client";

import { useState } from "react";

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
  const [visible, setVisible] = useState(false);
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
          aria-label={visible ? `Sembunyikan ${label.toLowerCase()}` : `Tampilkan ${label.toLowerCase()}`}
        >
          {visible ? "Sembunyikan" : "Tampilkan"}
        </button>
      </span>
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
