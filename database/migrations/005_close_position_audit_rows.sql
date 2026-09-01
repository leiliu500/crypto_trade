WITH latest_closed AS (
  SELECT DISTINCT ON (run_id,symbol)
    run_id,
    symbol,
    to_timestamp((plan#>>'{livePosition,openedMs}')::double precision / 1000) AS opened_at,
    to_timestamp((plan#>>'{livePosition,closedAtMs}')::double precision / 1000) AS closed_at,
    NULLIF(plan#>>'{livePosition,closePx}','')::numeric AS close_px,
    plan#>>'{livePosition,latestReason}' AS close_reason
  FROM orders
  WHERE run_id IS NOT NULL
    AND reduce_only_intent
    AND status = 'FILLED'
    AND plan#>>'{livePosition,openedMs}' IS NOT NULL
    AND plan#>>'{livePosition,closedAtMs}' IS NOT NULL
    AND plan#>>'{livePosition,active}' = 'false'
  ORDER BY run_id,symbol,(plan#>>'{livePosition,closedAtMs}')::bigint DESC,updated_at DESC
)
UPDATE positions AS position
SET qty = 0,
    current_price = COALESCE(closed.close_px,position.current_price),
    unrealized_pnl = 0,
    phase = 'CLOSED',
    updated_at = GREATEST(position.updated_at,closed.closed_at),
    closed_at = closed.closed_at,
    payload = position.payload || jsonb_build_object(
      'active',false,
      'closedAtMs',floor(extract(epoch FROM closed.closed_at) * 1000),
      'qty',0,
      'currentPx',COALESCE(closed.close_px,position.current_price),
      'marketValue',0,
      'unrealizedPnl',0,
      'unrealizedPnlBps',0,
      'phase','CLOSED',
      'latestAction','EXIT',
      'latestReason',COALESCE(closed.close_reason,'POSITION_CLOSED')
    )
FROM latest_closed AS closed
WHERE position.run_id = closed.run_id
  AND position.symbol = closed.symbol
  AND abs(extract(epoch FROM (position.opened_at - closed.opened_at))) < 0.001
  AND closed.closed_at >= position.updated_at;
