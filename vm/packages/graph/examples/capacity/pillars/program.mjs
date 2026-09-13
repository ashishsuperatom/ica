export default async function (ctx) {
  return ctx.query('F5NETSUITE', `SELECT id, name, parent FROM department ORDER BY name`)
}
