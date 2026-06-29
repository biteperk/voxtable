import { DbClient, pool } from "../db/pool";
import { CallStatus } from "../domain/types";

export interface UpsertCallLogInput {
  restaurantId: string;
  provider?: string;
  providerCallId?: string;
  callerPhone?: string | null;
  callerName?: string | null;
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
        analysis_json,
        caller_name
      )
      VALUES ($1, $2, $3, COALESCE($4::call_status, 'started'), $5, $6, $7, $8, COALESCE($9, false), $10, $11,
              $12, $13, $14, COALESCE($15, false), $16, $17, COALESCE($18::jsonb, '{}'::jsonb), $19)
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
        analysisJson,
        input.callerName ?? null
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
      analysis_json,
      caller_name
    )
    VALUES ($1, $2, $3, $4, COALESCE($5::call_status, 'started'), $6, $7, $8, $9, COALESCE($10, false), $11, $12,
            $13, $14, $15, COALESCE($16, false), $17, $18, COALESCE($19::jsonb, '{}'::jsonb), $20)
    ON CONFLICT (provider, provider_call_id) DO UPDATE SET
      restaurant_id = EXCLUDED.restaurant_id,
      caller_phone = COALESCE(EXCLUDED.caller_phone, call_logs.caller_phone),
      caller_name = COALESCE(EXCLUDED.caller_name, call_logs.caller_name),
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
      analysisJson,
      input.callerName ?? null
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
  // Name extracted from Retell post-call analysis (covers non-booking calls).
  caller_name: string | null;
  // Name from the booking made on this call (customers.name via reservation_id).
  // Not a column — JOINed in listCallLogs / getCallLogById. Preferred for display.
  customer_name: string | null;
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
    SELECT cl.*, cust.name AS customer_name
    FROM call_logs cl
    LEFT JOIN reservations r ON r.id = cl.reservation_id
    LEFT JOIN customers cust ON cust.id = r.customer_id
    WHERE cl.restaurant_id = $1
    ORDER BY COALESCE(cl.started_at, cl.created_at) DESC
    LIMIT $2
    `,
    [input.restaurantId, limit]
  );
  return result.rows;
}

export async function getCallLogById(id: string): Promise<CallLogRow | null> {
  const result = await pool.query<CallLogRow>(
    `
    SELECT cl.*, cust.name AS customer_name
    FROM call_logs cl
    LEFT JOIN reservations r ON r.id = cl.reservation_id
    LEFT JOIN customers cust ON cust.id = r.customer_id
    WHERE cl.id = $1
    `,
    [id]
  );
  return result.rows[0] ?? null;
}

/**
 * How many calls landed for a restaurant since `sinceIso`. Used to verify
 * call-forwarding during onboarding: a test call forwarded to the restaurant's
 * VocoTable number resolves the tenant by dialed number and writes a call_log,
 * so a non-zero count proves forwarding works.
 */
export async function countCallsSince(restaurantId: string, sinceIso: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM call_logs WHERE restaurant_id = $1 AND created_at >= $2",
    [restaurantId, sinceIso]
  );
  return Number(result.rows[0]?.n ?? "0");
}

/**
 * Resolve the restaurant_id for an in-progress call from its provider call id.
 * This is the TRUSTED tenant handle for Retell tool calls: at /retell/inbound
 * we resolve the restaurant from the dialed number and persist it on this row
 * (unique on (provider, provider_call_id)), so later tool invocations recover
 * the tenant from here rather than trusting any LLM-supplied value. Returns
 * null if no row exists yet (caller falls back to server-set call metadata).
 */
export async function getRestaurantIdByProviderCallId(
  provider: string,
  providerCallId: string,
  db: DbClient = pool
): Promise<string | null> {
  const result = await db.query<{ restaurant_id: string }>(
    "SELECT restaurant_id FROM call_logs WHERE provider = $1 AND provider_call_id = $2 LIMIT 1",
    [provider, providerCallId]
  );
  return result.rows[0]?.restaurant_id ?? null;
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

export interface CallLogDailyPoint {
  date: string;
  total: number;
  confirmed: number;
}

export async function getCallLogDailySeries(input: {
  restaurantId: string;
  days?: number;
  // Restaurant-local inclusive date range (YYYY-MM-DD). When provided together
  // with `timezone`, the series spans exactly [from, to] and each call is
  // bucketed by its restaurant-local date — this is the calendar-month view.
  // Without them it falls back to a rolling window of `days` ending today.
  from?: string;
  to?: string;
  timezone?: string;
}): Promise<CallLogDailyPoint[]> {
  if (input.from && input.to && input.timezone) {
    const result = await pool.query<CallLogDailyPoint>(
      `
      WITH day_bucket AS (
        SELECT generate_series($2::date, $3::date, interval '1 day')::date AS day
      )
      SELECT
        to_char(d.day, 'YYYY-MM-DD') AS date,
        COALESCE(c.total, 0)::int    AS total,
        COALESCE(c.confirmed, 0)::int AS confirmed
      FROM day_bucket d
      LEFT JOIN (
        SELECT
          (COALESCE(started_at, created_at) AT TIME ZONE $4)::date AS day,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE booking_outcome = 'confirmed' OR reservation_id IS NOT NULL
          )::int AS confirmed
        FROM call_logs
        WHERE restaurant_id = $1
          AND (COALESCE(started_at, created_at) AT TIME ZONE $4)::date >= $2::date
          AND (COALESCE(started_at, created_at) AT TIME ZONE $4)::date <= $3::date
        GROUP BY 1
      ) c ON c.day = d.day
      ORDER BY d.day ASC
      `,
      [input.restaurantId, input.from, input.to, input.timezone]
    );
    return result.rows;
  }

  const days = Math.min(Math.max(input.days ?? 7, 1), 90);
  const result = await pool.query<CallLogDailyPoint>(
    `
    WITH day_bucket AS (
      SELECT generate_series(
        (current_date - ($2::int - 1)),
        current_date,
        interval '1 day'
      )::date AS day
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS date,
      COALESCE(c.total, 0)::int   AS total,
      COALESCE(c.confirmed, 0)::int AS confirmed
    FROM day_bucket d
    LEFT JOIN (
      SELECT
        DATE(COALESCE(started_at, created_at)) AS day,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE booking_outcome = 'confirmed' OR reservation_id IS NOT NULL
        )::int AS confirmed
      FROM call_logs
      WHERE restaurant_id = $1
        AND COALESCE(started_at, created_at) >= (current_date - ($2::int - 1))::timestamptz
      GROUP BY DATE(COALESCE(started_at, created_at))
    ) c ON c.day = d.day
    ORDER BY d.day ASC
    `,
    [input.restaurantId, days]
  );
  return result.rows;
}

// Shared aggregate projection for call-log stats — used by both the rolling
// window (`sinceDays`) and the calendar-range (`from`/`to`) variants below so
// the two can never drift apart.
const CALL_STATS_AGGREGATES = `
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
`;

export async function getCallLogStats(input: {
  restaurantId: string;
  sinceDays?: number;
  // Restaurant-local inclusive date range (YYYY-MM-DD). When provided together
  // with `timezone`, stats cover exactly [from, to] in restaurant-local time
  // (the calendar-month view); otherwise a rolling window of `sinceDays`.
  from?: string;
  to?: string;
  timezone?: string;
}): Promise<CallLogStats> {
  if (input.from && input.to && input.timezone) {
    const result = await pool.query<CallLogStats>(
      `
      SELECT ${CALL_STATS_AGGREGATES}
      FROM call_logs
      WHERE restaurant_id = $1
        AND (COALESCE(started_at, created_at) AT TIME ZONE $4)::date >= $2::date
        AND (COALESCE(started_at, created_at) AT TIME ZONE $4)::date <= $3::date
      `,
      [input.restaurantId, input.from, input.to, input.timezone]
    );
    return result.rows[0]!;
  }

  const days = Math.min(Math.max(input.sinceDays ?? 7, 1), 365);
  const result = await pool.query<CallLogStats>(
    `
    SELECT ${CALL_STATS_AGGREGATES}
    FROM call_logs
    WHERE restaurant_id = $1
      AND created_at >= now() - ($2::int || ' days')::interval
    `,
    [input.restaurantId, days]
  );
  return result.rows[0]!;
}

export interface CallLogMonthlyPoint {
  month: string; // YYYY-MM, restaurant-local
  total: number;
  confirmed: number;
}

/**
 * Per-calendar-month call totals for the last `months` months, bucketed in the
 * restaurant's local timezone (so "June" means June in Sydney, not UTC). Empty
 * months are returned as zero rows so the trend chart has a continuous x-axis.
 */
export async function getCallLogMonthlySeries(input: {
  restaurantId: string;
  months: number;
  timezone: string;
}): Promise<CallLogMonthlyPoint[]> {
  const months = Math.min(Math.max(input.months, 1), 24);
  const result = await pool.query<CallLogMonthlyPoint>(
    `
    WITH bounds AS (
      SELECT date_trunc('month', (now() AT TIME ZONE $3)) AS this_month
    ),
    month_bucket AS (
      SELECT generate_series(
        (SELECT this_month FROM bounds) - make_interval(months => ($2::int - 1)),
        (SELECT this_month FROM bounds),
        interval '1 month'
      ) AS month_start
    )
    SELECT
      to_char(b.month_start, 'YYYY-MM')  AS month,
      COALESCE(c.total, 0)::int          AS total,
      COALESCE(c.confirmed, 0)::int      AS confirmed
    FROM month_bucket b
    LEFT JOIN (
      SELECT
        date_trunc('month', (COALESCE(started_at, created_at) AT TIME ZONE $3)) AS month_start,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE booking_outcome = 'confirmed' OR reservation_id IS NOT NULL
        )::int AS confirmed
      FROM call_logs
      WHERE restaurant_id = $1
        AND (COALESCE(started_at, created_at) AT TIME ZONE $3)
            >= (SELECT this_month FROM bounds) - make_interval(months => ($2::int - 1))
      GROUP BY 1
    ) c ON c.month_start = b.month_start
    ORDER BY b.month_start ASC
    `,
    [input.restaurantId, months, input.timezone]
  );
  return result.rows;
}
