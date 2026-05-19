import { DbClient, pool } from "../db/pool";
import { CallStatus } from "../domain/types";

export interface UpsertCallLogInput {
  restaurantId: string;
  provider?: string;
  providerCallId?: string;
  callerPhone?: string | null;
  status?: CallStatus;
  transcript?: string | null;
  summary?: string | null;
  recordingUrl?: string | null;
  latencyMs?: number | null;
  transferredToStaff?: boolean;
  startedAt?: string | null;
  endedAt?: string | null;
}

export async function upsertCallLog(input: UpsertCallLogInput, db: DbClient = pool): Promise<string> {
  const provider = input.provider ?? "retell";

  if (!input.providerCallId) {
    const result = await db.query<{ id: string }>(
      `
      INSERT INTO call_logs (
        restaurant_id,
        provider,
        caller_phone,
        status,
        transcript,
        summary,
        recording_url,
        latency_ms,
        transferred_to_staff,
        started_at,
        ended_at
      )
      VALUES ($1, $2, $3, COALESCE($4::call_status, 'started'), $5, $6, $7, $8, COALESCE($9, false), $10, $11)
      RETURNING id
      `,
      [
        input.restaurantId,
        provider,
        input.callerPhone ?? null,
        input.status ?? null,
        input.transcript ?? null,
        input.summary ?? null,
        input.recordingUrl ?? null,
        input.latencyMs ?? null,
        input.transferredToStaff ?? false,
        input.startedAt ?? null,
        input.endedAt ?? null
      ]
    );

    return result.rows[0]!.id;
  }

  const result = await db.query<{ id: string }>(
    `
    INSERT INTO call_logs (
      restaurant_id,
      provider,
      provider_call_id,
      caller_phone,
      status,
      transcript,
      summary,
      recording_url,
      latency_ms,
      transferred_to_staff,
      started_at,
      ended_at
    )
    VALUES ($1, $2, $3, $4, COALESCE($5::call_status, 'started'), $6, $7, $8, $9, COALESCE($10, false), $11, $12)
    ON CONFLICT (provider, provider_call_id) DO UPDATE SET
      restaurant_id = EXCLUDED.restaurant_id,
      caller_phone = COALESCE(EXCLUDED.caller_phone, call_logs.caller_phone),
      status = EXCLUDED.status,
      transcript = COALESCE(EXCLUDED.transcript, call_logs.transcript),
      summary = COALESCE(EXCLUDED.summary, call_logs.summary),
      recording_url = COALESCE(EXCLUDED.recording_url, call_logs.recording_url),
      latency_ms = COALESCE(EXCLUDED.latency_ms, call_logs.latency_ms),
      transferred_to_staff = call_logs.transferred_to_staff OR EXCLUDED.transferred_to_staff,
      started_at = COALESCE(call_logs.started_at, EXCLUDED.started_at),
      ended_at = COALESCE(EXCLUDED.ended_at, call_logs.ended_at)
    RETURNING id
    `,
    [
      input.restaurantId,
      provider,
      input.providerCallId,
      input.callerPhone ?? null,
      input.status ?? null,
      input.transcript ?? null,
      input.summary ?? null,
      input.recordingUrl ?? null,
      input.latencyMs ?? null,
      input.transferredToStaff ?? false,
      input.startedAt ?? null,
      input.endedAt ?? null
    ]
  );

  return result.rows[0]!.id;
}

export async function attachReservationToCallLog(
  callLogId: string,
  reservationId: string,
  db: DbClient = pool
): Promise<void> {
  await db.query("UPDATE call_logs SET reservation_id = $2 WHERE id = $1", [callLogId, reservationId]);
}
