// ============================================
// MULTI-ASSET SIMULATOR v7.1 - FIXED LOGGING
// ============================================
// ✅ Log rotation & cleanup
// ✅ Stuck detection & auto-restart
// ✅ Reduced log verbosity in production
// ✅ Memory optimized

import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();
process.env.TZ = 'Asia/Jakarta';

// ============================================
// IMPROVED LOGGER - WITH ROTATION
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
    // ✅ File transport with rotation
    new transports.File({ 
      filename: 'logs/simulator.log',
      maxsize: 2097152, // 2MB per file
      maxFiles: 3,      // Keep only 3 files
      tailable: true,
      options: { flags: 'a' }
    }),
    // ✅ Console transport (only important logs)
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message }) => `${timestamp} - ${level} - ${message}`)
      ),
      level: 'info'
    })
  ]
});

// ============================================
// HEALTH CHECK - Detect if stuck
// ============================================
let lastHealthCheck = Date.now();
let priceUpdateCount = 0;
let lastPriceUpdateCount = 0;
let consecutiveStuckChecks = 0;

setInterval(() => {
  const now = Date.now();
  const timeSinceUpdate = now - lastHealthCheck;
  
  // Check if price updates have stopped
  if (priceUpdateCount === lastPriceUpdateCount) {
    consecutiveStuckChecks++;
    
    if (consecutiveStuckChecks >= 2) {
      // Stuck for 60 seconds (2 x 30s checks)
      logger.error('❌ STUCK DETECTED - No price updates in 60 seconds!');
      logger.error(`📊 Total updates before stuck: ${priceUpdateCount}`);
      logger.error('💀 Forcing restart via PM2...');
      
      // Force exit - PM2 will restart
      process.exit(1);
    } else {
      logger.warn(`⚠️  Warning: No updates for ${timeSinceUpdate / 1000}s (Check ${consecutiveStuckChecks}/2)`);
    }
  } else {
    // Updates are happening, reset counter
    consecutiveStuckChecks = 0;
  }
  
  lastPriceUpdateCount = priceUpdateCount;
  lastHealthCheck = now;
}, 30000); // Check every 30 seconds

// ============================================
// TIMEZONE UTILITY
// ============================================
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
// FIREBASE MANAGER
// ============================================
class FirebaseManager {
  constructor() {
    this.db = null;
    this.realtimeDbAdmin = null;
    this.writeQueue = [];
    this.isProcessingQueue = false;
    this.writeStats = { success: 0, failed: 0 };
    
    this.RETENTION_DAYS = 7;
    this.lastCleanupTime = 0;
    this.CLEANUP_INTERVAL = 3600000; // 1 hour
    
    this.firestoreReadCount = 0;
    this.lastReadReset = Date.now();
    
    this._lastAssetCount = 0; // Track asset count changes
  }

