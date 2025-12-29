// ============================================
// MULTI-ASSET TRADING SIMULATOR v3.3 - RESUME LAST PRICE
// ============================================
// ✅ NEW: Resume from last price instead of restart

import admin from 'firebase-admin';
import axios from 'axios';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();
process.env.TZ = 'Asia/Jakarta';

// ============================================
// LOGGER
// ============================================
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} - ${level.toUpperCase()} - ${message}`;
    })
  ),
  transports: [
    new transports.File({ 
      filename: 'simulator.log',
      maxsize: 5242880,
      maxFiles: 3
    }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message }) => {
          return `${timestamp} - ${level} - ${message}`;
        })
      )
    })
  ]
});

// ============================================
// TIMEZONE UTILITY
// ============================================
class TimezoneUtil {
  static getCurrentTimestamp() {
    return Math.floor(Date.now() / 1000);
  }

  static formatDateTime(date = new Date()) {
    const jakartaDate = new Date(date.toLocaleString('en-US', { 
      timeZone: 'Asia/Jakarta' 
    }));
    
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
// FIREBASE MANAGER - IMPROVED
// ============================================
class FirebaseManager {
  constructor() {
    this.db = null;
    this.realtimeDb = null;
    this.restClient = null;
    this.writeQueue = [];
    this.isProcessingQueue = false;
    this.writeStats = { success: 0, failed: 0 };
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
      this.realtimeDb = admin.database();

      const baseURL = process.env.FIREBASE_REALTIME_DB_URL.replace(/\/$/, '');
      this.restClient = axios.create({
        baseURL,
        timeout: 10000,
        headers: { 
          'Content-Type': 'application/json',
          'Connection': 'keep-alive'
        },
        maxRedirects: 0,
        validateStatus: (status) => status >= 200 && status < 300
      });

      logger.info('✅ Firebase initialized successfully');
      logger.info(`   Database URL: ${baseURL}`);
      
      this.startQueueProcessor();
      
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
          assets.push({
            id: doc.id,
            ...data
          });
        }
      });

      return assets;
    } catch (error) {
      logger.error(`Error fetching assets: ${error.message}`);
      return [];
    }
  }

  // ✅ NEW: Get last price from Firebase
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

  async setRealtimeValue(path, data, retries = 3) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.restClient.put(`${path}.json`, data);
        this.writeStats.success++;
        
        if (attempt > 0) {
          logger.debug(`✅ Write succeeded on retry ${attempt}: ${path}`);
        }
        
        return true;
      } catch (error) {
        if (attempt < retries - 1) {
          const delay = 500 * (attempt + 1);
          logger.warn(`⚠️ Write failed (attempt ${attempt + 1}/${retries}): ${path}, retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error(`❌ Write failed after ${retries} attempts: ${path}`);
          logger.error(`   Error: ${error.message}`);
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
      
      const batch = this.writeQueue.splice(0, 5);
      
      await Promise.allSettled(
        batch.map(({ path, data }) => this.setRealtimeValue(path, data, 2))
      );
      
      this.isProcessingQueue = false;
    }, 100);
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
// TIMEFRAME MANAGER
// ============================================
class TimeframeManager {
  constructor() {
    this.timeframes = {
      '1s': 1,
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '4h': 14400,
      '1d': 86400
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
      
      this.bars[tf].volume += Math.floor(1000 + Math.random() * 49000);
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
// ASSET SIMULATOR - WITH RESUME SUPPORT
// ============================================
class AssetSimulator {
  constructor(asset, firebaseManager) {
    this.asset = asset;
    this.firebase = firebaseManager;
    this.tfManager = new TimeframeManager();

    const settings = asset.simulatorSettings || {};
    
    this.initialPrice = settings.initialPrice || 40.022;
    this.currentPrice = this.initialPrice; // Will be updated in loadLastPrice
    this.volatilityMin = settings.secondVolatilityMin || 0.00001;
    this.volatilityMax = settings.secondVolatilityMax || 0.00008;
    this.minPrice = settings.minPrice || (this.initialPrice * 0.5);
    this.maxPrice = settings.maxPrice || (this.initialPrice * 2.0);
    
    this.lastDirection = 1;
    this.iteration = 0;
    this.lastLogTime = 0;

    // ✅ NEW: Track if resumed from last price
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
    logger.info(`   Price Range: ${this.minPrice} - ${this.maxPrice}`);
    logger.info(`   Path: ${this.realtimeDbPath}`);
  }

  // ✅ NEW: Load last price from Firebase
  async loadLastPrice() {
    try {
      logger.info(`🔍 [${this.asset.symbol}] Checking for last price...`);
      
      const lastPriceData = await this.firebase.getLastPrice(this.realtimeDbPath);
      
      if (lastPriceData && lastPriceData.price) {
        // Validate price is within bounds
        const price = lastPriceData.price;
        
        if (price >= this.minPrice && price <= this.maxPrice) {
          this.currentPrice = price;
          this.lastPriceData = lastPriceData;
          this.isResumed = true;
          
          const timeDiff = TimezoneUtil.getCurrentTimestamp() - (lastPriceData.timestamp || 0);
          
          logger.info(`🔄 [${this.asset.symbol}] RESUMED from last price`);
          logger.info(`   Last Price: ${price.toFixed(6)}`);
          logger.info(`   Last Update: ${lastPriceData.datetime}`);
          logger.info(`   Time Gap: ${timeDiff} seconds ago`);
          logger.info(`   Change from Initial: ${((price - this.initialPrice) / this.initialPrice * 100).toFixed(2)}%`);
          
          return true;
        } else {
          logger.warn(`⚠️ [${this.asset.symbol}] Last price ${price} out of bounds [${this.minPrice}, ${this.maxPrice}]`);
          logger.info(`   Using initial price instead: ${this.initialPrice}`);
        }
      } else {
        logger.info(`ℹ️ [${this.asset.symbol}] No previous price found, starting fresh`);
        logger.info(`   Starting Price: ${this.initialPrice}`);
      }
      
      return false;
    } catch (error) {
      logger.warn(`⚠️ [${this.asset.symbol}] Could not load last price: ${error.message}`);
      logger.info(`   Using initial price: ${this.initialPrice}`);
      return false;
    }
  }

  generatePriceMovement() {
    const volatility = this.volatilityMin + 
      Math.random() * (this.volatilityMax - this.volatilityMin);
    
    let direction = Math.random() < 0.5 ? -1 : 1;
    if (Math.random() < 0.7) {
      direction = this.lastDirection;
    }
    this.lastDirection = direction;
    
    const priceChange = this.currentPrice * volatility * direction;
    let newPrice = this.currentPrice + priceChange;
    
    // Keep price within bounds
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

      // Save current price
      const currentPriceData = {
        price: parseFloat(newPrice.toFixed(6)),
        timestamp: timestamp,
        datetime: dateTimeInfo.datetime,
        datetime_iso: dateTimeInfo.datetime_iso,
        timezone: 'Asia/Jakarta',
        change: parseFloat(((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)),
        // ✅ NEW: Add resume info
        isResumed: this.isResumed,
        lastResumeTime: this.isResumed && this.lastPriceData ? this.lastPriceData.datetime : null,
      };
      
      const writePromises = [];
      
      // Current price - synchronous (most critical)
      writePromises.push(
        this.firebase.setRealtimeValue(
          `${this.realtimeDbPath}/current_price`,
          currentPriceData
        )
      );

      // OHLC bars - async
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
        
        this.firebase.setRealtimeValueAsync(
          `${this.realtimeDbPath}/ohlc_${tf}/${bar.timestamp}`,
          barData
        );
      }

      await Promise.race([
        Promise.all(writePromises),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Write timeout')), 8000)
        )
      ]);

      this.currentPrice = newPrice;
      this.iteration++;

      // Log every 10 seconds
      const now = Date.now();
      if (now - this.lastLogTime > 10000) {
        const stats = this.firebase.getStats();
        const resumeStatus = this.isResumed ? '🔄 RESUMED' : '🆕 FRESH';
        logger.info(`[${this.asset.symbol}] ${resumeStatus} | Iteration ${this.iteration}: ${newPrice.toFixed(6)} (${((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)}%) | Write: ${stats.successRate}%`);
        this.lastLogTime = now;
      }

      // Log completed bars
      if (Object.keys(completedBars).length > 0) {
        const completedTfs = Object.keys(completedBars).join(', ');
        logger.debug(`[${this.asset.symbol}] Completed: ${completedTfs}`);
      }

    } catch (error) {
      logger.error(`[${this.asset.symbol}] Update error: ${error.message}`);
      logger.error(`   Current price preserved: ${this.currentPrice.toFixed(6)}`);
      logger.error(`   Will retry on next update...`);
    }
  }

  updateSettings(newAsset) {
    const settings = newAsset.simulatorSettings || {};
    
    const oldSettings = JSON.stringify({
      volatilityMin: this.volatilityMin,
      volatilityMax: this.volatilityMax,
      minPrice: this.minPrice,
      maxPrice: this.maxPrice
    });

    this.volatilityMin = settings.secondVolatilityMin || this.volatilityMin;
    this.volatilityMax = settings.secondVolatilityMax || this.volatilityMax;
    this.minPrice = settings.minPrice || this.minPrice;
    this.maxPrice = settings.maxPrice || this.maxPrice;

    const newSettings = JSON.stringify({
      volatilityMin: this.volatilityMin,
      volatilityMax: this.volatilityMax,
      minPrice: this.minPrice,
      maxPrice: this.maxPrice
    });

    if (oldSettings !== newSettings) {
      logger.info(`🔄 [${this.asset.symbol}] Settings updated`);
      logger.info(`   Volatility: ${this.volatilityMin} - ${this.volatilityMax}`);
      logger.info(`   Price Range: ${this.minPrice} - ${this.maxPrice}`);
    }

    this.asset = newAsset;
  }
}

// ============================================
// MULTI-ASSET MANAGER
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
    
