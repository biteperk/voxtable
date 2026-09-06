-- 043: one receipt SMS per paid order payment.
--
-- After a guest pays the Checkout link Bella texted, nothing reached them by text: Stripe
-- has no SMS receipt, and its "Successful payments" email was off for the live account until
-- 6 Sep 2026 (now on, so guests get text + email). The backend texts the guest the charge's
-- hosted receipt_url on the paid webhook. This column is the once-only belt: the receipt is enqueued only when
-- it is NULL and written in the same transaction, so a redelivered webhook cannot text twice.
-- Additive and nullable — the previous image runs unchanged against this schema.
ALTER TABLE order_payments
  ADD COLUMN IF NOT EXISTS receipt_notification_id UUID REFERENCES notifications_outbox(id) ON DELETE SET NULL;
