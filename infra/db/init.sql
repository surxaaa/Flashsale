CREATE TABLE inventory (
  product_id INT PRIMARY KEY,
  stock INT NOT NULL CHECK (stock >= 0)
);

CREATE TABLE orders (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  product_id INT NOT NULL REFERENCES inventory(product_id),
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- one active order per user per product; expired ones don't block a retry
CREATE UNIQUE INDEX one_active_order
  ON orders (user_id, product_id) WHERE status <> 'EXPIRED';

CREATE INDEX orders_pending_idx ON orders (created_at) WHERE status = 'PENDING_PAYMENT';

INSERT INTO inventory (product_id, stock) VALUES (1, 500);
