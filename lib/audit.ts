import { stateExec, uid } from "@/lib/db";

export async function audit(
  actor: string,
  action: string,
  entity: string,
  before?: unknown,
  after?: unknown
): Promise<void> {
  await stateExec(
    "INSERT INTO audit_log VALUES (?, now(), ?, ?, ?, ?, ?)",
    [
      uid("aud-"),
      actor,
      action,
      entity,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after),
    ]
  );
}
