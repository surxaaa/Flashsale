#!/usr/bin/env bash
# usage: ./scripts/reset.sh [seconds until the sale opens, default 0]
set -e
START_IN=${1:-0}
STARTS_AT=$(( ($(date +%s) + START_IN) * 1000 ))
docker compose exec -T postgres psql -U flash -d flash -c "TRUNCATE orders; UPDATE inventory SET stock = 500 WHERE product_id = 1;"
docker compose exec -T redis redis-cli FLUSHALL
docker compose exec -T redis redis-cli SET sale:stock 500
docker compose exec -T redis redis-cli SET sale:startsAt $STARTS_AT
docker compose exec -T redis redis-cli SET sale:open 1
docker compose exec -T rabbitmq rabbitmqctl purge_queue orders || true
echo "reset done: stock=500, sale opens in ${START_IN}s"
