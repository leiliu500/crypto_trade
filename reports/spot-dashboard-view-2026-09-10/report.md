The previous dashboard update added the new BTC spot strategy above the existing BTC/ETH futures dashboard. That left the executable return distribution panels visible even though those predictions do not drive the separate spot strategy.

The dashboard now defaults to the BTC spot view. The existing futures model, account, orders, and operational events are available through an explicit **Futures monitoring** navigation link. Each view starts only its own data connection, and the spot header reports the spot service's status. Ordinary URL navigation supports refresh, bookmarks, and browser back.

This is a dashboard correction. It does not change either strategy, submit an order, reset an account, or establish profitability. ETH belongs to the existing futures strategy; the new spot strategy trades BTC only.

The deployed dashboard image is `sha256:8f70e03fc0bd16222b2ab993fbcb49f335e8c0d103acb436ff824b8e9697216f`. Its first 16 image layers and container configuration exactly match the previous dashboard image; only the final static-asset layer changed. The live server serves all four assets byte-for-byte from the reviewed source. The TypeScript check and 41 dashboard tests passed.

All 14 postdeployment continuity checks passed. Spot retained its original image and container start time. Futures cash remained $99,998.28269740003 with all 382 orders and 382 activities preserved; spot retained $100,000 cash and zero BTC, orders, or fills. Account volumes, funding history, and networks remained unchanged.

Evidence: [image-layer verification](image-verification.json), [served assets](served-assets.json), [existing dashboard tests](dashboard-tests.tap), [spot UI tests](spot-ui-tests.tap), [account baseline](before.json), and [continuity comparison](after.json).

Deployed desktop/mobile browser checks passed. The default view contains only spot content and requests only the spot API. The futures link shows its own panels and uses the futures API/WebSocket without spot polling. Browser back restores the spot view, and an unknown view defaults to spot. No JavaScript errors or horizontal overflow were observed. See the [browser report](browser-deployed/browser-report.json), [desktop spot screenshot](browser-deployed/desktop-spot.png), and [mobile spot screenshot](browser-deployed/mobile-spot.png).
