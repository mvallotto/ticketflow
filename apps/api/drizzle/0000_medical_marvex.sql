CREATE TYPE "public"."order_status" AS ENUM('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED');
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"location" varchar(255) NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0),
	CONSTRAINT "order_items_price_nonnegative" CHECK ("order_items"."unit_price_cents" >= 0)
);

CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'PENDING' NOT NULL,
	"total_cents" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "orders_total_nonnegative" CHECK ("orders"."total_cents" >= 0)
);

CREATE TABLE "ticket_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"price_cents" integer NOT NULL,
	"capacity" integer NOT NULL,
	"reserved_quantity" integer DEFAULT 0 NOT NULL,
	"sold_quantity" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ticket_types_price_nonnegative" CHECK ("ticket_types"."price_cents" >= 0),
	CONSTRAINT "ticket_types_inventory_valid" CHECK ("ticket_types"."capacity" >= 0
            AND "ticket_types"."reserved_quantity" >= 0
            AND "ticket_types"."sold_quantity" >= 0
            AND "ticket_types"."reserved_quantity" + "ticket_types"."sold_quantity" <= "ticket_types"."capacity")
);

CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"purchase_price_cents" integer NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_purchase_price_nonnegative" CHECK ("tickets"."purchase_price_cents" >= 0)
);

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "order_items_order_ticket_type_unique" ON "order_items" USING btree ("order_id","ticket_type_id");
CREATE INDEX "orders_event_id_idx" ON "orders" USING btree ("event_id");
CREATE INDEX "orders_status_expires_at_idx" ON "orders" USING btree ("status","expires_at");
CREATE INDEX "ticket_types_event_id_idx" ON "ticket_types" USING btree ("event_id");
CREATE INDEX "tickets_order_id_idx" ON "tickets" USING btree ("order_id");