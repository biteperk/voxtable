CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS reservations;
CREATE SCHEMA IF NOT EXISTS voice;
CREATE SCHEMA IF NOT EXISTS menu_orders;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS integrations;
CREATE SCHEMA IF NOT EXISTS operations;

COMMENT ON SCHEMA core IS 'Shared restaurant, user, membership, and tenant state.';
COMMENT ON SCHEMA reservations IS 'Reservation, customer, table, availability, and seating state.';
COMMENT ON SCHEMA voice IS 'Retell, Twilio, and call-log state.';
COMMENT ON SCHEMA menu_orders IS 'Menu, ordering, and KDS state.';
COMMENT ON SCHEMA billing IS 'Stripe billing and webhook state.';
COMMENT ON SCHEMA integrations IS 'External provider inbox/outbox sync state.';
COMMENT ON SCHEMA operations IS 'Notifications, provisioning, alerts, and operational jobs.';
