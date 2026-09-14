# Programs — Fusion5 on NetSuite (F5NETSUITE)

The semantic model written by hand for this project. Each directory is a program (`contract.json` + `program.mjs`),
defined into the project graph with `./define programs/<name>` or `graph/cli.ts define`.

## Concepts — they read NetSuite and hold no business rule

| Concept | Grain | Reads |
|---|---|---|
| exchange rates | currency pair, as at a day | `currencyrate`: transaction currency × rate = base currency; daily |
| projects | project, as recorded now | `job`, `jobtype`, `currency` |
| people | employee, as recorded now | `employee`, subsidiary currency |
| budget | budget line × accounting period | `budgetsmachine`, `budgets`, `account`, `accountingperiod` |
| working days | work calendar × day worked | `workcalendar` weekday flags less `workcalendarholiday` |
| allocations | allocation × day the person works | `resourceallocation` spread over the person's own calendar |
| time entries | timesheet line | `timebill`, with its actual time-based `charge` summed per line |

## What the data showed (September 2026)

- **Base Budget** in the 4 Month Summary is budget category 5 (Local $ currency), accounts 5005 Consulting, 5102
  PartnerPlus CST PrePaid Hours and 5010 Consulting – Intercompany, for the subsidiary, by accounting period. It
  reproduces the report exactly: Jul 7,546,044 · Aug 8,023,123 · Sep 10,207,680 · Oct 8,130,662 (AU).
- **Projected revenue** in that report is a 14 July 2026 snapshot of allocations. Allocations have changed since
  (soft converted to hard, past allocations trimmed), so live data cannot reproduce its figures; the rules can be
  checked, not the snapshot.
- **The charge rate of actual time** is on the `charge` NetSuite raised for the line (`charge.timerecord` →
  `timebill.id`, `rate`, `amount`), not on `timebill.rate`, which is empty on nearly every line. A few lines carry two
  charges.
- **PartnerPlus rates** are on `customrecord_f5_pp_hourallocation` (`custrecord_prepaid_pp_rate`, overrun rate, start
  and end dates) under `customrecord_f5_ppagreement`, which names the project.
- **Prepaid milestone** (`job.custentity_f5_prepaid_milestone_project`) is F on every in-progress project. Project types
  include Milestone Fixed Price (14), Milestone T&E (20), Prepayment (11), Prepaid PartnerPlus (12) and PartnerPlus (3,
  22, 23, 25). The prepaid milestone forecasting rate has not been found.
- **Senior Supplier** is `job.custentity_f5_prj_senior_supplier`.
- **Go-live date** in the PMO report matches neither `calculatedenddate` nor `custentity_f5_project_end_date`; not yet
  found.
- **Leave** is `customrecord_f5_leave_request` (for exempt hours).
- The datasource manager returns at most 5,000 rows a query (and says so in `notes`); `allocations` pages by id to read them all.
