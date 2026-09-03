# Retired: VM data migration to Sydney

This plan is cancelled. Production is built directly on Cloud Run and Cloud SQL
in `australia-southeast1`; it is not migrated from `core-central-vm`.

The VM and its Postgres database are sandbox resources. Do not:

- take a VM dump for production bootstrap;
- restore or merge VM rows into production Cloud SQL;
- copy VM Firebase users or credentials into production;
- route production DNS or vendor webhooks to the VM;
- retain the VM as a production rollback target.

Production data is created in `bp-voxtable-prod` through reviewed production
onboarding/admin flows. Schema changes run through `voxtable-prod-migrate`.
Cloud SQL backup and recovery are documented in `backup-restore.md`.

This filename remains only to stop older links from leading operators to an
unsafe procedure.
