// The Fusion5 revenue rule for allocation: hours × charge-out rate, per allocated day.
export default () => ({
  sql: `SELECT a.*,
               a.hours * COALESCE(a.rate, 0) AS revenue,
               CASE WHEN a.rate IS NULL OR a.rate = 0 THEN a.hours ELSE 0 END AS unpriced_hours
          FROM {{allocations}} a`,
})
