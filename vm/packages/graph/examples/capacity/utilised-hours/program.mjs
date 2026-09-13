// A FLOW: hours accumulate over a span, and sum across people, pillars and months alike.
export default (ctx) =>
  ctx.from('F5NETSUITE', 'timebill tb')
    .join('JOIN employee e ON e.id = tb.employee')
    .join('LEFT JOIN department d ON d.id = e.department')
    .join('LEFT JOIN subsidiary s ON s.id = e.subsidiary')
    .where("tb.isutilized = 'T'")
    // The same population as fte, so the two can later be compared: people, not system accounts.
    .where('e.firstname IS NOT NULL')
    .dimension('employee',   { key: 'e.id', label: 'e.entityid', history: 'stable' })
    .dimension('pillar',     { key: 'd.id', label: 'd.name',     history: 'current' })
    .dimension('subsidiary', { key: 's.id', label: 's.name',     history: 'current' })
    .measure('hours', { sql: 'SUM(TO_NUMBER(tb.hours))', unit: 'h', kind: 'flow' })
    .time('tb.trandate')
