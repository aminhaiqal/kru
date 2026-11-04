# Frozen SQLite fixtures

The numbered SQL dumps preserve older schemas, data and event payloads for
migration/replay tests. Do not regenerate an existing fixture with current code.

`v7.sql` was captured with the Store implementation at release `v0.1.1`
(`bc3753a81b15ba7ece963112debccb5b66521afc`), upgrading the existing v5 routed
conversation fixture through its original v6/v7 migrations, then using SQLite
`.dump`. It includes the original event prefix, routed messages/reply record,
native cache binding, logical threads and turn links. M7 tests apply migration
v8 to this frozen input and inject failure at its migration marker.

`v8.sql` freezes that v7 database after applying the unchanged
`008-recovery.sql` migration and its schema-migration marker, before expanded M6
code runs. It was captured on 2026-11-05 with SQLite `.dump`. M6 tests apply v9,
inject marker failure, preserve the original event prefix, exercise ambiguous
legacy bindings and verify replay twice. Do not regenerate it with schema v9.
