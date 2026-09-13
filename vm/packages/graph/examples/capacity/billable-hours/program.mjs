// A relation built on a relation: utilised hours, narrowed to what can be billed. No table is named here —
// what counts as a utilised hour stays defined in one place.
export default () => ({
  sql: `SELECT h.* FROM {{utilised hours}} h WHERE h.billable = 'T'`,
})