    // ✅ NEW: Load last prices for all assets
    for (const asset of assets) {
      const simulator = new AssetSimulator(asset, this.firebase);
      
      // Try to resume from last price
      await simulator.loadLastPrice();
      
      this.simulators.set(asset.id, simulator);
    }

    logger.info(`✅ ${this.simulators.size} simulators initialized`);
    
    // ✅ NEW: Show resume summary
    const resumedCount = Array.from(this.simulators.values())
      .filter(s => s.isResumed).length;
    const freshCount = this.simulators.size - resumedCount;
    
    logger.info('');
    logger.info('📊 Resume Summary:');
    logger.info(`   🔄 Resumed: ${resumedCount} assets`);
    logger.info(`   🆕 Fresh Start: ${freshCount} assets`);
    logger.info('');
  }

  async refreshAssets() {
    try {
      const assets = await this.firebase.getAssets();
      const currentIds = new Set(this.simulators.keys());
      const newIds = new Set(assets.map(a => a.id));

      // Remove deleted assets
      for (const id of currentIds) {
        if (!newIds.has(id)) {
          const simulator = this.simulators.get(id);
          logger.info(`🗑️ Removing simulator for ${simulator.asset.symbol}`);
          this.simulators.delete(id);
        }
      }

      // Add new assets
      for (const asset of assets) {
        if (!currentIds.has(asset.id)) {
          logger.info(`➕ Adding simulator for ${asset.symbol}`);
          const simulator = new AssetSimulator(asset, this.firebase);
          
          // ✅ NEW: Try to resume new asset
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
    if (this.simulators.size === 0) {
      return;
    }

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

    const currentTime = TimezoneUtil.formatDateTime();
    logger.info('');
    logger.info('🚀 ================================================');
    logger.info('🚀 MULTI-ASSET SIMULATOR v3.3 STARTED');
    logger.info('🚀 ✅ WITH RESUME LAST PRICE SUPPORT');
    logger.info('🚀 ================================================');
    logger.info(`🌐 Timezone: Asia/Jakarta (WIB = UTC+7)`);
    logger.info(`⏰ Current Time: ${currentTime}`);
    logger.info(`📊 Active Assets: ${this.simulators.size}`);
    logger.info('⏱️ Update Interval: 1 second');
    logger.info('🔄 Settings Refresh: Every 60 seconds');
    logger.info('🚀 ================================================');
    logger.info('');

    for (const simulator of this.simulators.values()) {
      const status = simulator.isResumed ? '🔄 RESUMED' : '🆕 FRESH';
      const price = simulator.currentPrice.toFixed(6);
      logger.info(`   ${status} 📈 ${simulator.asset.symbol} - ${simulator.asset.name} @ ${price}`);
    }
    logger.info('');

    // Price updates
    this.updateInterval = setInterval(async () => {
      await this.updateAllPrices();
    }, parseInt(process.env.UPDATE_INTERVAL_MS || 1000));

    // Settings refresh
    this.settingsRefreshInterval = setInterval(async () => {
      await this.refreshAssets();
    }, parseInt(process.env.SETTINGS_REFRESH_INTERVAL_MS || 60000));

    // Stats logging
    this.statsInterval = setInterval(() => {
      const stats = this.firebase.getStats();
      logger.info(`📊 Write Stats: Success: ${stats.success}, Failed: ${stats.failed}, Queue: ${stats.queueSize}, Rate: ${stats.successRate}%`);
    }, 30000);

    logger.info('✅ All simulators running!');
    logger.info('💡 Prices will resume from last saved values on restart');
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
    logger.info('💾 Last Prices Saved:');
    for (const simulator of this.simulators.values()) {
      const tfStats = simulator.tfManager.getStatistics();
      logger.info(`   ${simulator.asset.symbol}: ${simulator.currentPrice.toFixed(6)} (${simulator.iteration} iterations)`);
      logger.info(`      Bars Created: ${JSON.stringify(tfStats.barsCreated)}`);
    }

    logger.info('');
    logger.info('✅ Multi-Asset Manager stopped gracefully');
    logger.info('💡 Prices saved - will resume from these values on next start');
    
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
  console.log('🌐 TIMEZONE CONFIGURATION');
  console.log('🌐 ================================================');
  console.log(`🌐 Process TZ: ${process.env.TZ}`);
  console.log(`🌐 Current Time (WIB): ${TimezoneUtil.formatDateTime()}`);
  console.log(`🌐 Current Time (ISO): ${TimezoneUtil.toISOString()}`);
  console.log(`🌐 Unix Timestamp: ${TimezoneUtil.getCurrentTimestamp()}`);
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
      logger.error(error.stack);
      manager.stop();
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
      manager.stop();
    });

    await manager.start();
    
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

main();