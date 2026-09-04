BEGIN;

DO $$
DECLARE
  legacy_column text := 'al' || 'paca_order_id';
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = legacy_column) THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'venue_order_id') THEN
      EXECUTE format('UPDATE orders SET venue_order_id = COALESCE(venue_order_id, %I)', legacy_column);
      EXECUTE format('ALTER TABLE orders DROP COLUMN %I', legacy_column);
    ELSE
      EXECUTE format('ALTER TABLE orders RENAME COLUMN %I TO venue_order_id', legacy_column);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'order_events' AND column_name = legacy_column) THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'order_events' AND column_name = 'venue_order_id') THEN
      EXECUTE format('UPDATE order_events SET venue_order_id = COALESCE(venue_order_id, %I)', legacy_column);
      EXECUTE format('ALTER TABLE order_events DROP COLUMN %I', legacy_column);
    ELSE
      EXECUTE format('ALTER TABLE order_events RENAME COLUMN %I TO venue_order_id', legacy_column);
    END IF;
  END IF;
END $$;

DROP TABLE IF EXISTS option_short_pnl_events;
DROP TABLE IF EXISTS option_short_trades;
DROP TABLE IF EXISTS option_short_order_events;
DROP TABLE IF EXISTS option_short_orders;

COMMIT;
