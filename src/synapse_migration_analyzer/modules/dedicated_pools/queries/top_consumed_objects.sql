-- Top consumed tables / views on a dedicated SQL pool.
--
-- Costs reduced vs. the naive form by:
--   1. Deduping sys.dm_pdw_sql_requests to one row per request_id (the DMV
--      returns one row per distribution -- ~60x amplification on Gen2).
--   2. Time-bounding via sys.dm_pdw_exec_requests so M shrinks to the last
--      14 days instead of the full ~10 000-row buffer.
--   3. Filtering out system / internal commands once, up front.
--   4. Pre-building the entity list with a delimited "schema.name" token so
--      the LIKE only fires on qualified references and ignores substrings
--      of unrelated identifiers (e.g. a table called "id" no longer matches
--      every query).
--   5. Counting DISTINCT request_id so the result is request-level, not
--      distribution-level.
--
-- Output contract: object_name (schema.name), object_type ('table'|'view'),
-- usage_count (distinct requests). Consumed by collectors/top_consumed_objects.py.

WITH cmds AS (
    SELECT DISTINCT
           q.request_id,
           -- Pad with spaces so the leading/trailing entity boundary check
           -- in the LIKE pattern below works at the start/end of a command.
           ' ' + LOWER(REPLACE(REPLACE(q.command, '[', ''), ']', '')) + ' ' AS cmd
    FROM   sys.dm_pdw_sql_requests AS q
    JOIN   sys.dm_pdw_exec_requests AS r
           ON r.request_id = q.request_id
    WHERE  q.command IS NOT NULL
      AND  q.command NOT LIKE 'EXEC %sp[_]%'      -- system procs
      AND  q.command NOT LIKE '%--%internal%'     -- internal system queries
      AND  r.submit_time >= DATEADD(DAY, -14, SYSUTCDATETIME())
),
entities AS (
    SELECT 'table' AS object_type,
           TABLE_SCHEMA AS schema_name,
           TABLE_NAME   AS entity_name,
           LOWER(TABLE_SCHEMA) + '.' + LOWER(TABLE_NAME) AS qualified
    FROM   INFORMATION_SCHEMA.TABLES
    WHERE  TABLE_TYPE = 'BASE TABLE'
      AND  TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')

    UNION ALL

    SELECT 'view' AS object_type,
           TABLE_SCHEMA,
           TABLE_NAME,
           LOWER(TABLE_SCHEMA) + '.' + LOWER(TABLE_NAME)
    FROM   INFORMATION_SCHEMA.VIEWS
    WHERE  TABLE_SCHEMA NOT IN ('sys', 'INFORMATION_SCHEMA')
)
SELECT TOP (50)
       e.schema_name + '.' + e.entity_name AS object_name,
       e.object_type,
       COUNT(DISTINCT c.request_id)        AS usage_count
FROM   entities AS e
JOIN   cmds     AS c
       -- Match only qualified references bounded by a non-identifier char,
       -- so 'sales.orders' matches but 'mysales.orders_old' does not.
       ON c.cmd LIKE '%[^a-z0-9_]' + e.qualified + '[^a-z0-9_]%'
GROUP BY e.schema_name, e.entity_name, e.object_type
ORDER BY usage_count DESC
OPTION (LABEL = 'sma:top_consumed_objects');
