#!/usr/bin/env bash
echo "--- Postgres ---"
docker compose exec -T postgres psql -U flash -d flash -c \
 "SELECT count(*) FILTER (WHERE status IN ('PENDING_PAYMENT','CONFIRMED')) AS active_orders,
         count(*) FILTER (WHERE status='EXPIRED') AS expired,
         (SELECT stock FROM inventory WHERE product_id=1) AS db_stock FROM orders;"
echo "--- Duplicate active users (expect 0 rows) ---"
docker compose exec -T postgres psql -U flash -d flash -c \
 "SELECT user_id, count(*) FROM orders WHERE status <> 'EXPIRED' GROUP BY user_id HAVING count(*) > 1;"
echo "--- Redis ---"
echo -n "redis stock: "; docker compose exec -T redis redis-cli GET sale:stock
echo -n "redis buyers: "; docker compose exec -T redis redis-cli SCARD sale:buyers
echo -n "queue depth: "; docker compose exec -T rabbitmq rabbitmqctl list_queues name messages | grep orders
