-- Stored procedures, views, and user-defined functions in the dedicated pool.
-- Used by the fabric_mapping module to detect T-SQL surface gaps (MERGE, CURSOR, etc.).
SELECT
    s.name                AS schema_name,
    o.name                AS object_name,
    o.type_desc           AS object_type,
    sm.definition         AS definition
FROM sys.sql_modules sm
JOIN sys.objects o ON o.object_id = sm.object_id
JOIN sys.schemas s ON s.schema_id = o.schema_id
WHERE o.type IN ('P', 'V', 'FN', 'IF', 'TF')
  AND o.is_ms_shipped = 0
ORDER BY s.name, o.name;
