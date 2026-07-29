import { DbClient, pool } from "../db/pool";

/**
 * Legal-layer persistence (migration 018): the restaurant's CURRENT Order-Form
 * elections (mutable — a re-acceptance overwrites them) and the APPEND-ONLY
 * acceptance ledger (immutable history; UPDATE/DELETE raise via trigger).
 */

export interface AgreementElections {
  clientLegalName: string;
  clientAbn: string;
  services: string[];
  phoneMode: string;
  deliveryTargets: unknown;
  retentionDays: number;
  storageTier: string;
  piiRedaction: boolean;
  serviceStartDate: string | null;
}

export interface AcceptanceInsert {
  restaurantId: string;
  userId: string;
  channel: "online" | "offline";
  documentSetVersion: string;
  csaSha256: string;
  scheduleSha256: string;
  consentTerms: boolean;
  consentOverseas: boolean;
  consentDisclosure: boolean;
  ipAddress: string | null;
  userAgent: string | null;
  orderForm: unknown;
}

export interface AcceptanceRow {
  id: string;
  restaurant_id: string;
  user_id: string;
  accepted_at: string;
  channel: string;
  document_set_version: string;
  csa_sha256: string;
  schedule_sha256: string;
  order_form_json: Record<string, unknown>;
  order_form_pdf_url: string | null;
}

export async function saveAgreementElections(
  restaurantId: string,
  elections: AgreementElections,
  termsVersion: string,
  db: DbClient = pool
): Promise<void> {
  await db.query(
    `
    UPDATE restaurants SET
      client_legal_name = $2,
      client_abn = $3,
      services = $4,
      phone_mode = $5,
      delivery_targets = $6::jsonb,
      retention_days = $7,
      storage_tier = $8,
      pii_redaction = $9,
      service_start_date = $10,
      terms_version = $11
    WHERE id = $1
    `,
    [
      restaurantId,
      elections.clientLegalName,
      elections.clientAbn,
      elections.services,
      elections.phoneMode,
      JSON.stringify(elections.deliveryTargets ?? {}),
      elections.retentionDays,
      elections.storageTier,
      elections.piiRedaction,
      elections.serviceStartDate,
      termsVersion
    ]
  );
}

export async function insertAcceptance(
  input: AcceptanceInsert,
  db: DbClient = pool
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `
    INSERT INTO agreement_acceptances (
      restaurant_id, user_id, channel, document_set_version,
      csa_sha256, schedule_sha256,
      consent_terms, consent_overseas, consent_disclosure,
      ip_address, user_agent, order_form_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
    RETURNING id
    `,
    [
      input.restaurantId,
      input.userId,
      input.channel,
      input.documentSetVersion,
      input.csaSha256,
      input.scheduleSha256,
      input.consentTerms,
      input.consentOverseas,
      input.consentDisclosure,
      input.ipAddress,
      input.userAgent,
      JSON.stringify(input.orderForm ?? {})
    ]
  );
  return result.rows[0]!.id;
}

export async function getLatestAcceptance(
  restaurantId: string,
  db: DbClient = pool
): Promise<AcceptanceRow | null> {
  const result = await db.query<AcceptanceRow>(
    `
    SELECT id, restaurant_id, user_id, accepted_at, channel,
           document_set_version, csa_sha256, schedule_sha256,
           order_form_json, order_form_pdf_url
      FROM agreement_acceptances
     WHERE restaurant_id = $1
     ORDER BY accepted_at DESC
     LIMIT 1
    `,
    [restaurantId]
  );
  return result.rows[0] ?? null;
}
