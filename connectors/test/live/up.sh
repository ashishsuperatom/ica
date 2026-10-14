#!/usr/bin/env bash
# The databases the connectors' live tests read (connectors.live.test.mts), each in Docker on this machine with the same
# seeded sales dataset (seed.mjs). Containers named sa-live-*, ports 55xxx; run again: kept if running, made if not.
#   connectors/test/live/up.sh        start and seed      connectors/test/live/up.sh down   remove them all
set -euo pipefail
cd "$(dirname "$0")"
PW='Sa-live-2026!'
if [ "${1:-}" = down ]; then docker rm -f sa-live-postgres sa-live-mysql sa-live-mssql sa-live-oracle sa-live-clickhouse sa-live-mongo >/dev/null 2>&1 || true; echo removed; exit 0; fi
run() { local name=$1; shift; docker inspect "$name" >/dev/null 2>&1 && { docker start "$name" >/dev/null; return 1; }; docker run -d --name "$name" "$@" >/dev/null; return 0; }
wait_for() { local what=$1; shift; for i in $(seq 1 120); do "$@" >/dev/null 2>&1 && { echo "✓ $what"; return 0; }; sleep 3; done; echo "✗ $what did not come up"; return 1; }

new_pg=0; run sa-live-postgres -p 55432:5432 -e POSTGRES_USER=sa -e POSTGRES_PASSWORD="$PW" -e POSTGRES_DB=sales postgres:16-alpine && new_pg=1
new_my=0; run sa-live-mysql -p 53306:3306 -e MYSQL_ROOT_PASSWORD="$PW" -e MYSQL_DATABASE=sales -e MYSQL_USER=sa -e MYSQL_PASSWORD="$PW" mysql:8.4 && new_my=1
new_ms=0; run sa-live-mssql -p 51433:1433 -e ACCEPT_EULA=1 -e MSSQL_SA_PASSWORD="$PW" mcr.microsoft.com/azure-sql-edge:latest && new_ms=1
new_or=0; run sa-live-oracle -p 51521:1521 -e ORACLE_PASSWORD="$PW" -e APP_USER=sales -e APP_USER_PASSWORD="$PW" gvenzl/oracle-free:23-slim-faststart && new_or=1
new_ch=0; run sa-live-clickhouse -p 58123:8123 -e CLICKHOUSE_DB=sales -e CLICKHOUSE_USER=sa -e CLICKHOUSE_PASSWORD="$PW" -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 --ulimit nofile=262144:262144 clickhouse/clickhouse-server:24.8 && new_ch=1
new_mg=0; run sa-live-mongo -p 57017:27017 -e MONGO_INITDB_ROOT_USERNAME=sa -e MONGO_INITDB_ROOT_PASSWORD="$PW" mongo:7 && new_mg=1

wait_for postgres docker exec sa-live-postgres pg_isready -U sa -d sales
wait_for mysql docker exec sa-live-mysql mysql -usa -p"$PW" -e 'SELECT 1' sales
wait_for mssql bash -c "docker logs sa-live-mssql 2>&1 | grep -q 'Recovery is complete'"
wait_for oracle bash -c "docker logs sa-live-oracle 2>&1 | grep -q 'DATABASE IS READY TO USE'"
wait_for clickhouse docker exec sa-live-clickhouse clickhouse-client --user sa --password "$PW" -q 'SELECT 1'
wait_for mongo docker exec sa-live-mongo mongosh -u sa -p "$PW" --quiet --eval 'db.runCommand({ping:1})'

# Seeded once, when made (the dataset is the same every time).
[ $new_pg = 1 ] && node seed.mjs postgres | docker exec -i sa-live-postgres psql -q -U sa -d sales -v ON_ERROR_STOP=1 >/dev/null && echo "  seeded postgres"
[ $new_my = 1 ] && node seed.mjs mysql | docker exec -i sa-live-mysql mysql -usa -p"$PW" sales 2>/dev/null && echo "  seeded mysql"
[ $new_ch = 1 ] && node seed.mjs clickhouse | docker exec -i sa-live-clickhouse clickhouse-client --user sa --password "$PW" -d sales --multiquery && echo "  seeded clickhouse"
[ $new_mg = 1 ] && node seed.mjs mongo | docker exec -i sa-live-mongo mongosh -u sa -p "$PW" --quiet >/dev/null && echo "  seeded mongo"
# SQL Server and Oracle are seeded through the connectors' own drivers (seed-tds.mjs), their images having no client to pipe to.
[ $new_ms = 1 ] && node seed-drivers.mjs mssql && echo "  seeded mssql"
[ $new_or = 1 ] && node seed-drivers.mjs oracle && echo "  seeded oracle"
echo "ready: postgres :55432 · mysql :53306 · mssql :51433 · oracle :51521 (FREEPDB1) · clickhouse :58123 · mongo :57017 — user sa (oracle: sales), password $PW"
