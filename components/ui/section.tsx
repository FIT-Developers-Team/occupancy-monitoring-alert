import type { ReactNode } from "react";

export default function Section({
  title, eyebrow, action, children, variant = "panel",
}: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  variant?: "panel" | "plain";
}) {
  return (
    <section className={`section section-${variant}${variant === "panel" ? " card" : ""}`}>
      <div className="section-head">
        <div>
          {eyebrow && <div className="eyebrow mb-0.5">{eyebrow}</div>}
          <h2 className="panel-title">{title}</h2>
        </div>
        {action}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}
