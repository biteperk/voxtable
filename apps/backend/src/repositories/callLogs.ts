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
  // Phase 9 hardening: structured post-call analysis
  intent?: string | null;
  bookingOutcome?: string | null;
  userSentiment?: string | null;
  inVoicemail?: boolean | null;
  callSuccessful?: boolean | null;
  specialRequests?: string | null;
  analysisJson?: Record<string, unknown> | null;
}

export async function upsertCallLog(input: UpsertCallLogInput, db: DbClient = pool): Promise<string> {
  const provider = input.provider ?? "retell";
  const analysisJson = input.analysisJson ? JSON.stringify(input.analysisJson) : null;

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
        ended_at,
        intent,
        booking_outcome,
        user_sentiment,
        in_voicemail,
        call_successful,
        special_requests,
        analysis_json
      )
      VALUES ($1, $2, $3, COALESCE($4::call_status, 'started'), $5, $6, $7, $8, COALESCE($9, false), $10, $11,
              $12, $13, $14, COALESCE($15, false), $16, $17, COALESCE($18::jsonb, '{}'::jsonb))
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
        input.endedAt ?? null,
        input.intent ?? null,
        input.bookingOutcome ?? null,
        input.userSentiment ?? null,
        input.inVoicemail ?? null,
        input.callSuccessful ?? null,
        input.specialRequests ?? null,
        analysisJson
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
      ended_at,
      intent,
      booking_outcome,
      user_sentiment,
      in_voicemail,
      call_successful,
      special_requests,
      analysis_json
    )
    VALUES ($1, $2, $3, $4, COALESCE($5::call_status, 'started'), $6, $7, $8, $9, COALESCE($10, false), $11, $12,
            $13, $14, $15, COALESCE($16, false), $17, $18, COALESCE($19::jsonb, '{}'::jsonb))
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
      ended_at = COALESCE(EXCLUDED.ended_at, call_logs.ended_at),
      intent = COALESCE(EXCLUDED.intent, call_logs.intent),
      booking_outcome = COALESCE(EXCLUDED.booking_outcome, call_logs.booking_outcome),
      user_sentiment = COALESCE(EXCLUDED.user_sentiment, call_logs.user_sentiment),
      in_voicemail = call_logs.in_voicemail OR EXCLUDED.in_voicemail,
      call_successful = COALESCE(EXCLUDED.call_successful, call_logs.call_successful),
      special_requests = COALESCE(EXCLUDED.special_requests, call_logs.special_requests),
      analysis_json = call_logs.analysis_json || EXCLUDED.analysis_json
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
      input.endedAt ?? null,
      input.intent ?? null,
      input.bookingOutcome ?? null,
      input.userSentiment ?? null,
      input.inVoicemail ?? null,
      input.callSuccessful ?? null,
      input.specialRequests ?? null,
      analysisJson
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

export interface CallLogRow {
  id: string;
  restaurant_id: string;
  provider: string;
  provider_call_id: string | null;
  caller_phone: string | null;
  status: CallStatus;
  transcript: string | null;
  summary: string | null;
  recording_url: string | null;
  latency_ms: number | null;
  transferred_to_staff: boolean;
  reservation_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  intent: string | null;
  booking_outcome: string | null;
  user_sentiment: string | null;
  in_voicemail: boolean;
  call_successful: boolean | null;
  special_requests: string | null;
  analysis_json: Record<string, unknown> | null;
  duration_seconds: number | null;
}

export async function listCallLogs(input: {
  restaurantId: string;
  limit?: number;
}): Promise<CallLogRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const result = await pool.query<CallLogRow>(
    `
    SELECT *
    FROM call_logs
    WHERE restaurant_id = $1
    ORDER BY COALESCE(started_at, created_at) DESC
    LIMIT $2
    `,
    [input.restaurantId, limit]
  );
  return result.rows;
}

export async function getCallLogById(id: string): Promise<CallLogRow | null> {
  const result = await pool.query<CallLogRow>("SELECT * FROM call_logs WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export interface CallLogStats {
  total_calls: number;
  handled: number;
  transferred: number;
  bookings_created: number;
  bookings_confirmed: number;
  avg_latency_ms: number | null;
  avg_duration_seconds: number | null;
  sentiment_positive: number;
  sentiment_neutral: number;
  sentiment_negative: number;
}

export async function getCallLogStats(input: {
  restaurantId: string;
  sinceDays: number;
}): Promise<CallLogStats> {
  const days = Math.min(Math.max(input.sinceDays, 1), 365);
  const result = await pool.query<CallLogStats>(
    `
    SELECT
      COUNT(*)::int AS total_calls,
      COUNT(*) FILTER (WHERE status = 'completed' AND NOT transferred_to_staff)::int AS handled,
      COUNT(*) FILTER (WHERE transferred_to_staff)::int AS transferred,
      COUNT(*) FILTER (WHERE reservation_id IS NOT NULL)::int AS bookings_created,
      COUNT(*) FILTER (WHERE booking_outcome = 'confirmed')::int AS bookings_confirmed,
      AVG(latency_ms)::int AS avg_latency_ms,
      AVG(duration_seconds)::int AS avg_duration_seconds,
      COUNT(*) FILTER (WHERE user_sentiment = 'positive')::int AS sentiment_positive,
      COUNT(*) FILTER (WHERE user_sentiment = 'neutral')::int AS sentiment_neutral,
      COUNT(*) FILTER (WHERE user_sentiment = 'negative')::int AS sentiment_negative
    FROM call_logs
    WHERE restaurant_id = $1
      AND created_at >= now() - ($2::int || ' days')::interval
    `,
    [input.restaurantId, days]
  );
  return result.rows[0]!;
}
