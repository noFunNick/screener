# Read stocks
import yfinance as yf

# For plotting
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import plotly.io as pio
pio.renderers.default = "browser"

# Data & TA
import pandas as pd
import numpy as np
import talib as ta

# Config
from jproperties import Properties
import datetime

# -------------------------------------------------
# Helper: load tickers from JSON (kept from original)
# -------------------------------------------------
def getTickersFromFile(filename):
    tickers = []
    with open(filename, 'r') as file:
        data = file.read()
        lines = data.splitlines()
        for line in lines:
            if '"ticker":' in line:
                ticker = line.split('"ticker":')[1].split('"')[1]
                tickers.append(ticker)
    return tickers

# -------------------------------------------------
# Dates & Config
# -------------------------------------------------
today = datetime.date.today().strftime("%Y-%m-%d")
twelve_months_ago = (datetime.date.today() - datetime.timedelta(days=365)).strftime("%Y-%m-%d")
five_years_ago = (datetime.date.today() - datetime.timedelta(days=1825)).strftime("%Y-%m-%d")

configs = Properties()
with open('config.properties', 'rb') as config_file:
    configs.load(config_file)

TICKER   = configs.get('TICKER').data
TEMPLATE = configs.get('TEMPLATE').data
TICKERS  = configs.get('TICKERS').data
NYSE     = configs.get('NYSE').data
NASDAQ    = configs.get('NASDAQ1B').data
TEST = configs.get('TEST').data
start = five_years_ago
tick_list = TICKERS.split()
# NYSE_list = NYSE.split()
# tick_list = NASDAQ.split()
tick_list = TEST.split()

# -------------------------------------------------
# Options liquidity filter
# -------------------------------------------------
def has_liquid_options(symbol, min_oi=3500, max_spread_pct=0.05):
    """
    Strict options liquidity filter.
    - Minimum Open Interest: 500
    - Maximum bid-ask spread: 5% of mid
    """
    t = yf.Ticker(symbol)
    try:
        if not t.options:
            return False

        exp = t.options[0]  # nearest expiration
        chain = t.option_chain(exp)
        calls = chain.calls.copy()
        puts  = chain.puts.copy()

        calls['openInterest'] = pd.to_numeric(calls['openInterest'], errors='coerce').fillna(0)
        puts['openInterest']  = pd.to_numeric(puts['openInterest'],  errors='coerce').fillna(0)

        max_call_oi = calls['openInterest'].max() if not calls.empty else 0
        max_put_oi  = puts['openInterest'].max()  if not puts.empty  else 0

        if max(max_call_oi, max_put_oi) < min_oi:
            return False

        # Force single best contract
        if max_call_oi >= max_put_oi:
            best = calls[calls['openInterest'] == max_call_oi].iloc[0]
        else:
            best = puts[puts['openInterest'] == max_put_oi].iloc[0]

        bid = float(best['bid']) if pd.notna(best['bid']) else 0.0
        ask = float(best['ask']) if pd.notna(best['ask']) else 0.0
        mid = (bid + ask) / 2

        if mid <= 0:
            return False

        spread = (ask - bid) / mid
        return spread <= max_spread_pct   # now 5%

    except Exception:
        return False


# -------------------------------------------------
# Main momentum-continuation scanner (day-trade / open focused)
# -------------------------------------------------

