-- Total storage occupied by all user tables in the dedicated SQL pool.
-- Output is a single row with the aggregated MB values; the analyzer converts to GB.
SELECT
    COUNT(DISTINCT t.object_id)                                                AS table_count,
    ISNULL(SUM(ps.row_count), 0)                                                AS row_count,
    CAST(ISNULL(SUM(ps.reserved_page_count), 0) * 8.0 / 1024.0 AS DECIMAL(20,2)) AS reserved_space_mb,
    CAST(ISNULL(SUM(ps.used_page_count),     0) * 8.0 / 1024.0 AS DECIMAL(20,2)) AS data_space_mb,
    CAST(ISNULL(SUM(ps.reserved_page_count - ps.used_page_count), 0)
              * 8.0 / 1024.0 AS DECIMAL(20,2))                                  AS index_or_unused_mb
FROM sys.dm_pdw_nodes_db_partition_stats ps
JOIN sys.tables t ON t.object_id = ps.object_id;
