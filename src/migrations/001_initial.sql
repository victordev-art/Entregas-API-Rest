CREATE TABLE quotes (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE couriers (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('disponivel', 'em_entrega')),
  vehicle text NOT NULL CHECK (vehicle IN ('moto', 'carro', 'van')),
  position jsonb,
  payload jsonb NOT NULL
);

CREATE TABLE deliveries (
  id text PRIMARY KEY,
  client_name text NOT NULL,
  external_order_id text NOT NULL,
  quote_id text NOT NULL REFERENCES quotes(id),
  status text NOT NULL,
  courier_id text,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE delivery_events (
  sequence bigserial NOT NULL UNIQUE,
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE idempotency_records (
  id text PRIMARY KEY,
  body_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX deliveries_client_created_idx ON deliveries (client_name, created_at DESC);
CREATE INDEX deliveries_status_created_idx ON deliveries (status, created_at DESC);
CREATE INDEX couriers_available_idx ON couriers (status, vehicle);
CREATE INDEX delivery_events_delivery_sequence_idx ON delivery_events (delivery_id, sequence);