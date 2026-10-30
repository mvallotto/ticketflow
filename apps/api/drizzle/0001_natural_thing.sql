ALTER TABLE "orders"
ADD COLUMN "visitor_id" uuid;

ALTER TABLE "orders"
ADD COLUMN "idempotency_key" uuid;

-- Backfill existing demo orders.
UPDATE "orders"
SET
  "visitor_id" = gen_random_uuid(),
  "idempotency_key" = gen_random_uuid();

ALTER TABLE "orders"
ALTER COLUMN "visitor_id" SET NOT NULL;

ALTER TABLE "orders"
ALTER COLUMN "idempotency_key" SET NOT NULL;
CREATE INDEX "orders_visitor_id_idx" ON "orders" USING btree ("visitor_id");
CREATE UNIQUE INDEX "orders_visitor_idempotency_unique" ON "orders" USING btree ("visitor_id","idempotency_key");