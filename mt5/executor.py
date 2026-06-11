"""
Halyard MT5 executor — copies Gold VIP signals from Supabase onto a MetaTrader 5
account. Runs on a Windows VPS next to the MT5 terminal.

Flow:  Supabase `signals` (written by the Telegram ingester)
         -> size by risk %  -> place market order(s) with SL + TP1/TP2/TP3
         -> move remaining SL to breakeven after TP1  -> record in `executions`

Safety first:
  * DRY_RUN=true (default) places NOTHING — it only logs what it would do.
  * Use a DEMO account until you've watched it behave.
  * It never acts on a signal older than MAX_SIGNAL_AGE_MIN, and the `executions`
    table makes every signal idempotent (never traded twice).

Run:  python executor.py
"""
import os
import sys
import json
import time
from datetime import datetime, timezone, timedelta

import MetaTrader5 as mt5
from supabase import create_client

try:
    from dotenv import load_dotenv

    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:
    pass  # dotenv optional; env may be set by the OS

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
def env(key, default=None):
    v = os.environ.get(key, default)
    return v


SUPABASE_URL = env("SUPABASE_URL")
SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY")
MT5_LOGIN = env("MT5_LOGIN")
MT5_PASSWORD = env("MT5_PASSWORD")
MT5_SERVER = env("MT5_SERVER")
MT5_PATH = env("MT5_TERMINAL_PATH")

SIGNAL_SOURCE = env("SIGNAL_SOURCE", "telegram:gold_vip")
SYMBOL = env("SYMBOL", "XAUUSD")
RISK_PCT = float(env("RISK_PCT", "0.5"))
SPLIT = max(1, min(3, int(env("SPLIT", "3"))))
MAX_OPEN_TRADES = int(env("MAX_OPEN_TRADES", "6"))
MAX_SPREAD_POINTS = float(env("MAX_SPREAD_POINTS", "60"))
MAX_ENTRY_SLIPPAGE = float(env("MAX_ENTRY_SLIPPAGE", "2.0"))
MAX_SIGNAL_AGE_MIN = float(env("MAX_SIGNAL_AGE_MIN", "15"))
DEVIATION = int(env("DEVIATION", "20"))
MAGIC = int(env("MAGIC", "778899"))
DRY_RUN = str(env("DRY_RUN", "true")).lower() in ("1", "true", "yes", "on")
POLL_SECONDS = float(env("POLL_SECONDS", "5"))

if not SUPABASE_URL or not SUPABASE_KEY:
    sys.exit("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see mt5/.env.example)")

sb = create_client(SUPABASE_URL, SUPABASE_KEY)
START_TS = datetime.now(timezone.utc)


def log(*a):
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------- #
# MT5 connection + symbol
# --------------------------------------------------------------------------- #
def mt5_init():
    kwargs = {}
    if MT5_PATH:
        kwargs["path"] = MT5_PATH
    if MT5_LOGIN and MT5_PASSWORD and MT5_SERVER:
        kwargs.update(login=int(MT5_LOGIN), password=MT5_PASSWORD, server=MT5_SERVER)
    if not mt5.initialize(**kwargs):
        sys.exit(f"mt5.initialize failed: {mt5.last_error()}")
    info = mt5.account_info()
    if info is None:
        sys.exit(f"no account info: {mt5.last_error()}")
    if not mt5.symbol_select(SYMBOL, True):
        sys.exit(f"symbol {SYMBOL} not found — set SYMBOL to your broker's gold symbol")
    log(f"connected: login={info.login} server={info.server} "
        f"balance={info.balance} {info.currency} | symbol={SYMBOL} | "
        f"{'DRY_RUN (no orders)' if DRY_RUN else 'LIVE ORDERS'}")
    return info


def pick_filling(sym):
    """Choose an order filling mode the broker/symbol supports."""
    info = mt5.symbol_info(sym)
    allowed = getattr(info, "filling_mode", 0)
    # bit 1 -> FOK allowed, bit 2 -> IOC allowed
    if allowed & 2:
        return mt5.ORDER_FILLING_IOC
    if allowed & 1:
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN


# --------------------------------------------------------------------------- #
# Sizing
# --------------------------------------------------------------------------- #
def round_step(vol, step):
    if step <= 0:
        return round(vol, 2)
    return round(round(vol / step) * step, 8)


