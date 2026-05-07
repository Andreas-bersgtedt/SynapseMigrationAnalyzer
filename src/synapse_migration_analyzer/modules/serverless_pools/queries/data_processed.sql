-- Aggregate data processed by serverless SQL (last 30 days), per UTC day.
-- Used to estimate cost: serverless is billed per TB of data processed.
-- Source: sys.dm_exec_requests_history.
SELECT
    CAST(start_time AS DATE)      AS day,
    COUNT(*)                       AS request_count,
    SUM(CAST(data_processed_mb AS BIGINT)) AS data_processed_mb
FROM sys.dm_exec_requests_history
WHERE start_time > DATEADD(DAY, -30, SYSUTCDATETIME())
  AND status = 'Completed'
GROUP BY CAST(start_time AS DATE)
ORDER BY day DESC;