  async initialize() {
    try {
      const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      };

      if (!serviceAccount.projectId || !serviceAccount.privateKey || !serviceAccount.clientEmail) {
        throw new Error('Firebase credentials incomplete in .env');
      }

      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          databaseURL: process.env.FIREBASE_REALTIME_DB_URL,
        });
      }

      this.db = admin.firestore();
      this.realtimeDbAdmin = admin.database();
      
      logger.info('✅ Firebase Admin SDK initialized (v7.1)');
      logger.info('✅ Firestore connected');
      logger.info('✅ Realtime DB connected');
      logger.info('🛡️  Stuck detection: Active');
      logger.info('📝 Log rotation: 2MB x 3 files');
      
      this.startQueueProcessor();
      this.startCleanupScheduler();
      
      return true;
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      throw error;
    }
  }

  async getAssets() {
    try {
      this.firestoreReadCount++;
      
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

      // ✅ Only log if asset count changes
      if (assets.length !== this._lastAssetCount) {
        logger.info(`📊 Active assets: ${assets.length} (Firestore read #${this.firestoreReadCount})`);
        this._lastAssetCount = assets.length;
      }

      return assets;
    } catch (error) {
      logger.error(`Error fetching assets: ${error.message}`);
      return [];
    }
  }

  async getLastPrice(path) {
    try {
      if (!this.realtimeDbAdmin) return null;
      
      const snapshot = await this.realtimeDbAdmin.ref(`${path}/current_price`).once('value');
      const data = snapshot.val();
      
      if (data && data.price) {
        return {
          price: parseFloat(data.price),
          timestamp: data.timestamp || TimezoneUtil.getCurrentTimestamp(),
          datetime: data.datetime || TimezoneUtil.formatDateTime()
        };
      }
      return null;
    } catch (error) {
      // Silent fail - no need to log every check
      return null;
    }
  }

  async setRealtimeValue(path, data, retries = 2) {
    if (!this.realtimeDbAdmin) {
      this.writeStats.failed++;
      return false;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.realtimeDbAdmin.ref(path).set(data);
        this.writeStats.success++;
        return true;
      } catch (error) {
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        } else {
          this.writeStats.failed++;
          // Only log if many failures
          if (this.writeStats.failed % 100 === 0) {
            logger.error(`Write failed at ${path}: ${error.message} (Total failures: ${this.writeStats.failed})`);
          }
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

  async startCleanupScheduler() {
    setInterval(async () => {
      const now = Date.now();
      if (now - this.lastCleanupTime < this.CLEANUP_INTERVAL) return;

      logger.info('🗑️  Starting automatic cleanup...');
      
      const cutoffTimestamp = TimezoneUtil.getCurrentTimestamp() - (this.RETENTION_DAYS * 86400);
      
      try {
        const assets = await this.getAssets();
        let totalDeleted = 0;
        
        for (const asset of assets) {
          const path = this.getAssetPath(asset);
          const timeframes = ['1m', '5m', '15m', '1h'];
          
          for (const tf of timeframes) {
            try {
              const snapshot = await this.realtimeDbAdmin.ref(`${path}/ohlc_${tf}`).once('value');
              const data = snapshot.val();
              
              if (data) {
                const oldKeys = Object.keys(data).filter(timestamp => {
                  return parseInt(timestamp) < cutoffTimestamp;
                });

                if (oldKeys.length > 0) {
                  for (const key of oldKeys) {
                    await this.realtimeDbAdmin.ref(`${path}/ohlc_${tf}/${key}`).remove();
                  }
                  totalDeleted += oldKeys.length;
                }
              }
            } catch (error) {
              // Silent - timeframe might not exist
            }
          }
        }

        this.lastCleanupTime = now;
        
        if (totalDeleted > 0) {
          logger.info(`✅ Cleanup completed: ${totalDeleted} old bars deleted`);
        } else {
          logger.info('✅ Cleanup completed: No old data found');
        }
        
      } catch (error) {
        logger.error(`❌ Cleanup error: ${error.message}`);
      }
    }, this.CLEANUP_INTERVAL);
  }

  getAssetPath(asset) {
    if (asset.dataSource === 'realtime_db' && asset.realtimeDbPath) {
      return asset.realtimeDbPath;
    }
    return `/mock/${asset.symbol.toLowerCase()}`;
  }

  getStats() {
    const now = Date.now();
    const timeSinceReset = now - this.lastReadReset;
    const hoursSinceReset = timeSinceReset / 3600000;
    
    return {
      success: this.writeStats.success,
      failed: this.writeStats.failed,
      queueSize: this.writeQueue.length,
      successRate: this.writeStats.success > 0 
        ? Math.round((this.writeStats.success / (this.writeStats.success + this.writeStats.failed)) * 100)
        : 0,
      firestoreReads: this.firestoreReadCount,
      readsPer24h: hoursSinceReset > 0 ? Math.round(this.firestoreReadCount / hoursSinceReset * 24) : 0,
      uptime: Math.floor(timeSinceReset / 1000),
    };
  }
}

// ============================================
// TIMEFRAME MANAGER
// ============================================
class TimeframeManager {
  constructor() {
    this.timeframes = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
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
          completedBars[tf] = { ...this.bars[tf], isCompleted: true };
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
// ASSET SIMULATOR
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

    this.realtimeDbPath = this.firebase.getAssetPath(asset);

    logger.info(`✅ [${asset.symbol}] Initialized at ${this.realtimeDbPath}`);
  }

  async loadLastPrice() {
    try {
      const lastPriceData = await this.firebase.getLastPrice(this.realtimeDbPath);
      
      if (lastPriceData && lastPriceData.price) {
        const price = lastPriceData.price;
        
        if (price >= this.minPrice && price <= this.maxPrice) {
          this.currentPrice = price;
          this.lastPriceData = lastPriceData;
          this.isResumed = true;
          
          logger.info(`🔄 [${this.asset.symbol}] RESUMED from ${price.toFixed(6)}`);
          return true;
        }
      }
      
      logger.info(`ℹ️  [${this.asset.symbol}] Starting fresh at ${this.initialPrice}`);
      return false;
    } catch (error) {
      logger.warn(`⚠️  [${this.asset.symbol}] Could not load last price: ${error.message}`);
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
      
      // ✅ INCREMENT HEALTH CHECK COUNTER
      priceUpdateCount++;
      
      const { completedBars, currentBars } = this.tfManager.updateOHLC(timestamp, newPrice);
      
      const date = new Date(timestamp * 1000);
      const dateTimeInfo = TimezoneUtil.getDateTimeInfo(date);

      // Current price data
      const currentPriceData = {
        price: parseFloat(newPrice.toFixed(6)),
        timestamp: timestamp,
        datetime: dateTimeInfo.datetime,
        datetime_iso: dateTimeInfo.datetime_iso,
        timezone: 'Asia/Jakarta',
        change: parseFloat(((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)),
      };
      
      // Write current price
      await this.firebase.setRealtimeValue(
        `${this.realtimeDbPath}/current_price`,
        currentPriceData
      );

      // Write completed OHLC bars (async)
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

      this.currentPrice = newPrice;
      this.iteration++;

      // ✅ REDUCED LOGGING - Every 2 minutes instead of 30s
      const now = Date.now();
      if (now - this.lastLogTime > 120000) {
        const stats = this.firebase.getStats();
        logger.info(
          `[${this.asset.symbol}] ` +
          `${newPrice.toFixed(6)} ` +
          `(${((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)}%) | ` +
          `Iter: ${this.iteration} | ` +
          `Writes: ${stats.successRate}%`
        );
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
    
    logger.info(`🔄 [${this.asset.symbol}] Settings updated`);
  }

  getInfo() {
    return {
      symbol: this.asset.symbol,
      name: this.asset.name,
      currentPrice: this.currentPrice,
      iteration: this.iteration,
      isResumed: this.isResumed,
      path: this.realtimeDbPath
    };
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
    logger.info('🎯 Initializing Multi-Asset Manager v7.1...');
    
    const assets = await this.firebase.getAssets();
    
    if (assets.length === 0) {
      logger.warn('⚠️  No active assets found. Waiting...');
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

      // Remove deleted assets
      for (const id of currentIds) {
        if (!newIds.has(id)) {
          const simulator = this.simulators.get(id);
          logger.info(`🗑️  Removing simulator: ${simulator.asset.symbol}`);
          this.simulators.delete(id);
        }
      }

      // Add new assets
      for (const asset of assets) {
        if (!currentIds.has(asset.id)) {
          logger.info(`➕ New asset detected: ${asset.symbol}`);
          
          const simulator = new AssetSimulator(asset, this.firebase);
          await simulator.loadLastPrice();
          this.simulators.set(asset.id, simulator);
          
          logger.info(`✅ Simulator started for ${asset.symbol}`);
        } else {
          // Update existing simulator settings
          const simulator = this.simulators.get(asset.id);
          simulator.updateSettings(asset);
        }
      }
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
      logger.warn('⚠️  Manager already running');
      return;
    }

    await this.initialize();

    if (this.simulators.size === 0) {
      logger.warn('⚠️  No simulators to start. Will retry in 10 seconds...');
      setTimeout(() => this.start(), 10000);
      return;
    }

    this.isRunning = true;

    logger.info('');
    logger.info('🚀 ================================================');
    logger.info('🚀 SIMULATOR v7.1 - FIXED LOGGING & STUCK DETECTION');
    logger.info('🚀 ================================================');
    logger.info(`🌐 Timezone: Asia/Jakarta (WIB = UTC+7)`);
    logger.info(`⏰ Current Time: ${TimezoneUtil.formatDateTime()}`);
    logger.info(`📊 Active Assets: ${this.simulators.size}`);
    logger.info('⏱️  Price Update: 1 second');
    logger.info('🔄 Asset Refresh: Every 10 minutes');
    logger.info('🛡️  Stuck Detection: Active (30s check)');
    logger.info('📝 Log Rotation: 2MB x 3 files');
    logger.info('🚀 ================================================');
    logger.info('');

    logger.info('📋 ACTIVE SIMULATORS:');
    logger.info('================================================');
    for (const [id, simulator] of this.simulators.entries()) {
      const info = simulator.getInfo();
      logger.info(`   • ${info.symbol} - ${info.name}`);
      logger.info(`     Path: ${info.path}`);
      logger.info(`     Price: ${info.currentPrice.toFixed(6)}`);
      logger.info(`     Status: ${info.isResumed ? '🔄 RESUMED' : '🆕 FRESH START'}`);
    }
    logger.info('================================================');
    logger.info('');

    // ✅ Price updates - 1 second
    this.updateInterval = setInterval(async () => {
      await this.updateAllPrices();
    }, 1000);

    // ✅ Asset refresh - 10 minutes
    this.settingsRefreshInterval = setInterval(async () => {
      await this.refreshAssets();
    }, 600000);

    // ✅ Stats logging - Every 5 minutes
    this.statsInterval = setInterval(() => {
      const stats = this.firebase.getStats();
      logger.info('');
      logger.info('📊 ================================================');
      logger.info('📊 STATISTICS');
      logger.info('📊 ================================================');
      logger.info(`   Active Simulators: ${this.simulators.size}`);
      logger.info(`   Price Updates: ${priceUpdateCount}`);
      logger.info(`   Write Success: ${stats.success}`);
      logger.info(`   Write Failed: ${stats.failed}`);
      logger.info(`   Success Rate: ${stats.successRate}%`);
      logger.info(`   Write Queue: ${stats.queueSize}`);
      logger.info(`   Firestore Reads: ${stats.firestoreReads}`);
      logger.info(`   Est. Reads/24h: ${stats.readsPer24h}`);
      logger.info(`   Uptime: ${Math.floor(stats.uptime / 60)} minutes`);
      logger.info('📊 ================================================');
      logger.info('');
    }, 300000); // 5 minutes

    logger.info('✅ All simulators running!');
    logger.info('🛡️  Stuck detection: Active');
    logger.info('📝 Logs: Reduced verbosity');
    logger.info('');
    logger.info('💡 Add new asset via API - auto-detected in 10 minutes!');
    logger.info('Press Ctrl+C to stop');
    logger.info('');
  }

  async stop() {
    if (!this.isRunning) return;

    logger.info('');
    logger.info('🛑 Stopping Multi-Asset Manager...');
    
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

    logger.info('');
    logger.info('📊 Final Statistics:');
    const stats = this.firebase.getStats();
    logger.info(`   Active Simulators: ${this.simulators.size}`);
    logger.info(`   Total Price Updates: ${priceUpdateCount}`);
    logger.info(`   Writes: Success: ${stats.success}, Failed: ${stats.failed}`);
    logger.info(`   Success Rate: ${stats.successRate}%`);
    logger.info(`   Firestore Reads: ${stats.firestoreReads}`);
    logger.info(`   Uptime: ${Math.floor(stats.uptime / 60)} minutes`);
    
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
  console.log('🌐 MULTI-ASSET SIMULATOR v7.1 - FIXED LOGGING');
  console.log('🌐 ================================================');
  console.log(`🌐 Process TZ: ${process.env.TZ}`);
  console.log(`🌐 Current Time (WIB): ${TimezoneUtil.formatDateTime()}`);
  console.log('🌐 ================================================');
  console.log('');

  try {
    const firebaseManager = new FirebaseManager();
    await firebaseManager.initialize();

    const manager = new MultiAssetManager(firebaseManager);
    
    // Graceful shutdown handlers
    process.on('SIGINT', () => manager.stop());
    process.on('SIGTERM', () => manager.stop());
    process.on('SIGUSR2', () => manager.stop());
    
    // Error handlers
    process.on('uncaughtException', (error) => {
      logger.error(`Uncaught Exception: ${error.message}`);
      logger.error(error.stack);
      manager.stop();
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error(`Unhandled Rejection: ${reason}`);
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