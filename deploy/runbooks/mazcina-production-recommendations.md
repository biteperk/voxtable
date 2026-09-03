# Retired: Mazcina VM procedure

The former procedure treated `core-central-vm` as production. That assumption was incorrect and
all VM deployment, SQL, configuration and rollback instructions have been removed.

Apply any required Mazcina production settings through the `bp-voxtable-prod` admin API, Cloud SQL,
Terraform/Secret Manager and BitePerk production vendor accounts. Test the equivalent change and
call path on the staging venue twin. Production receives only non-mutating health/readiness checks,
configuration read-back and monitoring of genuine customer activity. Never migrate sandbox rows
or create test data in production.