def lot_for_risk(sym, entry, sl, balance):
    """Total lots so that hitting SL loses ~RISK_PCT of balance."""
    info = mt5.symbol_info(sym)
    tick_size = info.trade_tick_size or info.point
    tick_value = info.trade_tick_value
    sl_dist = abs(entry - sl)
    if sl_dist <= 0 or tick_size <= 0 or tick_value <= 0:
        return 0.0, info
    loss_per_lot = (sl_dist / tick_size) * tick_value
    if loss_per_lot <= 0:
        return 0.0, info
    risk_money = balance * (RISK_PCT / 100.0)
    lots = risk_money / loss_per_lot
    lots = max(info.volume_min, min(info.volume_max, round_step(lots, info.volume_step)))
    return lots, info


def split_volumes(total, n, info):
    """Split total into n legs, each respecting volume_min/step."""
    n = max(1, n)
    per = round_step(total / n, info.volume_step)
    if per < info.volume_min:
        # not enough volume for n legs -> use as many legs as the min allows
        n = max(1, int(total / info.volume_min))
        per = round_step(total / n, info.volume_step)
        per = max(info.volume_min, per)
    legs = [per] * n
    return legs


# --------------------------------------------------------------------------- #
# Orders
# --------------------------------------------------------------------------- #
def send_market(sym, side, volume, sl, tp, comment):
    tick = mt5.symbol_info_tick(sym)
    price = tick.ask if side == "buy" else tick.bid
    otype = mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL
    base = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": sym,
        "volume": float(volume),
        "type": otype,
        "price": price,
        "sl": float(sl),
        "tp": float(tp) if tp else 0.0,
        "deviation": DEVIATION,
        "magic": MAGIC,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
    }
    # Try filling modes until one is accepted.
    for filling in (pick_filling(sym), mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN):
        req = dict(base, type_filling=filling)
        res = mt5.order_send(req)
        if res is None:
            continue
        if res.retcode == mt5.TRADE_RETCODE_DONE:
            return res
        if res.retcode != mt5.TRADE_RETCODE_INVALID_FILL:
            return res  # a real error, don't retry blindly
    return res


def positions_for(signal_id):
    out = []
    for p in mt5.positions_get(symbol=SYMBOL) or []:
        if p.magic == MAGIC and p.comment == f"sig{signal_id}":
            out.append(p)
    return out


# --------------------------------------------------------------------------- #
# Execute one signal
# --------------------------------------------------------------------------- #
def claim(signal_id, account, status, detail=None, tickets=None, lots=None, fill=None):
    row = {
        "signal_id": signal_id,
        "account": account,
        "status": status,
        "tickets": tickets or [],
        "lots": lots,
        "entry_fill": fill,
        "detail": detail,
    }
    try:
        sb.table("executions").insert(row).execute()
        return True
    except Exception:
        return False  # unique violation -> already claimed by a prior run


