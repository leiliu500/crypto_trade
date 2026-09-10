The spot dashboard now exposes system liveness even when the account, signal, and order ledger remain unchanged. Its dedicated panel separates a responding status service from recorded strategy evaluations, successful market-data cycles, broker order state, and the entry/risk gate.

The display updates ages and the approximate next-evaluation countdown every second. Network polling remains every five seconds. A due countdown waits for a new recorded cycle rather than restarting itself. Recent evaluation observations belong to the current browser session and contain no invented historical cycles.

The dashboard uses existing service telemetry. The account start date is not presented as process uptime, and a recent API response does not by itself prove that evaluations are advancing. Stale, unavailable, and halted conditions remain explicit. The five-minute evaluation countdown is distinct from the strategy's weekly entry window.

This update changes dashboard assets only. It does not alter trading rules, submit orders, or reset either paper account.

The deployed image is `sha256:c9eb00619c56e06b0e68c8e9b11c676c622b88a0dd69089ca459b8d20dca274f`. Its first 16 layers and container configuration exactly match the previous dashboard image; only the final asset layer changed. The TypeScript check and all 48 dashboard tests passed. All 13 deployment checks passed, including source-matching served assets, a healthy spot proxy, and preserved account/order histories. The spot container retained its original image and start time, with its recorded evaluation count advancing from 123 in the predeployment baseline to 124 at verification.

Evidence: [dashboard tests](dashboard-tests.tap), [image verification](image-verification.json), [predeployment baseline](baseline-root.json), and [deployment verification](deployment-verification.json).

The [deployed browser checks](browser-deployed/browser-report.json) passed on desktop and mobile. Each view displayed all six liveness cards, the actual upstream counter of 125 recorded evaluations, and a real observed decision. Ages and the approximate countdown changed between one-second display samples without adding an API request. Five-second polling, spot/futures view isolation, browser navigation, and absence of horizontal overflow or JavaScript errors were verified. [Desktop screenshot](browser-deployed/desktop-spot.png) · [Mobile screenshot](browser-deployed/mobile-spot.png).

An initial browser probe failed a response-age comparison. The probe was corrected to wait for the second completed application response before sampling display-only updates; the rerun passed without an application change. The [initial probe result](browser-initial-sampling-failure.json) is retained separately.
