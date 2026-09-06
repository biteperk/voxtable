-- 044: short branded links for the payment and receipt texts.
--
-- The link SMS carried a ~400-character Stripe Checkout URL and the receipt SMS a
-- ~110-character receipt URL: unreadable, 3 and 2 SMS segments. Each payment row now
-- mints an unguessable public_token; the texts carry /pay/<token> and /receipt/<token>
-- on the dashboard host, which Firebase Hosting rewrites to the API for a 302 to Stripe.
-- The token is deliberately NOT the order id: order ids are visible in the KDS, the
-- dashboard and Retell transcripts, while a checkout URL is a live pay capability and
-- the receipt shows card last-4 and items. receipt_url is stored so the receipt link
-- can be resolved later (it was fetched once and dropped before). Both nullable,
-- additive; rows without a token were texted raw URLs and keep working.
ALTER TABLE order_payments
  ADD COLUMN IF NOT EXISTS public_token TEXT,
  ADD COLUMN IF NOT EXISTS receipt_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_payments_public_token
  ON order_payments (public_token) WHERE public_token IS NOT NULL;
