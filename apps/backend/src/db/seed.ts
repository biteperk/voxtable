import { env } from "../config/env";
import { closePool, pool } from "./pool";

const openingHours = {
  monday: [{ open: "17:00", close: "22:00" }],
  tuesday: [{ open: "17:00", close: "22:00" }],
  wednesday: [{ open: "17:00", close: "22:00" }],
  thursday: [{ open: "17:00", close: "22:00" }],
  friday: [{ open: "17:00", close: "23:00" }],
  saturday: [{ open: "12:00", close: "23:00" }],
  sunday: [{ open: "12:00", close: "21:00" }]
};

const faq = {
  address: "Natalia's Bistro is in Sydney. Confirm the exact street address with staff before production launch.",
  parking: "Street parking is available nearby.",
  dietary: "The restaurant can note dietary requests on the booking, but staff will confirm details.",
  groups: "Groups above 10 should be transferred to staff."
};

const voiceConfig = {
  language: "en-AU",
  voiceProvider: "retellai",
  telephonyProvider: "twilio",
  modelCandidates: ["claude-sonnet-4.6", "gpt-4o"],
  humanTransferEnabled: true
};

async function seed(): Promise<void> {
  const restaurantId = env.DEFAULT_RESTAURANT_ID;

  await pool.query(
    `
    INSERT INTO restaurants (id, name, timezone, phone_number, transfer_phone_number)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      timezone = EXCLUDED.timezone,
      phone_number = EXCLUDED.phone_number,
      transfer_phone_number = EXCLUDED.transfer_phone_number;
    `,
    [
      restaurantId,
      "Natalia's Bistro",
      "Australia/Sydney",
      env.TWILIO_PHONE_NUMBER ?? env.RETELL_PHONE_NUMBER ?? null,
      null
    ]
  );

  await pool.query(
    `
    INSERT INTO restaurant_settings (
      restaurant_id,
      booking_duration_minutes,
      opening_hours_json,
      faq_json,
      voice_config_json
    )
    VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
    ON CONFLICT (restaurant_id) DO UPDATE SET
      booking_duration_minutes = EXCLUDED.booking_duration_minutes,
      opening_hours_json = EXCLUDED.opening_hours_json,
      faq_json = EXCLUDED.faq_json,
      voice_config_json = EXCLUDED.voice_config_json;
    `,
    [
      restaurantId,
      90,
      JSON.stringify(openingHours),
      JSON.stringify(faq),
      JSON.stringify(voiceConfig)
    ]
  );

  const tables = [
    ["T1", 1, 2],
    ["T2", 1, 2],
    ["T3", 2, 4],
    ["T4", 2, 4],
    ["T5", 4, 6],
    ["T6", 6, 8],
    ["T7", 8, 10]
  ];

  for (const [label, minCapacity, maxCapacity] of tables) {
    await pool.query(
      `
      INSERT INTO tables (restaurant_id, label, min_capacity, max_capacity, is_active)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (restaurant_id, label) DO UPDATE SET
        min_capacity = EXCLUDED.min_capacity,
        max_capacity = EXCLUDED.max_capacity,
        is_active = true;
      `,
      [restaurantId, label, minCapacity, maxCapacity]
    );
  }

  console.log(`Seeded Natalia restaurant ${restaurantId}`);
}

seed()
  .then(async () => {
    await closePool();
  })
  .catch(async (error) => {
    console.error(error);
    await closePool();
    process.exit(1);
  });
