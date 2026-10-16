import { unsettledSql } from './sql.js';
export async function run(state, ctx) {
    const { sql, params } = unsettledSql(state.trips.branch);
    const rows = await ctx.services.query('TRIPS', sql, params);
    ctx.set({ count: rows.length });
    const total = rows.reduce((a, r) => a + Number(r.balance), 0);
    const table = { title: 'Unsettled trips', columns: [{ key: 'trip_no', label: 'Trip' }, { key: 'balance', label: 'Balance' }], rows };
    return { answer: { markdown: `${rows.length} trips${state.trips.branch ? ` at ${state.trips.branch}` : ''} are completed but not settled; ${total} to settle.\n:::table unsettled.json`, blocks: { 'unsettled.json': table } } };
}
export function nextPage(state, ctx) {
    ctx.set({ page: state.trips.page + 1 });
}
