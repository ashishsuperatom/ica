// One row per person employed as at @asAt — the same people as fte — with the attributes a question may reach
// through an employee: `employee.manager`, `employee.location`, `employee.title`. Manager, location and title are
// as recorded today; NetSuite keeps no history of them here.
export default (ctx, { asAt }) => ({
  source: 'F5NETSUITE',
  sql: `
    SELECT e.id                          AS employee_id,
           e.entityid                    AS employee_name,
           e.supervisor                  AS manager_id,
           BUILTIN.DF(e.supervisor)      AS manager_name,
           e.location                    AS location_id,
           BUILTIN.DF(e.location)        AS location_name,
           e.title                       AS title
      FROM employee e
     WHERE e.firstname IS NOT NULL
       AND NVL(e.hiredate, e.datecreated) <= TO_DATE(@asAt, 'YYYY-MM-DD')
       AND (e.releasedate IS NULL OR e.releasedate > TO_DATE(@asAt, 'YYYY-MM-DD'))`,
  params: { asAt },
})