def analyze_momentum_candidate(symbol, start, debug=False):
    """
    True momentum continuation scorer for open / day-trade setups.
    Priorities (in order):
    1. Closed near previous-day high
    2. High relative volume (especially last day + 5d)
    3. Already trending upward (price > SMAs, +DI > -DI, ADX rising or strong)
    4. Relative strength vs SPY
    Hard filters kept: liquid enough, options optional, price sanity.
    """
    try:
        t = yf.Ticker(symbol.replace('.', '-'))
        # Faster window is fine for day-trade signals
        df = t.history(start=start, auto_adjust=True)[['Open', 'High', 'Low', 'Close', 'Volume']]
        if len(df) < 120:
            return None

        latest_price = df['Close'].iloc[-1]
        if latest_price > 350 or latest_price < 5:   # relaxed upper, still avoid micro-junk
            return None

        # Indicators (safe)
        try:
            df['SMA20']    = ta.SMA(df['Close'], 20)
            df['SMA50']    = ta.SMA(df['Close'], 50)
            df['SMA200']   = ta.SMA(df['Close'], 200)
            df['RSI']      = ta.RSI(df['Close'], 14)
            df['ATR']      = ta.ATR(df['High'], df['Low'], df['Close'], 14)
            df['ADX']      = ta.ADX(df['High'], df['Low'], df['Close'], 14)
            df['PLUS_DI']  = ta.PLUS_DI(df['High'], df['Low'], df['Close'], 14)
            df['MINUS_DI'] = ta.MINUS_DI(df['High'], df['Low'], df['Close'], 14)

            macd, macdsignal, macdhist = ta.MACD(df['Close'], 12, 26, 9)
            df['MACD_hist'] = macdhist
        except Exception:
            return None

        df = df.dropna(subset=['ADX', 'PLUS_DI', 'MINUS_DI', 'RSI', 'ATR', 'SMA20', 'SMA50'])
        if len(df) < 60:
            return None

        latest = df.iloc[-1]
        prev   = df.iloc[-2]
        prev2  = df.iloc[-3] if len(df) > 2 else prev

        # Liquidity
        dollar_vol_20d = (df['Close'] * df['Volume']).iloc[-20:].mean()
        if dollar_vol_20d < 15_000_000:          # slightly higher bar
            return None

        options_ok = has_liquid_options(symbol, min_oi=250, max_spread_pct=0.15)

        # Relative Strength vs SPY (3-month)
        spy = yf.Ticker('SPY').history(start=start, auto_adjust=True)['Close']
        common_idx = df.index.intersection(spy.index)
        if len(common_idx) < 70:
            return None
        stock_close = df['Close'].loc[common_idx]
        spy_close   = spy.loc[common_idx]
        lookback = 63
        stock_perf = stock_close.iloc[-1] / stock_close.iloc[-lookback] - 1
        spy_perf   = spy_close.iloc[-1] / spy_close.iloc[-lookback] - 1
        rs = (1 + stock_perf) / (1 + spy_perf) if (1 + spy_perf) != 0 else 0

        # -------------------------------------------------
        # KEY NEW METRICS for open momentum
        # -------------------------------------------------
        # 1. How close did it close to the high? (lower % = stronger)
        pct_from_high = (latest['High'] - latest['Close']) / latest['Close'] * 100
        atr_from_high = (latest['High'] - latest['Close']) / latest['ATR'] if latest['ATR'] > 0 else 99

        # 2. Relative volume
        vol_20 = df['Volume'].iloc[-20:].mean()
        vol_5  = df['Volume'].iloc[-5:].mean()
        rel_vol_today = latest['Volume'] / vol_20 if vol_20 > 0 else 0
        rel_vol_5d    = vol_5 / vol_20 if vol_20 > 0 else 0

        # 3. Recent higher highs / higher closes
        higher_high = latest['High'] > prev['High'] > prev2['High']
        higher_close = latest['Close'] > prev['Close'] > prev2['Close']
        consecutive_up = (latest['Close'] > prev['Close']) and (prev['Close'] > prev2['Close'])

        # -------------------------------------------------
        # SCORING – heavily tilted to near-high + volume + trend
        # -------------------------------------------------
        score = 0.0

        # A. Proximity to previous-day high  (max 35)  ← biggest change
        if pct_from_high <= 0.3 or atr_from_high <= 0.25:
            score += 35
        elif pct_from_high <= 0.7 or atr_from_high <= 0.5:
            score += 28
        elif pct_from_high <= 1.2 or atr_from_high <= 0.8:
            score += 18
        elif pct_from_high <= 2.0:
            score += 8

        # B. Volume surge (max 30)
        if rel_vol_today >= 2.5 or rel_vol_5d >= 2.0:
            score += 30
        elif rel_vol_today >= 1.8 or rel_vol_5d >= 1.6:
            score += 24
        elif rel_vol_today >= 1.4 or rel_vol_5d >= 1.3:
            score += 16
        elif rel_vol_today >= 1.1:
            score += 8

        # C. Trend structure (max 20)
        if latest['Close'] > latest['SMA20'] > latest['SMA50'] > latest['SMA200']:
            score += 20
        elif latest['Close'] > latest['SMA20'] > latest['SMA50']:
            score += 14
        elif latest['Close'] > latest['SMA50']:
            score += 8
        elif latest['SMA50'] > latest['SMA200']:
            score += 3

        # D. Directional movement (max 15)
        plus_di  = latest['PLUS_DI']
        minus_di = latest['MINUS_DI']
        di_spread = plus_di - minus_di
        if plus_di > minus_di:
            if di_spread >= 12:   score += 15
            elif di_spread >= 8:  score += 11
            elif di_spread >= 4:  score += 7
            else:                 score += 3

        # E. ADX strength / rising (max 12)
        adx = latest['ADX']
        adx_rising = adx > prev['ADX']
        if adx >= 35 and adx_rising:   score += 12
        elif adx >= 30:                score += 9
        elif adx >= 25:                score += 6
        elif adx >= 20:                score += 3

        # F. Consecutive strength bonus (max 10)
        if higher_high and higher_close:
            score += 10
        elif consecutive_up:
            score += 6
        elif latest['Close'] > prev['Close']:
            score += 3

        # G. Relative Strength (max 8)
        if rs >= 1.20:   score += 8
        elif rs >= 1.10: score += 6
        elif rs >= 1.03: score += 4
        elif rs >= 0.98: score += 1

        # H. RSI – mild momentum bonus (no heavy penalty)
        rsi = latest['RSI']
        if 55 <= rsi <= 78:
            score += 5
        elif rsi > 78:
            score += 2          # still allow parabolic continuation
        elif rsi < 40:
            score -= 6

        # I. MACD confirmation (max 5)
        if latest['MACD_hist'] > prev['MACD_hist'] and latest['MACD_hist'] > 0:
            score += 5
        elif latest['MACD_hist'] > 0:
            score += 2

        # Options liquidity (small)
        if options_ok:
            score += 2
        else:
            score -= 3

        # Risk:Reward (for reference only)
        atr = latest['ATR']
        entry = latest['Close']
        stop = entry - 1.2 * atr          # tighter for day trades
        target = entry + 2.5 * atr
        risk_reward = (target - entry) / (entry - stop) if (entry - stop) > 0 else 0

        return {
            'symbol': symbol,
            'score': round(score, 1),
            'close': round(entry, 2),
            'pct_from_high': round(pct_from_high, 2),
            'atr_from_high': round(atr_from_high, 2),
            'rel_vol_today': round(rel_vol_today, 2),
            'rel_vol_5d': round(rel_vol_5d, 2),
            'rsi': round(rsi, 1),
            'adx': round(adx, 1),
            'plus_di': round(plus_di, 1),
            'rs_3m': round(rs, 2),
            'atr': round(atr, 2),
            'stop': round(stop, 2),
            'target': round(target, 2),
            'risk_reward': round(risk_reward, 2),
            'dollar_vol_20d': int(dollar_vol_20d),
            'options_ok': bool(options_ok),
            'higher_high': bool(higher_high),
            'consecutive_up': bool(consecutive_up)
        }

    except Exception as e:
        if debug:
            print(f"{symbol}: error → {e}")
        return None

print("Scoring all tickers for open momentum...\n")
results = []
start = twelve_months_ago


for symbol in tick_list:
    result = analyze_momentum_candidate(symbol, start)
    if result:
        results.append(result)

top20 = sorted(results, key=lambda x: x['score'], reverse=True)[:20]

print("\n===== TOP 20 – Momentum Continuation (Near High + Volume + Trend) =====\n")
for i, r in enumerate(top20, 1):
    print(f"{i:2}. {r['symbol']:6} | Score: {r['score']:5.1f} | "
          f"Price: ${r['close']:6.2f} | FromHigh: {r['pct_from_high']:4.1f}% | "
          f"Vol: {r['rel_vol_today']:.1f}x | RSI: {r['rsi']:4.1f} | "
          f"ADX: {r['adx']:4.1f} | RR: {r['risk_reward']:.1f}")

# create json file with results
import json
datestamptext = datetime.datetime.now().strftime("%Y-%m-%d")
with open(f'momentum_results_{datestamptext}.json', 'w') as f:
    json.dump(top20, f, indent=4)

    