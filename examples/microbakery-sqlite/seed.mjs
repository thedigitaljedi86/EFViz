// Builds a small "Mikrobageri" SQLite database to demo EFViz's SQLite mode —
// the kind of schema a Next.js app would talk to via better-sqlite3 (raw SQL,
// no ORM). Run it, then point EFViz at the file:
//
//   node examples/microbakery-sqlite/seed.mjs
//   npx efviz microbakery.sqlite -o microbakery.html --open
//
// Needs Node >= 22.5 (for the built-in node:sqlite module).
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';

const path = process.argv[2] ?? 'microbakery.sqlite';
if (existsSync(path)) rmSync(path);

const db = new DatabaseSync(path);
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    parent_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    price_dkk   REAL NOT NULL,
    description TEXT,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_products_category ON products(category_id);

  CREATE TABLE ingredients (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    unit      TEXT NOT NULL,
    stock_qty REAL NOT NULL DEFAULT 0,
    allergen  TEXT
  );

  -- recipe line: products <-> ingredients, with a quantity payload
  CREATE TABLE product_ingredients (
    product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE RESTRICT,
    quantity      REAL NOT NULL,
    PRIMARY KEY (product_id, ingredient_id)
  );

  CREATE TABLE customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL UNIQUE,
    full_name  TEXT,
    phone      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE orders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number TEXT NOT NULL UNIQUE,
    customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    status       TEXT NOT NULL DEFAULT 'pending',
    total_dkk    REAL NOT NULL DEFAULT 0,
    pickup_at    TEXT,
    placed_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_orders_customer ON orders(customer_id);

  CREATE TABLE order_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity       INTEGER NOT NULL,
    unit_price_dkk REAL NOT NULL
  );
  CREATE INDEX idx_order_items_order ON order_items(order_id);

  CREATE TABLE subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    plan        TEXT NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    started_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE VIEW v_daily_sales AS
    SELECT date(placed_at) AS day, COUNT(*) AS orders, SUM(total_dkk) AS revenue
    FROM orders GROUP BY date(placed_at);

  INSERT INTO categories (name, slug) VALUES ('Brød','broed'), ('Kager','kager');
  INSERT INTO ingredients (name, unit, allergen) VALUES ('Hvedemel','kg','gluten'), ('Smør','kg','mælk');
`);
db.close();
console.log(`wrote ${path} — now run:  npx efviz ${path} -o microbakery.html --open`);
