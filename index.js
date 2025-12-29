// ============================================
// OPTIMIZED SIMULATOR v4.0 - FIXED BILLING ISSUE
// ============================================
// ✅ Auto-cleanup old data
// ✅ Reduced OHLC timeframes
// ✅ Batched writes
// ✅ Retention policy

import admin from 'firebase-admin';
import axios from 'axios';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();
process.env.TZ = 'Asia/Jakarta';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} - ${level.toUpperCase()} - ${message}`;
    })
  ),
  transports: [
    new transports.File({ filename: 'simulator.log', maxsize: 5242880, maxFiles: 2 }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message }) => `${timestamp} - ${level} - ${message}`)
      )
    })
  ]
});

class TimezoneUtil {
  static getCurrentTimestamp() {
    return Math.floor(Date.now() / 1000);
  }

  static formatDateTime(date = new Date()) {
    const jakartaDate = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const year = jakartaDate.getFullYear();
    const month = String(jakartaDate.getMonth() + 1).padStart(2, '0');
    const day = String(jakartaDate.getDate()).padStart(2, '0');
    const hours = String(jakartaDate.getHours()).padStart(2, '0');
    const minutes = String(jakartaDate.getMinutes()).padStart(2, '0');
    const seconds = String(jakartaDate.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  static toISOString(date = new Date()) {
    return date.toISOString();
  }

  static getDateTimeInfo(date = new Date()) {
    return {
      datetime: this.formatDateTime(date),
      datetime_iso: this.toISOString(date),
      timestamp: Math.floor(date.getTime() / 1000),
      timezone: 'Asia/Jakarta'
    };
  }
}

// ============================================
// FIREBASE MANAGER - OPTIMIZED
// ============================================
class FirebaseManager {
  constructor() {
    this.db = null;
    this.restClient = null;
    this.writeQueue = [];
    this.isProcessingQueue = false;
    this.writeStats = { success: 0, failed: 0 };
    
    // ✅ CLEANUP CONFIG
    this.RETENTION_DAYS = 7; // Keep only 7 days of data
    this.lastCleanupTime = 0;
    this.CLEANUP_INTERVAL = 3600000; // Cleanup every 1 hour
  }

  async initialize() {
    try {
      const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      };

      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          databaseURL: process.env.FIREBASE_REALTIME_DB_URL,
        });
      }

      this.db = admin.firestore();

      const baseURL = process.env.FIREBASE_REALTIME_DB_URL.replace(/\/$/, '');
      this.restClient = axios.create({
        baseURL,
        timeout: 5000,
        headers: { 'Content-Type': 'application/json', 'Connection': 'keep-alive' },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 300
      });

      logger.info('✅ Firebase initialized successfully');
      
      this.startQueueProcessor();
      this.startCleanupScheduler(); // ✅ NEW
      
      return true;
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      throw error;
    }
  }

  async getAssets() {
    try {
      const snapshot = await this.db.collection('assets')
        .where('isActive', '==', true)
        .get();

      const assets = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.dataSource === 'realtime_db' || data.dataSource === 'mock') {
          assets.push({ id: doc.id, ...data });
        }
      });

      return assets;
    } catch (error) {
      logger.error(`Error fetching assets: ${error.message}`);
      return [];
    }
  }

  async getLastPrice(path) {
    try {
      const response = await this.restClient.get(`${path}/current_price.json`);
      
      if (response.data && response.data.price) {
        return {
          price: parseFloat(response.data.price),
          timestamp: response.data.timestamp || TimezoneUtil.getCurrentTimestamp(),
          datetime: response.data.datetime || TimezoneUtil.formatDateTime()
        };
      }
      
      return null;
    } catch (error) {
      logger.debug(`No last price found at ${path}: ${error.message}`);
      return null;
    }
  }

  async setRealtimeValue(path, data, retries = 2) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.restClient.put(`${path}.json`, data);
        this.writeStats.success++;
        return true;
      } catch (error) {
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        } else {
          this.writeStats.failed++;
          return false;
        }
      }
    }
    return false;
  }

  async setRealtimeValueAsync(path, data) {
    this.writeQueue.push({ path, data });
  }

  async startQueueProcessor() {
    setInterval(async () => {
      if (this.isProcessingQueue || this.writeQueue.length === 0) return;
      
      this.isProcessingQueue = true;
      const batch = this.writeQueue.splice(0, 10);
      
      await Promise.allSettled(
        batch.map(({ path, data }) => this.setRealtimeValue(path, data, 1))
      );
      
      this.isProcessingQueue = false;
    }, 200);
  }

  // ✅ NEW: AUTO CLEANUP OLD DATA
  async startCleanupScheduler() {
    setInterval(async () => {
      const now = Date.now();
      
      if (now - this.lastCleanupTime < this.CLEANUP_INTERVAL) {
        return;
      }

      logger.info('🗑️ Starting automatic cleanup...');
      
      const cutoffTimestamp = TimezoneUtil.getCurrentTimestamp() - (this.RETENTION_DAYS * 86400);
      
      try {
        const assets = await this.getAssets();
        
        for (const asset of assets) {
          const path = asset.dataSource === 'realtime_db' 
            ? asset.realtimeDbPath 
            : `/mock/${asset.symbol.toLowerCase()}`;
          
          // ✅ Cleanup old OHLC data
          const timeframes = ['1m', '5m', '15m', '1h'];
          
          for (const tf of timeframes) {
            try {
              const response = await this.restClient.get(`${path}/ohlc_${tf}.json`);
              
              if (response.data) {
                const oldKeys = Object.keys(response.data).filter(timestamp => {
                  return parseInt(timestamp) < cutoffTimestamp;
                });

                if (oldKeys.length > 0) {
                  logger.info(`  🗑️ Deleting ${oldKeys.length} old ${tf} bars for ${asset.symbol}`);
                  
                  // Delete in batches
                  for (const key of oldKeys) {
                    await this.restClient.delete(`${path}/ohlc_${tf}/${key}.json`);
                  }
                }
              }
            } catch (error) {
              logger.debug(`No ${tf} data to cleanup for ${asset.symbol}`);
            }
          }
        }

        this.lastCleanupTime = now;
        logger.info('✅ Cleanup completed successfully');
        
      } catch (error) {
        logger.error(`❌ Cleanup error: ${error.message}`);
      }
    }, this.CLEANUP_INTERVAL);
  }

  getStats() {
    return {
      success: this.writeStats.success,
      failed: this.writeStats.failed,
      queueSize: this.writeQueue.length,
      successRate: this.writeStats.success > 0 
        ? Math.round((this.writeStats.success / (this.writeStats.success + this.writeStats.failed)) * 100)
        : 0
    };
  }
}

// ============================================
// TIMEFRAME MANAGER - OPTIMIZED (REDUCED TIMEFRAMES)
// ============================================
class TimeframeManager {
  constructor() {
    // ✅ REDUCED: Only keep essential timeframes
    this.timeframes = {
      '1m': 60,    // Keep for 1-min trading
      '5m': 300,   // Keep for 5-min charts
      '15m': 900,  // Keep for 15-min charts
      '1h': 3600,  // Keep for hourly analysis
      // ❌ REMOVED: '1s', '4h', '1d' to reduce writes
    };

    this.bars = {};
    this.barsCreated = {};
    
    Object.keys(this.timeframes).forEach(tf => {
      this.bars[tf] = null;
      this.barsCreated[tf] = 0;
    });
  }

  getBarTimestamp(timestamp, timeframeSeconds) {
    return Math.floor(timestamp / timeframeSeconds) * timeframeSeconds;
  }

  updateOHLC(timestamp, price) {
    const completedBars = {};
    const currentBars = {};

    Object.entries(this.timeframes).forEach(([tf, seconds]) => {
      const barTimestamp = this.getBarTimestamp(timestamp, seconds);

      if (!this.bars[tf] || this.bars[tf].timestamp !== barTimestamp) {
        if (this.bars[tf]) {
          completedBars[tf] = {
            ...this.bars[tf],
            isCompleted: true
          };
          this.barsCreated[tf]++;
        }

        this.bars[tf] = {
          timestamp: barTimestamp,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
          isCompleted: false
        };
      } else {
        this.bars[tf].high = Math.max(this.bars[tf].high, price);
        this.bars[tf].low = Math.min(this.bars[tf].low, price);
        this.bars[tf].close = price;
      }
      
      this.bars[tf].volume += Math.floor(1000 + Math.random() * 9000);
      currentBars[tf] = { ...this.bars[tf] };
    });

    return { completedBars, currentBars };
  }

  reset() {
    Object.keys(this.timeframes).forEach(tf => {
      this.bars[tf] = null;
    });
  }

  getStatistics() {
    return {
      timeframes: Object.keys(this.timeframes),
      barsCreated: this.barsCreated,
      currentBars: Object.keys(this.bars).filter(tf => this.bars[tf] !== null)
    };
  }
}

// ============================================
// ASSET SIMULATOR - OPTIMIZED
// ============================================
class AssetSimulator {
  constructor(asset, firebaseManager) {
    this.asset = asset;
    this.firebase = firebaseManager;
    this.tfManager = new TimeframeManager();

    const settings = asset.simulatorSettings || {};
    
    this.initialPrice = settings.initialPrice || 40.022;
    this.currentPrice = this.initialPrice;
    this.volatilityMin = settings.secondVolatilityMin || 0.00001;
    this.volatilityMax = settings.secondVolatilityMax || 0.00008;
    this.minPrice = settings.minPrice || (this.initialPrice * 0.5);
    this.maxPrice = settings.maxPrice || (this.initialPrice * 2.0);
    
    this.lastDirection = 1;
    this.iteration = 0;
    this.lastLogTime = 0;
    this.isResumed = false;
    this.lastPriceData = null;

    if (asset.dataSource === 'realtime_db') {
      this.realtimeDbPath = asset.realtimeDbPath;
    } else {
      this.realtimeDbPath = `/mock/${asset.symbol.toLowerCase()}`;
    }

    logger.info(`✅ Simulator initialized for ${asset.symbol}`);
    logger.info(`   Initial Price: ${this.initialPrice}`);
    logger.info(`   Volatility: ${this.volatilityMin} - ${this.volatilityMax}`);
    logger.info(`   Path: ${this.realtimeDbPath}`);
  }

  async loadLastPrice() {
    try {
      logger.info(`🔍 [${this.asset.symbol}] Checking for last price...`);
      
      const lastPriceData = await this.firebase.getLastPrice(this.realtimeDbPath);
      
      if (lastPriceData && lastPriceData.price) {
        const price = lastPriceData.price;
        
        if (price >= this.minPrice && price <= this.maxPrice) {
          this.currentPrice = price;
          this.lastPriceData = lastPriceData;
          this.isResumed = true;
          
          logger.info(`🔄 [${this.asset.symbol}] RESUMED from last price: ${price.toFixed(6)}`);
          return true;
        }
      }
      
      logger.info(`ℹ️ [${this.asset.symbol}] Starting fresh at ${this.initialPrice}`);
      return false;
    } catch (error) {
      logger.warn(`⚠️ [${this.asset.symbol}] Could not load last price: ${error.message}`);
      return false;
    }
  }

  generatePriceMovement() {
    const volatility = this.volatilityMin + Math.random() * (this.volatilityMax - this.volatilityMin);
    
    let direction = Math.random() < 0.5 ? -1 : 1;
    if (Math.random() < 0.7) {
      direction = this.lastDirection;
    }
    this.lastDirection = direction;
    
    const priceChange = this.currentPrice * volatility * direction;
    let newPrice = this.currentPrice + priceChange;
    
    if (newPrice < this.minPrice) newPrice = this.minPrice;
    if (newPrice > this.maxPrice) newPrice = this.maxPrice;
    
    return newPrice;
  }

  async updatePrice() {
    try {
      const timestamp = TimezoneUtil.getCurrentTimestamp();
      const newPrice = this.generatePriceMovement();
      
      const { completedBars, currentBars } = this.tfManager.updateOHLC(timestamp, newPrice);
      
      const date = new Date(timestamp * 1000);
      const dateTimeInfo = TimezoneUtil.getDateTimeInfo(date);

      // ✅ OPTIMIZED: Save current price (most critical)
      const currentPriceData = {
        price: parseFloat(newPrice.toFixed(6)),
        timestamp: timestamp,
        datetime: dateTimeInfo.datetime,
        datetime_iso: dateTimeInfo.datetime_iso,
        timezone: 'Asia/Jakarta',
        change: parseFloat(((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)),
      };
      
      // ✅ Write current price (synchronous - most important)
      await this.firebase.setRealtimeValue(
        `${this.realtimeDbPath}/current_price`,
        currentPriceData
      );

      // ✅ OPTIMIZED: Only save completed OHLC bars (async)
      for (const [tf, bar] of Object.entries(completedBars)) {
        const barDate = new Date(bar.timestamp * 1000);
        const barDateTime = TimezoneUtil.getDateTimeInfo(barDate);
        
        const barData = {
          timestamp: bar.timestamp,
          datetime: barDateTime.datetime,
          datetime_iso: barDateTime.datetime_iso,
          timezone: 'Asia/Jakarta',
          open: parseFloat(bar.open.toFixed(6)),
          high: parseFloat(bar.high.toFixed(6)),
          low: parseFloat(bar.low.toFixed(6)),
          close: parseFloat(bar.close.toFixed(6)),
          volume: bar.volume,
          isCompleted: true
        };
        
        // Async write to queue
        this.firebase.setRealtimeValueAsync(
          `${this.realtimeDbPath}/ohlc_${tf}/${bar.timestamp}`,
          barData
        );
      }

      this.currentPrice = newPrice;
      this.iteration++;

      // Log every 30 seconds (reduced from 10)
      const now = Date.now();
      if (now - this.lastLogTime > 30000) {
        const stats = this.firebase.getStats();
        logger.info(`[${this.asset.symbol}] ${this.isResumed ? '🔄 RESUMED' : '🆕 FRESH'} | Iter ${this.iteration}: ${newPrice.toFixed(6)} (${((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)}%) | Writes: ${stats.successRate}%`);
        this.lastLogTime = now;
      }

    } catch (error) {
      logger.error(`[${this.asset.symbol}] Update error: ${error.message}`);
    }
  }

  updateSettings(newAsset) {
    const settings = newAsset.simulatorSettings || {};
    
    this.volatilityMin = settings.secondVolatilityMin || this.volatilityMin;
    this.volatilityMax = settings.secondVolatilityMax || this.volatilityMax;
    this.minPrice = settings.minPrice || this.minPrice;
    this.maxPrice = settings.maxPrice || this.maxPrice;

    this.asset = newAsset;
  }
}

// ============================================
// MULTI-ASSET MANAGER - OPTIMIZED
// ============================================
class MultiAssetManager {
  constructor(firebaseManager) {
    this.firebase = firebaseManager;
    this.simulators = new Map();
    this.updateInterval = null;
    this.settingsRefreshInterval = null;
    this.statsInterval = null;
    this.isRunning = false;
  }

  async initialize() {
    logger.info('🎯 Initializing Multi-Asset Manager...');
    
    const assets = await this.firebase.getAssets();
    
    if (assets.length === 0) {
      logger.warn('⚠️ No active assets found. Waiting...');
      return;
    }

    logger.info(`📊 Found ${assets.length} active assets`);
    
    for (const asset of assets) {
      const simulator = new AssetSimulator(asset, this.firebase);
      await simulator.loadLastPrice();
      this.simulators.set(asset.id, simulator);
    }

    logger.info(`✅ ${this.simulators.size} simulators initialized`);
  }

  async refreshAssets() {
    try {
      const assets = await this.firebase.getAssets();
      const currentIds = new Set(this.simulators.keys());
      const newIds = new Set(assets.map(a => a.id));

      for (const id of currentIds) {
        if (!newIds.has(id)) {
          const simulator = this.simulators.get(id);
          logger.info(`🗑️ Removing simulator for ${simulator.asset.symbol}`);
          this.simulators.delete(id);
        }
      }

      for (const asset of assets) {
        if (!currentIds.has(asset.id)) {
          logger.info(`➕ Adding simulator for ${asset.symbol}`);
          const simulator = new AssetSimulator(asset, this.firebase);
          await simulator.loadLastPrice();
          this.simulators.set(asset.id, simulator);
        } else {
          const simulator = this.simulators.get(asset.id);
          simulator.updateSettings(asset);
        }
      }

      logger.debug(`🔄 Assets refreshed: ${this.simulators.size} active`);
    } catch (error) {
      logger.error(`Error refreshing assets: ${error.message}`);
    }
  }

  async updateAllPrices() {
    if (this.simulators.size === 0) return;

    const promises = [];
    for (const simulator of this.simulators.values()) {
      promises.push(simulator.updatePrice());
    }

    await Promise.allSettled(promises);
  }

  async start() {
    if (this.isRunning) {
      logger.warn('⚠️ Manager already running');
      return;
    }

    await this.initialize();

    if (this.simulators.size === 0) {
      logger.warn('⚠️ No simulators to start. Will retry in 10 seconds...');
      setTimeout(() => this.start(), 10000);
      return;
    }

    this.isRunning = true;

    logger.info('');
    logger.info('🚀 ================================================');
    logger.info('🚀 OPTIMIZED SIMULATOR v4.0 STARTED');
    logger.info('🚀 ✅ AUTO CLEANUP ENABLED');
    logger.info('🚀 ✅ REDUCED WRITES (4 timeframes only)');
    logger.info('🚀 ✅ 7-DAY DATA RETENTION');
    logger.info('🚀 ================================================');
    logger.info(`🌐 Timezone: Asia/Jakarta (WIB = UTC+7)`);
    logger.info(`⏰ Current Time: ${TimezoneUtil.formatDateTime()}`);
    logger.info(`📊 Active Assets: ${this.simulators.size}`);
    logger.info('⏱️ Update Interval: 1 second');
    logger.info('🗑️ Cleanup: Every 1 hour (keeps 7 days)');
    logger.info('🚀 ================================================');
    logger.info('');

    // ✅ Price updates every 1 second (unchanged)
    this.updateInterval = setInterval(async () => {
      await this.updateAllPrices();
    }, 1000);

    // ✅ Settings refresh every 2 minutes (reduced from 1 minute)
    this.settingsRefreshInterval = setInterval(async () => {
      await this.refreshAssets();
    }, 120000);

    // ✅ Stats logging every 60 seconds (reduced from 30)
    this.statsInterval = setInterval(() => {
      const stats = this.firebase.getStats();
      logger.info(`📊 Write Stats: Success: ${stats.success}, Failed: ${stats.failed}, Queue: ${stats.queueSize}, Rate: ${stats.successRate}%`);
    }, 60000);

    logger.info('✅ All simulators running with optimizations!');
    logger.info('💡 Old data auto-cleanup every hour');
    logger.info('Press Ctrl+C to stop');
    logger.info('');
  }

  async stop() {
    if (!this.isRunning) return;

    logger.info('');
    logger.info('⏹️ Stopping Multi-Asset Manager...');
    
    this.isRunning = false;

    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }

    if (this.settingsRefreshInterval) {
      clearInterval(this.settingsRefreshInterval);
      this.settingsRefreshInterval = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    logger.info('📊 Final Statistics:');
    const stats = this.firebase.getStats();
    logger.info(`   Write Stats: Success: ${stats.success}, Failed: ${stats.failed}, Success Rate: ${stats.successRate}%`);
    
    logger.info('');
    logger.info('✅ Multi-Asset Manager stopped gracefully');
    
    setTimeout(() => {
      process.exit(0);
    }, 500);
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('');
  console.log('🌐 ================================================');
  console.log('🌐 OPTIMIZED SIMULATOR v4.0');
  console.log('🌐 ================================================');
  console.log(`🌐 Process TZ: ${process.env.TZ}`);
  console.log(`🌐 Current Time (WIB): ${TimezoneUtil.formatDateTime()}`);
  console.log('🌐 ================================================');
  console.log('');

  try {
    const firebaseManager = new FirebaseManager();
    await firebaseManager.initialize();

    const manager = new MultiAssetManager(firebaseManager);
    
    process.on('SIGINT', () => manager.stop());
    process.on('SIGTERM', () => manager.stop());
    process.on('SIGUSR2', () => manager.stop());
    
    process.on('uncaughtException', (error) => {
      logger.error(`Uncaught Exception: ${error.message}`);
      manager.stop();
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error(`Unhandled Rejection: ${reason}`);
      manager.stop();
    });

    await manager.start();
    
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    process.exit(1);
  }
}

main();