// ============================================================================
// BINANCE FUTURES AGGRESSIVE FLOW MONITOR (Enhanced Version with OKX OI)
// Individual symbol filters + Trading bot integration + OKX WebSocket OI tracking
// ============================================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ============================================================================
// CONFIGURATION WITH INDIVIDUAL SYMBOL SETTINGS + OI
// ============================================================================

const CONFIG = {
  // Individual symbol configurations
  SYMBOL_CONFIGS: {
    'ADAUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'TAOUSDT': {
      minVolumeUSD: 1_500_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'HYPEUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 0.8,
      cooldownMinutes: 5,
      enabled: true
    },
    'PEPEUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.6,
      cooldownMinutes: 5,
      enabled: true
    },
    'WIFUSDT': {
      minVolumeUSD: 1_500_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    },
    'BONKUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    },
    'DOGEUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 0.75,
      cooldownMinutes: 5,
      enabled: true
    },
    'XRPUSDT': {
      minVolumeUSD: 5_000_000,
      minDominance: 70.0,
      minPriceChange: 1,
      cooldownMinutes: 5,
      enabled: true
    },
    'UNIUSDT': {
      minVolumeUSD: 1_000_000,
      minDominance: 65.0,
      minPriceChange: 0.5,
      cooldownMinutes: 5,
      enabled: true
    }
  },
  
  // Time window for aggregation
  WINDOW_SECONDS: parseInt(process.env.WINDOW_SECONDS) || 180,
  
  // Open Interest settings (OKX WebSocket)
  OI_ENABLED: process.env.OI_ENABLED === 'true' || true,
  OI_WINDOW_SECONDS: parseInt(process.env.OI_WINDOW_SECONDS) || 300, // 5 хвилин для OI аналізу
  OI_HISTORY_MINUTES: 10, // Зберігати історію на 10 хвилин
  OI_FINAL_CHECK_OFFSET_MS: 2000, // За 2 секунди до кінця хвилини робимо фінальну перевірку
  
  // OI Threshold Filters (мінімальні пороги для використання OI в логіці)
  // Якщо зміни менші за ці пороги, OI не використовується і алерт йде по базовій логіці
  OI_MIN_DELTA_PERCENT: parseFloat(process.env.OI_MIN_DELTA_PERCENT) || 0.6, // Мінімальна зміна OI (%)
  OI_MIN_PRICE_CHANGE_PERCENT: parseFloat(process.env.OI_MIN_PRICE_CHANGE_PERCENT) || 0.35, // Мінімальна зміна ціни (%)
  
  // Trading Hours
  TRADING_HOURS_ENABLED: process.env.TRADING_HOURS_ENABLED === 'true' || false,
  TRADING_START_HOUR_UTC: parseInt(process.env.TRADING_START_HOUR_UTC) || 5,
  TRADING_END_HOUR_UTC: parseInt(process.env.TRADING_END_HOUR_UTC) || 14,
  
  // System
  STATS_LOG_INTERVAL: parseInt(process.env.STATS_LOG_INTERVAL) || 60,
  MAX_RECONNECTS: parseInt(process.env.MAX_RECONNECTS) || 10,
  
  // Binance API (тільки для aggTrade WebSocket)
  BINANCE_WS: 'wss://fstream.binance.com/ws',
  
  // OKX API
  OKX_WS_PUBLIC: 'wss://ws.okx.com:8443/ws/v5/public',
  
  // Telegram
  TELEGRAM_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  
  // Trading bot integration settings
  TRADING_BOT_ENABLED: process.env.TRADING_BOT_ENABLED === 'true' || false,
  ALERT_FORMAT: 'structured' // 'structured' for bot parsing or 'human' for readable
};

// Helper to get enabled symbols
CONFIG.getEnabledSymbols = () => {
  return Object.keys(CONFIG.SYMBOL_CONFIGS).filter(
    symbol => CONFIG.SYMBOL_CONFIGS[symbol].enabled
  );
};

// Helper to get config for symbol
CONFIG.getSymbolConfig = (symbol) => {
  return CONFIG.SYMBOL_CONFIGS[symbol] || null;
};

// Helper: Binance symbol to OKX format (BTCUSDT -> BTC-USDT-SWAP)
CONFIG.binanceToOKX = (binanceSymbol) => {
  // BTCUSDT -> BTC-USDT-SWAP
  const base = binanceSymbol.replace('USDT', '');
  return `${base}-USDT-SWAP`;
};

// Helper: OKX symbol to Binance format (BTC-USDT-SWAP -> BTCUSDT)
CONFIG.okxToBinance = (okxSymbol) => {
  // BTC-USDT-SWAP -> BTCUSDT
  return okxSymbol.replace('-USDT-SWAP', 'USDT');
};

// Helper: Check if within trading hours
CONFIG.isWithinTradingHours = () => {
  if (!CONFIG.TRADING_HOURS_ENABLED) {
    return true;
  }
  
  const now = new Date();
  const hourUTC = now.getUTCHours();
  
  return hourUTC >= CONFIG.TRADING_START_HOUR_UTC && hourUTC < CONFIG.TRADING_END_HOUR_UTC;
};

// ============================================================================
// OKX OPEN INTEREST TRACKER (WebSocket with local cache)
// ============================================================================

class OKXOpenInterestTracker {
  constructor(symbols, windowSeconds, historyMinutes) {
    this.binanceSymbols = symbols; // BTCUSDT, ETHUSDT...
    this.windowMs = windowSeconds * 1000;
    this.historyMs = historyMinutes * 60 * 1000;
    
    // Локальний кеш: Map<OKX_SYMBOL, {lastOI, lastPrice, history}>
    // history: [{ts, oi, price}]
    this.oiCache = new Map();
    
    // Ініціалізація кешу
    this.binanceSymbols.forEach(binanceSymbol => {
      const okxSymbol = CONFIG.binanceToOKX(binanceSymbol);
      this.oiCache.set(okxSymbol, {
        lastOI: null,
        lastPrice: null,
        history: []
      });
    });
    
    this.ws = null;
    this.reconnectCount = 0;
    this.reconnectTimer = null;
    this.heartbeatInterval = null;
    this.isRunning = false;
  }

  start() {
    if (this.isRunning) {
      console.log('[OKX-OI] Вже запущено');
      return;
    }

    this.isRunning = true;
    console.log(`[OKX-OI] Запуск WebSocket трекінгу для ${this.binanceSymbols.length} символів`);
    this.connect();
  }

