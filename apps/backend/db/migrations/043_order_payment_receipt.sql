-- 043: one receipt SMS per paid order payment.
--
-- After a guest pays the Checkout link Bella texted, nothing reached them: Stripe's own
-- "Successful payments" email is switched off for this account (dashboard, 6 Sep 2026) and
-- Stripe has no SMS receipt. The backend now texts the guest the charge's hosted receipt_url
-- on the paid webhook. This column is the once-only belt: the receipt is enqueued only when
-- it is NULL and written in the same transaction, so a redelivered webhook cannot text twice.
-- Additive and nullable — the previous image runs unchanged against this schema.
ALTER TABLE order_payments
  ADD COLUMN IF NOT EXISTS receipt_notification_id UUID REFERENCES notifications_outbox(id) ON DELETE SET NULL;
