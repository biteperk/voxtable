-- RETIRED: production must never be populated from a seed file.
--
-- Create or update real customer data through an explicitly authorised
-- production onboarding/admin workflow. Test the equivalent venue and data in
-- staging. Do not copy, replay or adapt the former contents of this file.
--
-- This executable failure is intentional and keeps old command references from
-- silently writing production data.

DO $retired$
BEGIN
  RAISE EXCEPTION
    'RETIRED: production seed files are prohibited; use the authorised real-customer workflow';
END
$retired$;
