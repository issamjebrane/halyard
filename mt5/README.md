# Halyard MT5 executor

Copies Gold VIP signals (already parsed into Supabase by the Telegram ingester)
onto a MetaTrader 5 account. Runs on a **Windows VPS** next to the MT5 terminal.

```
Telegram ──► ingester (Node) ──► Supabase `signals` ──► executor.py ──► MT5 account
                                         └──► Halyard verifier (paper, for trust stats)
```

Per signal it: sizes the position by **risk %** (not fixed lots), places up to 3
market orders carrying TP1/TP2/TP3 with a shared SL, and moves the remaining SL
to **breakeven once TP1 is hit**. Every signal is recorded in the `executions`
table, so it is never traded twice.

## Safety
- `DRY_RUN=true` (default) places **nothing** — it logs what it would do. Verify
  the sizing + connection first, then set `DRY_RUN=false`.
- **Use a DEMO account** until you've watched it for several days.
- It ignores signals older than `MAX_SIGNAL_AGE_MIN` (won't back-trade history)
  and refuses to trade past `MAX_OPEN_TRADES`, wide spreads, or large slippage.
- Trading is real risk. Decide to copy a channel based on Halyard's *verified*
  stats, not the channel's own "+100 pips" claims.

---

## Setup (Windows VPS)

**English**
1. Install the **MetaTrader 5** terminal and log into your **demo** account.
2. Install Python 3.11+ and the deps:
   ```
   pip install -r requirements.txt
   ```
3. Copy `.env.example` to `.env` and fill it in (`SUPABASE_SERVICE_ROLE_KEY`,
   `MT5_LOGIN/PASSWORD/SERVER`, your broker's gold `SYMBOL`, `RISK_PCT`). Keep
   `DRY_RUN=true` for the first run.
4. Run it:
   ```
   python executor.py
   ```
   Watch the log: it prints the lots it *would* trade. When the sizing looks
   right, set `DRY_RUN=false` to place demo orders.

**Español**
1. Instala la terminal **MetaTrader 5** e inicia sesión en tu cuenta **demo**.
2. Instala Python 3.11+ y las dependencias:
   ```
   pip install -r requirements.txt
   ```
3. Copia `.env.example` a `.env` y complétalo (`SUPABASE_SERVICE_ROLE_KEY`,
   `MT5_LOGIN/PASSWORD/SERVER`, el `SYMBOL` del oro de tu bróker, `RISK_PCT`).
   Deja `DRY_RUN=true` para la primera prueba.
4. Ejecútalo:
   ```
   python executor.py
   ```
   Mira el log: imprime los lotes que *colocaría*. Cuando el tamaño se vea bien,
   pon `DRY_RUN=false` para enviar órdenes en la demo.

## Tip: one VPS for everything
Since you already need a Windows VPS for MT5, you can run the **Telegram
ingester** (`node scripts/telegram-ingest.mjs`) on the same box — then you don't
need Railway/Render at all. Keep both processes running (e.g. via Task Scheduler
or NSSM as Windows services).

## Symbol note
Brokers name gold differently (`XAUUSD`, `GOLD`, `XAUUSD.m`, …). If startup says
"symbol not found", set `SYMBOL` to exactly what your broker's Market Watch shows.
