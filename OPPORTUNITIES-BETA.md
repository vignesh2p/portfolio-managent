# Opportunities Beta: ATH investment cycles

Rebalance replacement opportunities use this same Beta calculation, including
stock budgets, alias-matched trades, carry-forward and persisted ATH cycles.
Only active suggestions for at least one share are shown, subject to the existing
under-100-day ATH filter and source-stock exclusion. The table shows Beta suggested
investment; quantities are capped by both this amount and sale proceeds.
Combinations split proceeds in proportion to Beta suggestions, cap each stock at
its suggestion, and leave unused proceeds as cash. The portfolio/new-stock tabs
and viewing-only estimates remain available.

Beta uses `mode=beta` on the authenticated opportunities API. Ordinary
Opportunities calculations and portfolio transactions are unchanged.

## Starting and resetting cycles

Opening Beta uses the ATH trading date already verified by the Yahoo monthly/daily
history lookup. With complete dated transactions, the base investment is rebuilt
from trades before that Indian trading date. Trades on the ATH date belong to the
new cycle because daily candles do not establish their ordering against the
intraday high. Current allocation settings apply to this reconstructed cycle.
If the date or transaction history is incomplete, observed-date tracking remains
and the UI explains the fallback. Existing observation-date cycles are archived
and replaced once with a reconstructed record when enough information is available.
No transactions or prior recommendation snapshots are overwritten.
A strictly higher verified ATH closes the current cycle and creates a new one:

- Base investment = remaining purchase cost before the Yahoo ATH trading date (or at detection when historical reconstruction is unavailable).
- Cycle cap = max(0, effective maximum allocation - base investment).
- Current cycle investment = actual remaining purchase cost now - saved base.
- Cumulative cycle target = cycle cap × cumulative allocation percentages.
- Carry-forward = max(0, previous cycle target - current cycle investment).
- Suggested investment = max(0, cumulative cycle target - current cycle investment),
  capped by the remaining effective maximum allocation.
- Whole-share quantity = floor(suggested investment / latest available CMP).

The effective maximum includes stock-specific overrides. Budget changes recalculate
current capacity against the fixed base; original budget/cap at reset stay stored.
Sales release average purchase cost, so current-cycle net investment may be negative
when old holdings are sold. The overall maximum still caps every suggestion.
Bonus shares add no purchase cost. Unknown investments or quotes suppress unsafe
recommendations. Current-cycle arithmetic and currency outputs are rounded to paise.

## Persistence and automatic updates

`opportunity_beta_cycles` stores user/stock identity, ATH and ATH date, reset detection
time, base investment, original budget/cap, close time, and the last recommendation
snapshot. A unique partial index permits only one open cycle per user/stock.
Creation/closure runs in a database transaction. Equal or lower ATHs do not reset
an already reconstructed cycle. Higher-ATH detection runs in shared scheduled
price refreshes, with Beta requests also checking the saved quote. Verified
historical ATH dates can be reused when the CMP cache is older; no provider call
is added to ordinary Beta page loads. The snapshot records when reconstruction
was performed separately from the effective cycle start date. Transactions and
previous cycle snapshots are preserved.

Closed cycles retain their last recorded prices, configuration, targets, suggestions
and timestamp. They are not recomputed using a later ATH, budget, or trade history.
Beta displays them in expandable ATH cycle history and labels earlier observed-date
tracking records separately. The current cycle start is reconstructed from Yahoo
and trades; past recommendations are not invented for periods before tracking.

Every Beta API request recalculates the open cycle against current transactions and
configuration. Opening or refreshing Beta and background price refreshes reload the
screen. Only the current price zone is actionable; other levels are previews.
