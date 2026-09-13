// A STOCK: true at an instant. Employment as at a date is hire date to release date. The active flag cannot be
// used — it says who is employed today, not who was employed then.
export default (ctx) =>
  ctx.from('F5NETSUITE', 'employee e')
    .join('LEFT JOIN department d ON d.id = e.department')
    .join('LEFT JOIN subsidiary s ON s.id = e.subsidiary')
    // Not every employee record is a person: system accounts and placeholders have no first name.
    .where('e.firstname IS NOT NULL')
    .dimension('employee',   { key: 'e.id', label: 'e.entityid', history: 'stable' })
    .dimension('pillar',     { key: 'd.id', label: 'd.name',     history: 'current' })
    .dimension('subsidiary', { key: 's.id', label: 's.name',     history: 'current' })
    .measure('headcount', { sql: 'COUNT(*)', unit: 'people', kind: 'stock' })
    .measure('fte', { sql: "SUM(TO_NUMBER(NVL(e.custentity_f5_emp_working_hrs, '0'))) / 40", unit: 'FTE', kind: 'stock' })
    .stockAt("NVL(e.hiredate, e.datecreated) <= TO_DATE(@asAt, 'YYYY-MM-DD') " +
             "AND (e.releasedate IS NULL OR e.releasedate > TO_DATE(@asAt, 'YYYY-MM-DD'))")
    .caveat('people marked inactive with no release date still count as employed')
    .caveat('working hours are as recorded today, over a 40-hour week')
