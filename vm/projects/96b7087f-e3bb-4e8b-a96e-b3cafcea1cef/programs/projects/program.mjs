// Every project, whatever its status: filter on status to see the live ones. @asAt is when the question reads them;
// the fields are as recorded today, so a project counts once it was created on or before that day.
export default (ctx, { asAt }) => ({
  source: 'F5NETSUITE',
  sql: `
    SELECT j.id                                           AS project_id,
           j.entityid || ' ' || j.companyname             AS project_name,
           j.customer                                     AS customer_id,
           BUILTIN.DF(j.customer)                         AS customer_name,
           j.subsidiary                                   AS subsidiary_id,
           BUILTIN.DF(j.subsidiary)                       AS subsidiary_name,
           j.custentity_f5_prj_pillar                     AS pillar_id,
           BUILTIN.DF(j.custentity_f5_prj_pillar)         AS pillar_name,
           j.entitystatus                                 AS status_id,
           BUILTIN.DF(j.entitystatus)                     AS status_name,
           j.jobtype                                      AS type_id,
           t.name                                         AS type_name,
           j.custentity_f5_project_rag                    AS rag_id,
           BUILTIN.DF(j.custentity_f5_project_rag)        AS rag_name,
           j.custentity_f5_prj_manager                    AS manager_id,
           BUILTIN.DF(j.custentity_f5_prj_manager)        AS manager_name,
           j.custentity_f5_prj_senior_supplier            AS senior_supplier_id,
           BUILTIN.DF(j.custentity_f5_prj_senior_supplier) AS senior_supplier_name,
           c.symbol                                       AS currency_code,
           j.custentity_f5_prepaid_milestone_project      AS prepaid_milestone,
           TO_NUMBER(j.custentity_f5_total_project_budget) AS total_budget
      FROM job j
      LEFT JOIN jobtype t ON t.id = j.jobtype
      LEFT JOIN currency c ON c.id = j.currency
     WHERE j.datecreated < TO_DATE(@asAt, 'YYYY-MM-DD') + 1`,
  params: { asAt },
})
