import assert from "node:assert/strict";
import test from "node:test";

import { listAvailableTables } from "./availability";
import { DbClient } from "../db/pool";

test("listAvailableTables returns all matching table choices for a reservation slot", async () => {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const db: DbClient = {
    async query(text, params) {
      calls.push({ text, params });
      return {
        command: "SELECT",
        rowCount: 2,
        oid: 0,
        fields: [],
        rows: [
          {
            id: "table-2",
            label: "T2",
            min_capacity: 2,
            max_capacity: 4,
            zone: "Window",
            description: "Bright corner table",
            attributes: ["window facing", "quiet"]
          },
          {
            id: "table-4",
            label: "T4",
            min_capacity: 4,
            max_capacity: 6,
            zone: "Center",
            description: null,
            attributes: []
          }
        ]
      };
    }
  };

  const tables = await listAvailableTables(
    {
      restaurantId: "restaurant-1",
      date: "2026-07-24",
      time: "19:00",
      partySize: 4,
      durationMinutes: 90,
      excludeReservationId: "00000000-0000-0000-0000-000000000001"
    },
    db
  );

  assert.deepEqual(calls[0]?.params, [
    "restaurant-1",
    4,
    "2026-07-24",
    "19:00",
    90,
    "00000000-0000-0000-0000-000000000001"
  ]);
  assert.match(calls[0]?.text ?? "", /NOT EXISTS/);
  assert.deepEqual(tables, [
    {
      id: "table-2",
      label: "T2",
      minCapacity: 2,
      maxCapacity: 4,
      zone: "Window",
      description: "Bright corner table",
      attributes: ["window facing", "quiet"]
    },
    {
      id: "table-4",
      label: "T4",
      minCapacity: 4,
      maxCapacity: 6,
      zone: "Center",
      description: null,
      attributes: []
    }
  ]);
});
