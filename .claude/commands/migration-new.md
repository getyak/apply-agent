---
description: Scaffold a new migration pair (up + down)
argument-hint: <snake_case_name>
---

# /migration-new

Generate `infra/postgres/migrations/NNN_$ARGUMENTS.up.sql` and `NNN_$ARGUMENTS.down.sql`.

Steps:
1. Find next number: `ls infra/postgres/migrations/ | grep -oE '^[0-9]{3}' | sort -n | tail -1` → +1, zero-pad to 3 digits.
2. Write `.up.sql` with template:
   ```sql
   -- Migration NNN: $ARGUMENTS
   -- Forward
   BEGIN;
   -- TODO: changes here
   COMMIT;
   ```
3. Write `.down.sql` with reverse template (DROP in reverse order).
4. Remind user to invoke `@relay-migration-guardian` before commit.
