// The facts the dashboard stands on: each one is a program a domain agent also runs, so a screen and a chat can never
// disagree about what a figure means. read.mjs runs them.

/** Which program gives which rows: its domain (as the composition graph names it), the program's file name, what one
 *  row is, and `args` — what a view asks for as the program's own arguments. A program that answers in totals and pages
 *  (`paged`: sql-rows.mjs or js-rows.mjs) is asked for those, never its every row. A dimension searched in the source
 *  reads the fact named `find` (project.mjs). */
export const FACTS = {
}
