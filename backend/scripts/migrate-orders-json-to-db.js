// One-time migration: imports any orders still sitting in the old data/orders.json
// file (from before order storage moved to Postgres) into the orders table.
// Safe to run more than once — existing order_ids are skipped, not duplicated.
// Usage (from backend/): node scripts/migrate-orders-json-to-db.js

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { neon } = require('@neondatabase/serverless');

const ORDERS_JSON_PATH = path.resolve(__dirname, '..', '..', 'data', 'orders.json');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — add it to .env first.');
    process.exit(1);
  }

  if (!fs.existsSync(ORDERS_JSON_PATH)) {
    console.log('No data/orders.json file found — nothing to migrate.');
    return;
  }

  const orders = JSON.parse(fs.readFileSync(ORDERS_JSON_PATH, 'utf8'));
  if (!Array.isArray(orders) || orders.length === 0) {
    console.log('data/orders.json is empty — nothing to migrate.');
    return;
  }

  const sql = neon(process.env.DATABASE_URL);

  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      order_id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL,
      order_type TEXT,
      customer_name TEXT,
      phone TEXT,
      currency TEXT,
      total NUMERIC,
      items JSONB NOT NULL,
      fulfillment JSONB NOT NULL,
      pricing JSONB NOT NULL
    )
  `;

  let migrated = 0;
  let skipped = 0;

  for (const order of orders) {
    const result = await sql`
      INSERT INTO orders (order_id, created_at, status, order_type, customer_name, phone, currency, total, items, fulfillment, pricing)
      VALUES (
        ${order.orderId}, ${order.timestamp}, ${order.status || 'NEW'}, ${order.fulfillment.orderType || null},
        ${order.fulfillment.customerName || null}, ${order.fulfillment.phone || null},
        ${order.pricing.currency || null}, ${order.pricing.total},
        ${JSON.stringify(order.items)}, ${JSON.stringify(order.fulfillment)}, ${JSON.stringify(order.pricing)}
      )
      ON CONFLICT (order_id) DO NOTHING
      RETURNING order_id
    `;
    if (result.length > 0) migrated += 1;
    else skipped += 1;
  }

  console.log(`Migrated ${migrated} order(s), skipped ${skipped} already-present order(s).`);
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
