"use client";
import type { OccupancyStatus, Severity } from "@/types";
import { useT } from "@/lib/i18n-client";

const occClass: Record<OccupancyStatus, string> = {
  NORMAL: "badge-normal", MONITOR: "badge-monitor", WARNING: "badge-warning",
  CRITICAL: "badge-critical", BREACH: "badge-breach",
};
export function StatusBadge({ status }: { status: OccupancyStatus }) {
  const { t } = useT();
  return <span className={`badge ${occClass[status]}`}>{t(`status.${status}`)}</span>;
}

const sevClass: Record<Severity, string> = {
  INFO: "badge-normal", WARNING: "badge-monitor", HIGH: "badge-warning",
  CRITICAL: "badge-critical", EMERGENCY: "badge-breach",
};
export function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useT();
  return <span className={`badge ${sevClass[severity]}`}>{t(`severity.${severity}`)}</span>;
}

export function AlertStatusBadge({ status }: { status: string }) {
  const { t } = useT();
  const cls =
    status === "RESOLVED" ? "badge-normal"
    : status === "ACKNOWLEDGED" ? "badge-monitor"
    : status === "FALSE_POSITIVE" ? "badge-breach"
    : "badge-warning";
  return <span className={`badge ${cls}`}>{t(`alertStatus.${status}`, status)}</span>;
}