  connect() {
    try {
      this.ws = new WebSocket(CONFIG.OKX_WS_PUBLIC);

      this.ws.on('open', () => {
        console.log('[OKX-OI] WebSocket підключено');
        this.reconnectCount = 0;
        this.subscribeToChannels();
        this.startHeartbeat();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data);
      });

      this.ws.on('error', (error) => {
        console.error('[OKX-OI] WebSocket помилка:', error.message);
      });

      this.ws.on('close', () => {
        console.log('[OKX-OI] WebSocket закрито');
        this.stopHeartbeat();
        this.scheduleReconnect();
      });

    } catch (error) {
      console.error('[OKX-OI] Помилка створення WebSocket:', error.message);
      this.scheduleReconnect();
    }
  }

  subscribeToChannels() {
    // Підписуємось на open-interest та mark-price для всіх символів
    const args = [];
    
    this.binanceSymbols.forEach(binanceSymbol => {
      const okxSymbol = CONFIG.binanceToOKX(binanceSymbol);
      
      // Open Interest channel
      args.push({
        channel: 'open-interest',
        instId: okxSymbol
      });
      
      // Mark Price channel (або можна використати tickers для last price)
      args.push({
        channel: 'mark-price',
        instId: okxSymbol
      });
    });

    const subscribeMessage = {
      op: 'subscribe',
      args: args
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    console.log(`[OKX-OI] Підписка на ${args.length} каналів (${this.binanceSymbols.length} символів)`);
  }

  handleMessage(data) {
    try {
      const message = JSON.parse(data);
      
      // Ping-pong
      if (message.event === 'ping') {
        this.ws.send(JSON.stringify({ op: 'pong' }));
        return;
      }
      
      // Subscription confirmation
      if (message.event === 'subscribe') {
        // console.log('[OKX-OI] Підписка підтверджена:', message.arg);
        return;
      }
      
      // Data updates
      if (message.data && Array.isArray(message.data) && message.arg) {
        const channel = message.arg.channel;
        const instId = message.arg.instId; // OKX symbol (BTC-USDT-SWAP)
        
        if (channel === 'open-interest') {
          this.handleOpenInterest(instId, message.data);
        } else if (channel === 'mark-price') {
          this.handleMarkPrice(instId, message.data);
        }
      }
      
    } catch (error) {
      console.error('[OKX-OI] Помилка обробки повідомлення:', error.message);
    }
  }

  handleOpenInterest(okxSymbol, dataArray) {
    if (!dataArray || dataArray.length === 0) return;
    
    const data = dataArray[0];
    const oi = parseFloat(data.oi);
    const timestamp = parseInt(data.ts);
    
    if (isNaN(oi) || isNaN(timestamp)) return;
    
    const cache = this.oiCache.get(okxSymbol);
    if (!cache) return;
    
    cache.lastOI = oi;
    
    // Додаємо в історію
    this.addToHistory(okxSymbol, timestamp, oi, cache.lastPrice);
  }

  handleMarkPrice(okxSymbol, dataArray) {
    if (!dataArray || dataArray.length === 0) return;
    
    const data = dataArray[0];
    const markPrice = parseFloat(data.markPx);
    const timestamp = parseInt(data.ts);
    
    if (isNaN(markPrice) || isNaN(timestamp)) return;
    
    const cache = this.oiCache.get(okxSymbol);
    if (!cache) return;
    
    cache.lastPrice = markPrice;
    
    // Додаємо в історію
    this.addToHistory(okxSymbol, timestamp, cache.lastOI, markPrice);
  }

  addToHistory(okxSymbol, timestamp, oi, price) {
    const cache = this.oiCache.get(okxSymbol);
    if (!cache) return;
    
    // Якщо обидва значення доступні, додаємо
    if (oi !== null && price !== null) {
      cache.history.push({ ts: timestamp, oi, price });
      
      // Видаляємо старі записи
      const cutoff = Date.now() - this.historyMs;
      cache.history = cache.history.filter(item => item.ts >= cutoff);
    }
  }

  getOIStats(binanceSymbol) {
    const okxSymbol = CONFIG.binanceToOKX(binanceSymbol);
    const cache = this.oiCache.get(okxSymbol);
    
    if (!cache || cache.history.length === 0) {
      return null;
    }

    const now = Date.now();
    const windowAgoTime = now - this.windowMs;

    // Поточні значення (останній запис)
    const latest = cache.history[cache.history.length - 1];
    const oiNow = latest.oi;
    const priceNow = latest.price;

    // Знаходимо найближчий запис старіше за window
    let oi5mAgo = null;
    let price5mAgo = null;
    
    for (let i = cache.history.length - 1; i >= 0; i--) {
      if (cache.history[i].ts <= windowAgoTime) {
        oi5mAgo = cache.history[i].oi;
        price5mAgo = cache.history[i].price;
        break;
      }
    }

    // Якщо немає даних за window назад, не можемо порахувати delta
    if (oi5mAgo === null || price5mAgo === null) {
      return {
        oiNow,
        oi5mAgo: null,
        oiDeltaPct: null,
        oiDelta: null,
        priceNow,
        price5mAgo: null,
        priceDeltaPct: null,
        hasWindowData: false,
        historyCount: cache.history.length
      };
    }

    const oiDelta = oiNow - oi5mAgo;
    const oiDeltaPct = (oiDelta / oi5mAgo) * 100;
    
    const priceDelta = priceNow - price5mAgo;
    const priceDeltaPct = (priceDelta / price5mAgo) * 100;

    return {
      oiNow,
      oi5mAgo,
      oiDeltaPct,
      oiDelta,
      priceNow,
      price5mAgo,
      priceDeltaPct,
      hasWindowData: true,
      historyCount: cache.history.length
    };
  }

  getHistoryCount(binanceSymbol) {
    const okxSymbol = CONFIG.binanceToOKX(binanceSymbol);
    const cache = this.oiCache.get(okxSymbol);
    return cache ? cache.history.length : 0;
  }

  startHeartbeat() {
    // OKX WebSocket heartbeat (ping every 20s)
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  scheduleReconnect() {
    if (!this.isRunning) return;
    
    this.reconnectCount++;
    const delay = Math.min(5000 * this.reconnectCount, 60000); // Max 60s
    
    console.log(`[OKX-OI] Переподключення через ${delay / 1000}s (спроба ${this.reconnectCount})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  stop() {
    this.isRunning = false;
    this.stopHeartbeat();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    console.log('[OKX-OI] Зупинено');
  }
}

// ============================================================================
// SYMBOL STATE
// ============================================================================

class SymbolState {
  constructor(symbol, windowSeconds) {
    this.symbol = symbol;
    this.windowMs = windowSeconds * 1000;
    this.trades = [];
    this.firstPrice = null;
    this.lastPrice = null;
  }

  addTrade(timestamp, price, quantity, isBuyerMaker) {
    const volume = price * quantity;
    
    const trade = {
      timestamp,
      price,
      buyVol: isBuyerMaker ? 0 : volume,
      sellVol: isBuyerMaker ? volume : 0
    };

    this.trades.push(trade);
    this.lastPrice = price;
    
    if (this.firstPrice === null) {
      this.firstPrice = price;
    }

    this.cleanup(timestamp);
  }

  cleanup(currentTime) {
    const cutoff = currentTime - this.windowMs;
    this.trades = this.trades.filter(t => t.timestamp >= cutoff);

    if (this.trades.length > 0) {
      this.firstPrice = this.trades[0].price;
    } else {
      this.firstPrice = null;
    }
  }

  getStats() {
    if (this.trades.length === 0) return null;

    let buyVolume = 0;
    let sellVolume = 0;

    for (const trade of this.trades) {
      buyVolume += trade.buyVol;
      sellVolume += trade.sellVol;
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return null;

    const buyDominance = (buyVolume / totalVolume) * 100;
    const sellDominance = (sellVolume / totalVolume) * 100;
    
    const dominantSide = buyVolume > sellVolume ? 'buy' : 'sell';
    const dominance = Math.max(buyDominance, sellDominance);

    const priceChange = this.firstPrice 
      ? ((this.lastPrice - this.firstPrice) / this.firstPrice) * 100
      : 0;

    const duration = (this.trades[this.trades.length - 1].timestamp - this.trades[0].timestamp) / 1000;

    return {
      buyVolume,
      sellVolume,
      totalVolume,
      dominantSide,
      dominance,
      priceChange,
      duration,
      tradeCount: this.trades.length,
      lastPrice: this.lastPrice
    };
  }

  reset() {
    this.trades = [];
    this.firstPrice = null;
    this.lastPrice = null;
  }
}

// ============================================================================
// TRADE AGGREGATOR
// ============================================================================

class TradeAggregator {
  constructor(windowSeconds) {
    this.windowSeconds = windowSeconds;
    this.states = new Map();
  }

  addTrade(symbol, timestamp, price, quantity, isBuyerMaker) {
    if (!this.states.has(symbol)) {
      this.states.set(symbol, new SymbolState(symbol, this.windowSeconds));
    }
    this.states.get(symbol).addTrade(timestamp, price, quantity, isBuyerMaker);
  }

  getStats(symbol) {
    const state = this.states.get(symbol);
    return state ? state.getStats() : null;
  }

  resetSymbol(symbol) {
    const state = this.states.get(symbol);
    if (state) state.reset();
  }

  getActiveCount() {
    return this.states.size;
  }

  getTotalTrades() {
    let total = 0;
    for (const state of this.states.values()) {
      total += state.trades.length;
    }
    return total;
  }
}

// ============================================================================
// SIGNAL ENGINE (з OKX OI логікою)
// ============================================================================

class SignalEngine {
  constructor(oiTracker = null) {
    this.oiTracker = oiTracker;
  }

  shouldAlert(symbol, stats) {
    if (!stats) return false;
    
    const config = CONFIG.getSymbolConfig(symbol);
    if (!config || !config.enabled) return false;
    
    // Перевірка Trading Hours
    if (!CONFIG.isWithinTradingHours()) {
      return false;
    }
    
    // Apply individual symbol filters
    if (stats.totalVolume < config.minVolumeUSD) return false;
    if (stats.dominance < config.minDominance) return false;
    if (Math.abs(stats.priceChange) < config.minPriceChange) return false;
    
    // Direction alignment
    if (stats.dominantSide === 'buy' && stats.priceChange < 0) return false;
    if (stats.dominantSide === 'sell' && stats.priceChange > 0) return false;

    return true;
  }

  interpretSignal(stats, oiStats = null) {
    // Базовий напрямок на основі агресивних трейдів
    let flowDirection, flowType, flowLabel, flowEmoji;
    
    if (stats.dominantSide === 'buy') {
      flowDirection = 'LONG';
      flowType = 'SHORT_SQUEEZE';
      flowLabel = 'SHORT SQUEEZE';
      flowEmoji = '🟢';
    } else {
      flowDirection = 'SHORT';
      flowType = 'LONG_LIQUIDATION';
      flowLabel = 'LONG LIQUIDATION';
      flowEmoji = '🔴';
    }

    // Якщо OI не доступний, повертаємо базовий напрямок
    if (!CONFIG.OI_ENABLED || !this.oiTracker || !oiStats || !oiStats.hasWindowData) {
      return {
        type: flowType,
        label: flowLabel,
        emoji: flowEmoji,
        direction: flowDirection,
        flowDirection: flowDirection,
        finalDirection: flowDirection,
        oiOverride: false,
        oiReason: null,
        decision: 'NO_OI_DATA',
        oiUsed: false,
        oiDeltaPassed: false,
        oiPricePassed: false,
        oiMinDeltaPercent: CONFIG.OI_MIN_DELTA_PERCENT,
        oiMinPriceChangePercent: CONFIG.OI_MIN_PRICE_CHANGE_PERCENT
      };
    }

    // ========================================================================
    // OI DECISION LOGIC (Найважливіша частина)
    // ========================================================================
    
    let finalDirection = flowDirection;
    let oiOverride = false;
    let oiReason = null;
    let decision = 'BOUNCE'; // або 'CONTINUATION'
    let oiUsed = false; // Чи використовується OI в логіці
    let oiDeltaPassed = false; // Чи пройдено поріг OI
    let oiPricePassed = false; // Чи пройдено поріг ціни

    const { oiDeltaPct, priceDeltaPct } = oiStats;
    
    // ========================================================================
    // ПЕРЕВІРКА ПОРОГІВ OI (OI Threshold Filters)
    // ========================================================================
    // Якщо зміни OI або ціни менші за мінімальні пороги,
    // OI НЕ використовується і алерт йде по базовій логіці
    
    const minOIDelta = CONFIG.OI_MIN_DELTA_PERCENT;
    const minPriceChange = CONFIG.OI_MIN_PRICE_CHANGE_PERCENT;
    
    // Перевірка: чи достатня зміна OI?
    oiDeltaPassed = Math.abs(oiDeltaPct) >= minOIDelta;
    
    // Перевірка: чи достатня зміна ціни?
    oiPricePassed = Math.abs(priceDeltaPct) >= minPriceChange;
    
    // OI використовується тільки якщо обидва пороги пройдені
    oiUsed = oiDeltaPassed && oiPricePassed;
    
    // Якщо пороги не пройдені - логування і повернення базової логіки
    if (!oiUsed) {
      const reasons = [];
      if (!oiDeltaPassed) {
        reasons.push(`OI Δ=${Math.abs(oiDeltaPct).toFixed(2)}% < ${minOIDelta}%`);
      }
      if (!oiPricePassed) {
        reasons.push(`Price Δ=${Math.abs(priceDeltaPct).toFixed(2)}% < ${minPriceChange}%`);
      }
      
      console.log(`[OI-FILTER] OI ignored for ${stats.dominantSide} flow: ${reasons.join(', ')}`);
      
      return {
        type: flowType,
        label: flowLabel,
        emoji: flowEmoji,
        direction: flowDirection,
        flowDirection: flowDirection,
        finalDirection: flowDirection,
        oiOverride: false,
        oiReason: `OI ignored (below threshold: ${reasons.join(', ')})`,
        decision: 'BASE',
        oiUsed: false,
        oiDeltaPassed: oiDeltaPassed,
        oiPricePassed: oiPricePassed,
        oiMinDeltaPercent: minOIDelta,
        oiMinPriceChangePercent: minPriceChange
      };
    }
    
    // ========================================================================
    // OI пороги пройдені - використовуємо OI логіку
    // ========================================================================
    
    // Визначаємо порогові значення для визначення напрямку
    const OI_THRESHOLD = 0.5; // 0.5% зміна OI вважається значною
    const PRICE_THRESHOLD = 0.1; // 0.1% зміна ціни
    
    const priceRising = priceDeltaPct > PRICE_THRESHOLD;
    const priceFalling = priceDeltaPct < -PRICE_THRESHOLD;
    const oiRising = oiDeltaPct > OI_THRESHOLD;
    const oiFalling = oiDeltaPct < -OI_THRESHOLD;

    // ========================================================================
    // A) Ціна падає + OI росте → BREAKOUT вниз → SHORT continuation
    // ========================================================================
    if (priceFalling && oiRising) {
      finalDirection = 'SHORT';
      decision = 'CONTINUATION';
      oiReason = `Ціна ↓${Math.abs(priceDeltaPct).toFixed(2)}% + OI ↑${oiDeltaPct.toFixed(2)}% → Breakout вниз`;
      
      // Якщо початковий flow був LONG, це override
      if (flowDirection === 'LONG') {
        oiOverride = true;
      }
    }
    
    // ========================================================================
    // B) Ціна падає + OI падає → Long liquidation → BOUNCE LONG
    // ========================================================================
    else if (priceFalling && oiFalling) {
      finalDirection = 'LONG';
      decision = 'BOUNCE';
      oiReason = `Ціна ↓${Math.abs(priceDeltaPct).toFixed(2)}% + OI ↓${Math.abs(oiDeltaPct).toFixed(2)}% → Long liquidation, шанс на відскок`;
      
      // Якщо початковий flow був SHORT, це override
      if (flowDirection === 'SHORT') {
        oiOverride = true;
      }
    }
    
    // ========================================================================
    // C) Ціна росте + OI росте → BREAKOUT вверх → LONG continuation
    // ========================================================================
    else if (priceRising && oiRising) {
      finalDirection = 'LONG';
      decision = 'CONTINUATION';
      oiReason = `Ціна ↑${priceDeltaPct.toFixed(2)}% + OI ↑${oiDeltaPct.toFixed(2)}% → Breakout вверх`;
      
      // Якщо початковий flow був SHORT, це override
      if (flowDirection === 'SHORT') {
        oiOverride = true;
      }
    }
    
    // ========================================================================
    // D) Ціна росте + OI падає → Short squeeze → BOUNCE SHORT
    // ========================================================================
    else if (priceRising && oiFalling) {
      finalDirection = 'SHORT';
      decision = 'BOUNCE';
      oiReason = `Ціна ↑${priceDeltaPct.toFixed(2)}% + OI ↓${Math.abs(oiDeltaPct).toFixed(2)}% → Short squeeze, шанс на відскік`;
      
      // Якщо початковий flow був LONG, це override
      if (flowDirection === 'LONG') {
        oiOverride = true;
      }
    }
    
    // ========================================================================
    // Якщо зміни OI/ціни незначні, залишаємо як є
    // ========================================================================
    else {
      decision = 'INCONCLUSIVE';
      oiReason = `OI: ${oiDeltaPct >= 0 ? '+' : ''}${oiDeltaPct.toFixed(2)}%, Ціна: ${priceDeltaPct >= 0 ? '+' : ''}${priceDeltaPct.toFixed(2)}% → Без чіткого сигналу`;
    }

    return {
      type: flowType,
      label: flowLabel,
      emoji: flowEmoji,
      direction: finalDirection,
      flowDirection: flowDirection,
      finalDirection: finalDirection,
      oiOverride: oiOverride,
      oiReason: oiReason,
      decision: decision,
      oiUsed: oiUsed,
      oiDeltaPassed: oiDeltaPassed,
      oiPricePassed: oiPricePassed,
      oiMinDeltaPercent: CONFIG.OI_MIN_DELTA_PERCENT,
      oiMinPriceChangePercent: CONFIG.OI_MIN_PRICE_CHANGE_PERCENT
    };
  }
}

// ============================================================================
// COOLDOWN MANAGER
// ============================================================================

class CooldownManager {
  constructor() {
    this.lastAlerts = new Map();
  }

  canAlert(symbol, stats) {
    const config = CONFIG.getSymbolConfig(symbol);
    if (!config) return false;

    const key = `${symbol}_${stats.dominantSide}`;
    const lastTime = this.lastAlerts.get(key);
    
    if (!lastTime) return true;

    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastTime;
    
    return elapsed >= cooldownMs;
  }

  recordAlert(symbol, stats) {
    const key = `${symbol}_${stats.dominantSide}`;
    this.lastAlerts.set(key, Date.now());
  }

  getRemainingCooldown(symbol, side) {
    const config = CONFIG.getSymbolConfig(symbol);
    if (!config) return 0;

    const key = `${symbol}_${side}`;
    const lastTime = this.lastAlerts.get(key);
    
    if (!lastTime) return 0;

    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    const elapsed = Date.now() - lastTime;
    const remaining = Math.max(0, cooldownMs - elapsed);
    
    return Math.ceil(remaining / 1000);
  }
}

// ============================================================================
// ALERT MANAGER (оновлений з OI та фінальною перевіркою)
// ============================================================================

class AlertManager {
  constructor(telegram, oiTracker = null) {
    this.telegram = telegram;
    this.oiTracker = oiTracker;
    this.pendingAlerts = new Map();
    this.alertCount = 0;
    this.minuteCheckInterval = null;
    this.finalCheckTimers = new Map(); // Таймери для фінальної перевірки OI
    this.startMinuteChecker();
  }

  startMinuteChecker() {
    this.minuteCheckInterval = setInterval(() => {
      const now = new Date();
      const seconds = now.getSeconds();
      
      // Відправляємо алерти на початку хвилини
      if (seconds === 0 && this.pendingAlerts.size > 0) {
        this.flushPendingAlerts();
      }
    }, 1000);
  }

  sendAlert(symbol, stats, interpretation, oiStats = null) {
    const alertData = {
      symbol,
      stats,
      interpretation,
      oiStats,
      timestamp: Date.now()
    };

    const key = `${symbol}_${stats.dominantSide}`;
    
    if (!this.pendingAlerts.has(key)) {
      this.pendingAlerts.set(key, alertData);
      console.log(`[ALERT] Заплановано для ${symbol} ${interpretation.finalDirection} (відправка на початку хвилини)`);
      
      // Запланувати фінальну перевірку OI за 2 секунди до кінця хвилини
      this.scheduleFinalOICheck(key, alertData);
    }
  }

  scheduleFinalOICheck(key, alertData) {
    // Скасувати попередній таймер якщо є
    if (this.finalCheckTimers.has(key)) {
      clearTimeout(this.finalCheckTimers.get(key));
    }
    
    const now = new Date();
    const secondsUntilNextMinute = 60 - now.getSeconds();
    const msUntilFinalCheck = (secondsUntilNextMinute * 1000) - CONFIG.OI_FINAL_CHECK_OFFSET_MS;
    
    if (msUntilFinalCheck > 0) {
      const timer = setTimeout(() => {
        this.performFinalOICheck(key, alertData);
      }, msUntilFinalCheck);
      
      this.finalCheckTimers.set(key, timer);
    }
  }

  performFinalOICheck(key, alertData) {
    if (!this.pendingAlerts.has(key)) {
      return; // Алерт вже був видалений
    }
    
    // Отримуємо свіжі дані OI
    const freshOIStats = this.oiTracker ? this.oiTracker.getOIStats(alertData.symbol) : null;
    
    if (freshOIStats && freshOIStats.hasWindowData) {
      // Перераховуємо interpretation з новими даними OI
      const signalEngine = new SignalEngine(this.oiTracker);
      const updatedInterpretation = signalEngine.interpretSignal(alertData.stats, freshOIStats);
      
      // Логування фінальної перевірки
      console.log(`[FINAL-CHECK] ${alertData.symbol}:`, {
        oiNow: freshOIStats.oiNow.toFixed(0),
        oi5mAgo: freshOIStats.oi5mAgo?.toFixed(0),
        oiDeltaPct: freshOIStats.oiDeltaPct?.toFixed(2),
        priceDeltaPct: freshOIStats.priceDeltaPct?.toFixed(2),
        oiUsed: updatedInterpretation.oiUsed,
        oiDeltaPassed: updatedInterpretation.oiDeltaPassed,
        oiPricePassed: updatedInterpretation.oiPricePassed,
        decision: updatedInterpretation.decision,
        finalDirection: updatedInterpretation.finalDirection
      });
      
      // Оновлюємо алерт з фінальними даними
      alertData.interpretation = updatedInterpretation;
      alertData.oiStats = freshOIStats;
      this.pendingAlerts.set(key, alertData);
    }
    
    this.finalCheckTimers.delete(key);
  }

  async flushPendingAlerts() {
    console.log(`[ALERT] Відправка ${this.pendingAlerts.size} alert(s)...`);
    
    for (const [key, alertData] of this.pendingAlerts.entries()) {
      try {
        await this.sendTelegramMessage(alertData);
        this.alertCount++;
        
        // Видаляємо таймер фінальної перевірки якщо є
        if (this.finalCheckTimers.has(key)) {
          clearTimeout(this.finalCheckTimers.get(key));
          this.finalCheckTimers.delete(key);
        }
      } catch (error) {
        console.error(`[ALERT] Помилка відправки ${alertData.symbol}:`, error.message);
      }
    }
    
    this.pendingAlerts.clear();
  }

  async sendTelegramMessage(alertData) {
    const { symbol, stats, interpretation, oiStats } = alertData;
    
    let message;
    if (CONFIG.ALERT_FORMAT === 'structured') {
      message = this.formatStructuredMessage(symbol, stats, interpretation, oiStats);
    } else {
      message = this.formatHumanMessage(symbol, stats, interpretation, oiStats);
    }

    await this.telegram.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      message,
      { parse_mode: 'HTML' }
    );
  }

  formatStructuredMessage(symbol, stats, interpretation, oiStats) {
    const lines = [];
    
    // Header
    lines.push(`${interpretation.emoji} <b>${interpretation.label}</b>`);
    lines.push(`<code>───────────────────</code>`);
    
    const cleanSymbol = symbol.replace('USDT', '');
    lines.push(`🎯 <b>${symbol}</b> #${cleanSymbol}`);
    
    const priceSign = stats.priceChange >= 0 ? '+' : '';
    lines.push(`📈 Ціна: ${priceSign}${stats.priceChange.toFixed(2)}% | $${stats.lastPrice.toFixed(4)}`);
    lines.push(`💰 Об'єм: $${this.fmt(stats.totalVolume)} за ${stats.duration.toFixed(0)}с`);
    lines.push(`📊 Домінація: ${stats.dominance.toFixed(1)}% ${stats.dominantSide === 'buy' ? '🟢 BUY' : '🔴 SELL'}`);
    
    // OI Info з детальними метриками
    if (oiStats && oiStats.hasWindowData) {
      lines.push(`<code>───────────────────</code>`);
      lines.push(`📊 <b>OPEN INTEREST (OKX 5min)</b>`);
      lines.push(`OI зараз: ${this.fmtOI(oiStats.oiNow)}`);
      lines.push(`OI -5хв: ${this.fmtOI(oiStats.oi5mAgo)}`);
      
      const oiSign = oiStats.oiDeltaPct >= 0 ? '+' : '';
      const oiEmoji = oiStats.oiDeltaPct > 0 ? '📈' : oiStats.oiDeltaPct < 0 ? '📉' : '➡️';
      lines.push(`Δ OI: ${oiEmoji} ${oiSign}${oiStats.oiDeltaPct.toFixed(2)}%`);
      
      const priceSign5m = oiStats.priceDeltaPct >= 0 ? '+' : '';
      const priceEmoji5m = oiStats.priceDeltaPct > 0 ? '📈' : oiStats.priceDeltaPct < 0 ? '📉' : '➡️';
      lines.push(`Δ Ціна (5хв): ${priceEmoji5m} ${priceSign5m}${oiStats.priceDeltaPct.toFixed(2)}%`);
      
      // Відображення порогів OI
      lines.push(`<code>───────────────────</code>`);
      lines.push(`⚙️ <b>OI Filters</b>`);
      lines.push(`Min OI Δ: ${interpretation.oiMinDeltaPercent}% ${interpretation.oiDeltaPassed ? '✅' : '❌'}`);
      lines.push(`Min Price Δ: ${interpretation.oiMinPriceChangePercent}% ${interpretation.oiPricePassed ? '✅' : '❌'}`);
      lines.push(`OI Used: ${interpretation.oiUsed ? '✅ YES' : '❌ NO'}`);
      
      lines.push(`🧠 Decision: <b>${interpretation.decision}</b>`);
      
      if (interpretation.oiReason) {
        lines.push(`💡 ${interpretation.oiReason}`);
      }
    } else if (CONFIG.OI_ENABLED) {
      lines.push(`<code>───────────────────</code>`);
      lines.push(`⚠️ OI дані недоступні (${oiStats ? oiStats.historyCount : 0} записів)`);
    }
    
    // Direction
    lines.push(`<code>───────────────────</code>`);
    
    if (interpretation.flowDirection !== interpretation.finalDirection) {
      lines.push(`🔄 Flow: ${interpretation.flowDirection} → Final: <b>${interpretation.finalDirection}</b>`);
    } else {
      lines.push(`🎯 Напрямок: <b>${interpretation.finalDirection}</b>`);
    }
    
    lines.push(`<code>───────────────────</code>`);
    
    // Machine-readable JSON
    const data = {
      symbol,
      direction: interpretation.finalDirection,
      flowDirection: interpretation.flowDirection,
      finalDirection: interpretation.finalDirection,
      type: interpretation.type,
      decision: interpretation.decision,
      price: stats.lastPrice,
      priceChange: parseFloat(stats.priceChange.toFixed(4)),
      volume: parseFloat(stats.totalVolume.toFixed(2)),
      dominance: parseFloat(stats.dominance.toFixed(2)),
      dominantSide: stats.dominantSide,
      duration: parseFloat(stats.duration.toFixed(1)),
      timestamp: Date.now(),
      oiEnabled: CONFIG.OI_ENABLED,
      oiNow: oiStats?.oiNow || null,
      oi5mAgo: oiStats?.oi5mAgo || null,
      oiDeltaPct: oiStats?.oiDeltaPct ? parseFloat(oiStats.oiDeltaPct.toFixed(4)) : null,
      priceDeltaPct: oiStats?.priceDeltaPct ? parseFloat(oiStats.priceDeltaPct.toFixed(4)) : null,
      oiOverride: interpretation.oiOverride || false,
      oiReason: interpretation.oiReason || null,
      // Нові поля для OI фільтрів
      oiUsed: interpretation.oiUsed || false,
      oiDeltaPassed: interpretation.oiDeltaPassed || false,
      oiPricePassed: interpretation.oiPricePassed || false,
      oiMinDeltaPercent: interpretation.oiMinDeltaPercent || CONFIG.OI_MIN_DELTA_PERCENT,
      oiMinPriceChangePercent: interpretation.oiMinPriceChangePercent || CONFIG.OI_MIN_PRICE_CHANGE_PERCENT
    };
    
    lines.push(`<code>${JSON.stringify(data)}</code>`);
    
    return lines.join('\n');
  }

  formatHumanMessage(symbol, stats, interpretation, oiStats) {
    const lines = [];
    
    lines.push(`${interpretation.emoji} ${interpretation.label}`);
    lines.push(`💰 Об'єм: $${this.fmt(stats.totalVolume)} за ${stats.duration.toFixed(0)}с`);
    lines.push(`📊 Домінація: ${stats.dominance.toFixed(1)}% ${interpretation.finalDirection}`);
    lines.push('━━━━━━━━━━━━━━━━━');
    
    const cleanSymbol = symbol.replace('USDT', '');
    lines.push(`🎯 ${symbol} #${cleanSymbol}`);
    
    const priceSign = stats.priceChange >= 0 ? '+' : '';
    lines.push(`📈 Δ Ціни: ${priceSign}${stats.priceChange.toFixed(2)}%`);
    lines.push(`💵 Ціна: $${stats.lastPrice.toFixed(4)}`);
    
    if (oiStats && oiStats.hasWindowData) {
      lines.push('━━━━━━━━━━━━━━━━━');
      const oiSign = oiStats.oiDeltaPct >= 0 ? '+' : '';
      lines.push(`📊 OI (5хв): ${oiSign}${oiStats.oiDeltaPct.toFixed(2)}%`);
      
      const priceSign5m = oiStats.priceDeltaPct >= 0 ? '+' : '';
      lines.push(`📈 Ціна (5хв): ${priceSign5m}${oiStats.priceDeltaPct.toFixed(2)}%`);
      
      // OI фільтри
      lines.push(`⚙️ OI Used: ${interpretation.oiUsed ? 'YES ✅' : 'NO ❌'}`);
      if (!interpretation.oiUsed) {
        lines.push(`   (OI: ${interpretation.oiDeltaPassed ? '✅' : '❌'} | Price: ${interpretation.oiPricePassed ? '✅' : '❌'})`);
      }
      
      lines.push(`🧠 ${interpretation.decision}`);
      
      if (interpretation.oiReason) {
        lines.push(`💡 ${interpretation.oiReason}`);
      }
    }
    
    lines.push('━━━━━━━━━━━━━━━━━');
    lines.push(`🟢 Агресивний Buy: $${this.fmt(stats.buyVolume)}`);
    lines.push(`🔴 Агресивний Sell: $${this.fmt(stats.sellVolume)}`);
    
    return lines.join('\n');
  }

  fmt(num) {
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(0) + 'K';
    return num.toFixed(0);
  }

  fmtOI(num) {
    if (!num) return 'N/A';
    if (num >= 1_000_000) return (num / 1_000_000).toFixed(2) + 'M';
    if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
    return num.toFixed(0);
  }

  getCount() {
    return this.alertCount;
  }

  getPendingCount() {
    return this.pendingAlerts.size;
  }

  stop() {
    if (this.minuteCheckInterval) {
      clearInterval(this.minuteCheckInterval);
    }
    
    // Очистити всі таймери фінальної перевірки
    for (const timer of this.finalCheckTimers.values()) {
      clearTimeout(timer);
    }
    this.finalCheckTimers.clear();
  }
}

// ============================================================================
// MULTI-WEBSOCKET MANAGER (Binance aggTrade)
// ============================================================================

class MultiWebSocketManager {
  constructor(symbols, tradeAggregator, signalEngine, cooldownManager, alertManager, oiTracker = null) {
    this.symbols = symbols;
    this.tradeAggregator = tradeAggregator;
    this.signalEngine = signalEngine;
    this.cooldownManager = cooldownManager;
    this.alertManager = alertManager;
    this.oiTracker = oiTracker;
    
    this.connections = new Map();
    this.tradeCount = 0;
    this.lastStatsLog = Date.now();
    this.reconnectAttempts = new Map();
  }

  connectAll() {
    console.log(`[WS] Підключення до ${this.symbols.length} символів (Binance)...`);
    
    // Connect with small delays
    this.symbols.forEach((symbol, i) => {
      setTimeout(() => this.connectSymbol(symbol), i * 200);
    });
  }

  connectSymbol(symbol) {
    const streamName = `${symbol.toLowerCase()}@aggTrade`;
    const url = `${CONFIG.BINANCE_WS}/${streamName}`;
    
    const ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[WS] ${symbol} підключено`);
      this.reconnectAttempts.set(symbol, 0);
    });

    ws.on('message', (data) => {
      this.handleMessage(symbol, data);
    });

    ws.on('error', (error) => {
      console.error(`[WS] ${symbol} помилка:`, error.message);
    });

    ws.on('close', () => {
      console.log(`[WS] ${symbol} закрито`);
      this.reconnectSymbol(symbol);
    });

    this.connections.set(symbol, ws);
  }

  handleMessage(symbol, data) {
    try {
      const trade = JSON.parse(data);
      
      const price = parseFloat(trade.p);
      const quantity = parseFloat(trade.q);
      const timestamp = trade.T;
      const isBuyerMaker = trade.m;
      
      this.tradeAggregator.addTrade(symbol, timestamp, price, quantity, isBuyerMaker);
      this.tradeCount++;
      
      // Перевірка Trading Hours
      if (!CONFIG.isWithinTradingHours()) {
        return; // Не обробляємо алерти поза робочими годинами
      }
      
      // Check for signal
      const stats = this.tradeAggregator.getStats(symbol);
      const config = CONFIG.getSymbolConfig(symbol);
      
      if (stats && config && stats.totalVolume >= config.minVolumeUSD * 0.5) {
        if (this.signalEngine.shouldAlert(symbol, stats)) {
          if (this.cooldownManager.canAlert(symbol, stats)) {
            // Отримуємо OI статистику
            const oiStats = this.oiTracker ? this.oiTracker.getOIStats(symbol) : null;
            
            const interpretation = this.signalEngine.interpretSignal(stats, oiStats);
            
            // Логування метрик
            this.logAlertMetrics(symbol, stats, interpretation, oiStats);
            
            this.alertManager.sendAlert(symbol, stats, interpretation, oiStats);
            this.cooldownManager.recordAlert(symbol, stats);
            this.tradeAggregator.resetSymbol(symbol);
          }
        }
      }
      
      this.logStats();
      
    } catch (error) {
      console.error(`[WS] ${symbol} помилка парсингу:`, error.message);
    }
  }

  logAlertMetrics(symbol, stats, interpretation, oiStats) {
    console.log(`[ALERT-METRICS] ${symbol}:`, {
      oiNow: oiStats?.oiNow?.toFixed(0) || 'N/A',
      oi5mAgo: oiStats?.oi5mAgo?.toFixed(0) || 'N/A',
      oiDeltaPct: oiStats?.oiDeltaPct?.toFixed(2) || 'N/A',
      priceDeltaPct: oiStats?.priceDeltaPct?.toFixed(2) || 'N/A',
      oiUsed: interpretation.oiUsed,
      oiDeltaPassed: interpretation.oiDeltaPassed,
      oiPricePassed: interpretation.oiPricePassed,
      decision: interpretation.decision,
      finalDirection: interpretation.finalDirection
    });
  }

  logStats() {
    const now = Date.now();
    if (now - this.lastStatsLog < CONFIG.STATS_LOG_INTERVAL * 1000) {
      return;
    }

    const activeSymbols = this.tradeAggregator.getActiveCount();
    const totalTrades = this.tradeAggregator.getTotalTrades();
    const alerts = this.alertManager.getCount();
    const pendingAlerts = this.alertManager.getPendingCount();
    const connected = Array.from(this.connections.values()).filter(ws => ws.readyState === WebSocket.OPEN).length;
    
    let oiInfo = '';
    if (this.oiTracker && CONFIG.OI_ENABLED) {
      const sampleSymbol = this.symbols[0];
      const oiCount = this.oiTracker.getHistoryCount(sampleSymbol);
      oiInfo = ` | OI: ${oiCount} записів`;
    }
    
    const tradingStatus = CONFIG.TRADING_HOURS_ENABLED 
      ? (CONFIG.isWithinTradingHours() ? '✅ TRADING' : '⏸️ PAUSED')
      : '24/7';
    
    console.log(`[STATS] ${tradingStatus} | Підключено: ${connected}/${this.symbols.length} | Активних: ${activeSymbols} | Трейдів: ${totalTrades} | Алертів: ${alerts} | Очікує: ${pendingAlerts} | Rate: ${(this.tradeCount / CONFIG.STATS_LOG_INTERVAL).toFixed(0)}/s${oiInfo}`);
    
    this.tradeCount = 0;
    this.lastStatsLog = now;
  }

  reconnectSymbol(symbol) {
    const attempts = this.reconnectAttempts.get(symbol) || 0;
    
    if (attempts >= CONFIG.MAX_RECONNECTS) {
      console.error(`[WS] ${symbol} досягнуто максимум переподключень`);
      return;
    }

    this.reconnectAttempts.set(symbol, attempts + 1);
    
    setTimeout(() => {
      console.log(`[WS] ${symbol} переподключення (${attempts + 1}/${CONFIG.MAX_RECONNECTS})...`);
      this.connectSymbol(symbol);
    }, 5000 * (attempts + 1));
  }

  closeAll() {
    for (const ws of this.connections.values()) {
      ws.close();
    }
    this.connections.clear();
  }
}

// ============================================================================
// MAIN APPLICATION
// ============================================================================

class BinanceFuturesFlowBot {
  constructor() {
    this.telegram = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
    this.tradeAggregator = new TradeAggregator(CONFIG.WINDOW_SECONDS);
    
    const symbols = CONFIG.getEnabledSymbols();
    
    // Ініціалізація OKX OI Tracker якщо увімкнено
    this.oiTracker = null;
    if (CONFIG.OI_ENABLED) {
      this.oiTracker = new OKXOpenInterestTracker(
        symbols,
        CONFIG.OI_WINDOW_SECONDS,
        CONFIG.OI_HISTORY_MINUTES
      );
    }
    
    this.signalEngine = new SignalEngine(this.oiTracker);
    this.cooldownManager = new CooldownManager();
    this.alertManager = new AlertManager(this.telegram, this.oiTracker);
    this.wsManager = null;
  }

  async start() {
    const symbols = CONFIG.getEnabledSymbols();
    
    console.log('='.repeat(70));
    console.log('BINANCE FUTURES AGGRESSIVE FLOW MONITOR (OKX OI Edition)');
    console.log('='.repeat(70));
    console.log(`Символів: ${symbols.length} | Вікно: ${CONFIG.WINDOW_SECONDS}s`);
    console.log(`Open Interest: ${CONFIG.OI_ENABLED ? `✅ OKX WebSocket (вікно ${CONFIG.OI_WINDOW_SECONDS}s)` : '❌ Вимкнено'}`);
    
    if (CONFIG.OI_ENABLED) {
      console.log(`OI Filters: Min OI Δ=${CONFIG.OI_MIN_DELTA_PERCENT}% | Min Price Δ=${CONFIG.OI_MIN_PRICE_CHANGE_PERCENT}%`);
    }
    
    if (CONFIG.TRADING_HOURS_ENABLED) {
      console.log(`Trading Hours: ${CONFIG.TRADING_START_HOUR_UTC}:00-${CONFIG.TRADING_END_HOUR_UTC}:00 UTC`);
      console.log(`Поточний статус: ${CONFIG.isWithinTradingHours() ? '✅ TRADING' : '⏸️ PAUSED'}`);
    } else {
      console.log('Trading Hours: 24/7');
    }
    
    console.log('Налаштування символів:');
    
    symbols.forEach(symbol => {
      const config = CONFIG.getSymbolConfig(symbol);
      console.log(`  ${symbol}: Vol=$${(config.minVolumeUSD / 1e6).toFixed(1)}M | Dom=${config.minDominance}% | Δ=${config.minPriceChange}%`);
    });
    
    console.log('='.repeat(70));
    console.log(`Формат алертів: ${CONFIG.ALERT_FORMAT}`);
    console.log(`Інтеграція торгового бота: ${CONFIG.TRADING_BOT_ENABLED ? 'Увімкнено' : 'Вимкнено'}`);
    console.log('='.repeat(70));

    // Test Telegram
    try {
      const startMessage = symbols.map(s => {
        const c = CONFIG.getSymbolConfig(s);
        return `• ${s}: $${(c.minVolumeUSD / 1e6).toFixed(1)}M | ${c.minDominance}% | ${c.minPriceChange}%`;
      }).join('\n');
      
      let tradingHoursMsg = '';
      if (CONFIG.TRADING_HOURS_ENABLED) {
        tradingHoursMsg = `\n⏰ Години: ${CONFIG.TRADING_START_HOUR_UTC}:00-${CONFIG.TRADING_END_HOUR_UTC}:00 UTC`;
      }
      
      let oiFiltersMsg = '';
      if (CONFIG.OI_ENABLED) {
        oiFiltersMsg = `\n🔧 OI Filters: Min OI Δ=${CONFIG.OI_MIN_DELTA_PERCENT}% | Min Price Δ=${CONFIG.OI_MIN_PRICE_CHANGE_PERCENT}%`;
      }
      
      await this.telegram.sendMessage(
        CONFIG.TELEGRAM_CHAT_ID,
        `🚀 <b>Binance Futures Monitor Запущено (OKX OI)</b>\n\n` +
        `<b>📊 Моніторинг ${symbols.length} символів:</b>\n${startMessage}\n\n` +
        `⚙️ Формат: ${CONFIG.ALERT_FORMAT}\n` +
        `🤖 Торговий бот: ${CONFIG.TRADING_BOT_ENABLED ? 'ON' : 'OFF'}\n` +
        `📊 Open Interest: OKX WebSocket (${CONFIG.OI_WINDOW_SECONDS}s)${oiFiltersMsg}${tradingHoursMsg}`,
        { parse_mode: 'HTML' }
      );
      console.log('[TELEGRAM] ✅ Підключено\n');
    } catch (error) {
      console.error('[TELEGRAM] ❌ Помилка:', error.message);
      process.exit(1);
    }

    // Запуск OKX OI Tracker
    if (this.oiTracker) {
      this.oiTracker.start();
    }

    // Connect WebSockets (Binance)
    this.wsManager = new MultiWebSocketManager(
      symbols,
      this.tradeAggregator,
      this.signalEngine,
      this.cooldownManager,
      this.alertManager,
      this.oiTracker
    );
    
    this.wsManager.connectAll();

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  async shutdown() {
    console.log('\n[SHUTDOWN] Зупинка...');
    
    if (this.oiTracker) {
      this.oiTracker.stop();
    }
    
    if (this.wsManager) {
      this.wsManager.closeAll();
    }
    
    if (this.alertManager) {
      this.alertManager.stop();
    }
    
    await this.telegram.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '⛔ Binance Futures Monitor Зупинено'
    );
    
    process.exit(0);
  }
}

// ============================================================================
// STARTUP
// ============================================================================

if (require.main === module) {
  const bot = new BinanceFuturesFlowBot();
  bot.start().catch(error => {
    console.error('[FATAL]', error);
    process.exit(1);
  });
}

module.exports = { BinanceFuturesFlowBot };
