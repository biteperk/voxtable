DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'reservation_status') THEN
    CREATE TYPE core.reservation_status AS ENUM ('pending', 'confirmed', 'cancelled', 'no_show', 'completed');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'booking_source') THEN
    CREATE TYPE core.booking_source AS ENUM ('voice', 'dashboard', 'web');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'call_status') THEN
    CREATE TYPE core.call_status AS ENUM ('started', 'in_progress', 'completed', 'failed', 'transferred');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'member_role') THEN
    CREATE TYPE core.member_role AS ENUM ('owner', 'manager', 'staff', 'server', 'kitchen');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'onboarding_status') THEN
    CREATE TYPE core.onboarding_status AS ENUM (
      'account_created',
      'profile',
      -- Migration 017. The unskippable legal step between profile and menu.
      'agreement',
      'menu',
      'trial',
      'provisioning',
      'live',
      'suspended',
      'cancelled'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'order_source') THEN
    CREATE TYPE core.order_source AS ENUM ('voice', 'waiter', 'qr', 'dashboard');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'order_status') THEN
    CREATE TYPE core.order_status AS ENUM ('pending', 'preparing', 'ready', 'served', 'cancelled');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'order_item_status') THEN
    CREATE TYPE core.order_item_status AS ENUM ('queued', 'preparing', 'ready', 'served');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'payment_status') THEN
    CREATE TYPE core.payment_status AS ENUM ('unpaid', 'paid', 'refunded');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'order_payment_status') THEN
    CREATE TYPE core.order_payment_status AS ENUM (
      'created', 'sent', 'processing', 'paid', 'expired', 'failed',
      'cancelled', 'refunded', 'disputed'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'core'::regnamespace AND typname = 'order_event_type') THEN
    CREATE TYPE core.order_event_type AS ENUM (
      'created',
      'status_changed',
      'item_status_changed',
      'payment_changed',
      'cancelled',
      'modified'
    );
  END IF;
END $$;