def execute_signal(sig, account, balance):
    sid = sig["id"]
    side = sig["direction"]
    entry = float(sig["entry_price"])
    sl = float(sig["stop_loss"])
    tps = [sig.get("tp1"), sig.get("tp2"), sig.get("tp3")]
    tps = [float(t) for t in tps if t is not None][:SPLIT]
    if not tps:
        return

    # Guards ----------------------------------------------------------------
    tick = mt5.symbol_info_tick(SYMBOL)
    info = mt5.symbol_info(SYMBOL)
    cur = tick.ask if side == "buy" else tick.bid
    spread_pts = (tick.ask - tick.bid) / info.point
    open_n = len(mt5.positions_get(symbol=SYMBOL) or [])

    skip = None
    if spread_pts > MAX_SPREAD_POINTS:
        skip = f"spread {spread_pts:.0f}pts > {MAX_SPREAD_POINTS}"
    elif abs(cur - entry) > MAX_ENTRY_SLIPPAGE:
        skip = f"price {cur} too far from entry {entry} (>{MAX_ENTRY_SLIPPAGE})"
    elif open_n >= MAX_OPEN_TRADES:
        skip = f"max open trades {MAX_OPEN_TRADES} reached"

    lots_total, info = lot_for_risk(SYMBOL, entry, sl, balance)
    if lots_total <= 0 and not skip:
        skip = "could not size position (check SL distance / symbol)"

    if skip:
        log(f"#{sid} {side} -> SKIP: {skip}")
        if not DRY_RUN:
            claim(sid, account, "skipped", detail=skip)
        return

    legs = split_volumes(lots_total, len(tps), info)
    log(f"#{sid} {side} {SYMBOL} @~{cur} SL {sl} TPs {tps} | "
        f"risk {RISK_PCT}% -> {lots_total} lots, legs {legs}")

    if DRY_RUN:
        log(f"#{sid} DRY_RUN: would place {len(legs)} order(s); nothing sent.")
        return

    # Claim atomically so a restart never double-trades this signal.
    if not claim(sid, account, "placed", lots=lots_total):
        log(f"#{sid} already claimed — skipping")
        return

    tickets, fills = [], []
    for i, vol in enumerate(legs):
        tp = tps[i] if i < len(tps) else tps[-1]
        res = send_market(SYMBOL, side, vol, sl, tp, f"sig{sid}")
        if res and res.retcode == mt5.TRADE_RETCODE_DONE:
            tickets.append(res.order)
            fills.append(res.price)
            log(f"   leg {i+1}: {vol} lots TP {tp} -> ticket {res.order} @ {res.price}")
        else:
            rc = res.retcode if res else "none"
            log(f"   leg {i+1} FAILED: retcode {rc} {getattr(res,'comment','')}")

    status = "placed" if tickets else "error"
    avg = sum(fills) / len(fills) if fills else None
    sb.table("executions").update(
        {"status": status, "tickets": tickets, "entry_fill": avg,
         "updated_at": datetime.now(timezone.utc).isoformat(),
         "detail": None if tickets else "all legs failed"}
    ).eq("signal_id", sid).execute()


# --------------------------------------------------------------------------- #
# Manage open executions: move remaining SL to breakeven after the first TP.
# --------------------------------------------------------------------------- #
def manage():
    res = sb.table("executions").select("*").eq("status", "placed").execute()
    for ex in res.data or []:
        sid = ex["signal_id"]
        placed = len(ex.get("tickets") or [])
        if placed == 0:
            continue
        pos = positions_for(sid)
        if not pos:
            sb.table("executions").update(
                {"status": "closed", "updated_at": datetime.now(timezone.utc).isoformat()}
            ).eq("signal_id", sid).execute()
            log(f"#{sid} all positions closed")
            continue
        if len(pos) < placed:
            # At least one TP hit -> protect the rest at their own entry.
            for p in pos:
                if abs(p.sl - p.price_open) < (mt5.symbol_info(SYMBOL).point or 1e-6):
                    continue  # already at BE
                req = {"action": mt5.TRADE_ACTION_SLTP, "position": p.ticket,
                       "symbol": SYMBOL, "sl": p.price_open, "tp": p.tp}
                mt5.order_send(req)
            sb.table("executions").update(
                {"status": "breakeven", "updated_at": datetime.now(timezone.utc).isoformat()}
            ).eq("signal_id", sid).execute()
            log(f"#{sid} TP1 hit -> remaining SL moved to breakeven")


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def fetch_new_signals():
    age = datetime.now(timezone.utc) - timedelta(minutes=MAX_SIGNAL_AGE_MIN)
    cutoff = max(START_TS, age).isoformat()
    sigs = (
        sb.table("signals").select("*")
        .eq("source", SIGNAL_SOURCE)
        .in_("status", ["open", "pending"])
        .gte("created_at", cutoff)
        .order("id")
        .execute()
    ).data or []
    if not sigs:
        return []
    done = {
        r["signal_id"]
        for r in (sb.table("executions").select("signal_id").execute().data or [])
    }
    return [s for s in sigs if s["id"] not in done]


def main():
    info = mt5_init()
    account = str(info.login)
    log(f"watching source='{SIGNAL_SOURCE}' (only signals after {START_TS:%H:%M:%S}, "
        f"max age {MAX_SIGNAL_AGE_MIN}m). Ctrl-C to stop.")
    try:
        while True:
            try:
                bal = mt5.account_info().balance
                for sig in fetch_new_signals():
                    execute_signal(sig, account, bal)
                manage()
            except Exception as e:
                log("loop error:", repr(e))
            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        pass
    finally:
        mt5.shutdown()
        log("stopped.")


if __name__ == "__main__":
    main()
