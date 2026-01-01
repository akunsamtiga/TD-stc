// ============================================
// MULTI-ASSET SIMULATOR v8.0 - WATCHDOG EDITION
// ============================================
// 🔥 FIXED: Watchdog prevents stuck/freeze
// 🩺 Health check setiap 30 detik
// 💾 Memory management & auto GC
// ⏱️ Timeout protection untuk semua ops
// 📊 Better activity tracking

import admin from 'firebase-admin';
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
// 🔥 FIXED WATCHDOG - Deteksi & Recovery Stuck
// ============================================
class Watchdog {
  constructor(name, timeoutSeconds = 60) {
    this.name = name;
    this.timeoutSeconds = timeoutSeconds; // ✅ FIXED: Save as property
    this.timeoutMs = timeoutSeconds * 1000;
    this.lastActivity = Date.now();
    this.isActive = false;
    this.checkInterval = null;
    this.stuckCount = 0;
    this.MAX_STUCK_COUNT = 3;
  }

  start(onStuck) {
    this.isActive = true;
    this.lastActivity = Date.now();
    this.onStuck = onStuck;

    this.checkInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceActivity = now - this.lastActivity;
      
      if (timeSinceActivity > this.timeoutMs) {
        this.stuckCount++;
        
        logger.error('');
        logger.error('⚠️ ================================================');
        logger.error(`⚠️ WATCHDOG ALERT: ${this.name} STUCK!`);
        logger.error('⚠️ ================================================');
        logger.error(`   Time since last activity: ${Math.floor(timeSinceActivity / 1000)}s`);
        logger.error(`   Stuck count: ${this.stuckCount}/${this.MAX_STUCK_COUNT}`);
        logger.error(`   Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
        logger.error('⚠️ ================================================');
        logger.error('');

        if (this.stuckCount >= this.MAX_STUCK_COUNT) {
          logger.error('🔥 Max stuck count reached - triggering recovery...');
          if (this.onStuck) {
            this.onStuck();
          }
        } else {
          logger.warn(`⚠️ Will retry ${this.MAX_STUCK_COUNT - this.stuckCount} more time(s)`);
        }
      } else {
        if (this.stuckCount > 0) {
          logger.info('✅ Watchdog: Activity resumed, resetting stuck count');
          this.stuckCount = 0;
        }
      }
    }, 30000); // Check every 30 seconds

    // ✅ FIXED: Use this.timeoutSeconds
    logger.info(`🐕 Watchdog started for ${this.name} (timeout: ${this.timeoutSeconds}s)`);
  }

  heartbeat() {
    this.lastActivity = Date.now();
    if (this.stuckCount > 0) {
      this.stuckCount = 0; // Reset on activity
    }
  }

  stop() {
    this.isActive = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info(`🐕 Watchdog stopped for ${this.name}`);
  }

  getStatus() {
    const timeSinceActivity = Date.now() - this.lastActivity;
    return {
      active: this.isActive,
      lastActivity: Math.floor(timeSinceActivity / 1000),
      stuckCount: this.stuckCount,
      healthy: timeSinceActivity < this.timeoutMs
    };
  }
}

// ============================================
// FIREBASE MANAGER (Enhanced)
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
    this.CLEANUP_INTERVAL = 3600000;
    
    this.firestoreReadCount = 0;
    this.lastReadReset = Date.now();
    
    // 🔥 Connection health tracking
    this.lastSuccessfulWrite = Date.now();
    this.consecutiveFailures = 0;
    this.MAX_CONSECUTIVE_FAILURES = 10;
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
      
      // 🔥 Test connection
      await Promise.race([
        this.realtimeDbAdmin.ref('/.info/connected').once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000))
      ]);
      
      logger.info('✅ Firebase Admin SDK initialized (WATCHDOG EDITION)');
      logger.info('✅ Firestore ready');
      logger.info('✅ Realtime DB Admin SDK ready');
      logger.info('🐕 Watchdog & Auto-recovery enabled');
      
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
      
      // 🔥 Add timeout
      const snapshot = await Promise.race([
        this.db.collection('assets').where('isActive', '==', true).get(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 10000))
      ]);

      const assets = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        if (data.dataSource === 'realtime_db' || data.dataSource === 'mock') {
          assets.push({ id: doc.id, ...data });
        }
      });

      logger.debug(`📊 Firestore read #${this.firestoreReadCount}: Fetched ${assets.length} assets`);
      return assets;
    } catch (error) {
      logger.error(`Error fetching assets: ${error.message}`);
      return [];
    }
  }

  async getLastPrice(path) {
    try {
      if (!this.realtimeDbAdmin) {
        logger.error('Realtime DB Admin not initialized');
        return null;
      }

      // 🔥 Add timeout
      const snapshot = await Promise.race([
        this.realtimeDbAdmin.ref(`${path}/current_price`).once('value'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Read timeout')), 5000))
      ]);

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
      logger.debug(`No last price found at ${path}: ${error.message}`);
      return null;
    }
  }

  async setRealtimeValue(path, data, retries = 2) {
    if (!this.realtimeDbAdmin) {
      logger.error('Realtime DB Admin not initialized');
      this.writeStats.failed++;
      this.consecutiveFailures++;
      return false;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // 🔥 Add timeout
        await Promise.race([
          this.realtimeDbAdmin.ref(path).set(data),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Write timeout')), 5000))
        ]);

        this.writeStats.success++;
        this.lastSuccessfulWrite = Date.now();
        this.consecutiveFailures = 0; // Reset on success
        return true;
      } catch (error) {
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        } else {
          this.writeStats.failed++;
          this.consecutiveFailures++;
          
          if (this.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
            logger.error('');
            logger.error('🔥 ================================================');
            logger.error('🔥 FIREBASE CONNECTION PROBLEM!');
            logger.error('🔥 ================================================');
            logger.error(`   Consecutive failures: ${this.consecutiveFailures}`);
            logger.error(`   Time since last success: ${Math.floor((Date.now() - this.lastSuccessfulWrite) / 1000)}s`);
            logger.error('🔥 ================================================');
            logger.error('');
          }
          
          logger.error(`Write failed at ${path}: ${error.message}`);
          return false;
        }
      }
    }
    return false;
  }

  async setRealtimeValueAsync(path, data) {
    this.writeQueue.push({ path, data, timestamp: Date.now() });
    
    // 🔥 Prevent queue overflow
    if (this.writeQueue.length > 100) {
      logger.warn(`⚠️ Write queue large: ${this.writeQueue.length} items`);
    }
  }

  async startQueueProcessor() {
    setInterval(async () => {
      if (this.isProcessingQueue || this.writeQueue.length === 0) return;
      
      this.isProcessingQueue = true;
      const batch = this.writeQueue.splice(0, 10);
      
      // 🔥 Detect stale items
      const now = Date.now();
      const staleItems = batch.filter(item => (now - item.timestamp) > 30000);
      if (staleItems.length > 0) {
        logger.warn(`⚠️ Processing ${staleItems.length} stale queue items`);
      }
      
      await Promise.allSettled(
        batch.map(({ path, data }) => this.setRealtimeValue(path, data, 1))
      );
      
      this.isProcessingQueue = false;
    }, 200);
  }

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
                  logger.info(`  🗑️ Deleting ${oldKeys.length} old ${tf} bars for ${asset.symbol}`);
                  
                  for (const key of oldKeys) {
                    await this.realtimeDbAdmin.ref(`${path}/ohlc_${tf}/${key}`).remove();
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
    const timeSinceLastWrite = now - this.lastSuccessfulWrite;
    
    return {
      success: this.writeStats.success,
      failed: this.writeStats.failed,
      queueSize: this.writeQueue.length,
      successRate: this.writeStats.success > 0 
        ? Math.round((this.writeStats.success / (this.writeStats.success + this.writeStats.failed)) * 100)
        : 0,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessfulWrite: Math.floor(timeSinceLastWrite / 1000),
      billing: {
        firestoreReads: this.firestoreReadCount,
        readsPer24h: hoursSinceReset > 0 ? Math.round(this.firestoreReadCount / hoursSinceReset * 24) : 0,
        timeSinceReset: `${Math.floor(hoursSinceReset)}h ${Math.floor((hoursSinceReset % 1) * 60)}m`
      }
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
    
    // 🔥 Activity tracking
    this.lastUpdateTime = Date.now();
    this.updateCount = 0;

    this.realtimeDbPath = this.firebase.getAssetPath(asset);

    logger.info('');
    logger.info(`✅ Simulator initialized for ${asset.symbol}`);
    logger.info(`   Name: ${asset.name}`);
    logger.info(`   Data Source: ${asset.dataSource}`);
    logger.info(`   Path: ${this.realtimeDbPath}`);
    logger.info(`   Initial Price: ${this.initialPrice}`);
    logger.info(`   Volatility: ${this.volatilityMin} - ${this.volatilityMax}`);
    logger.info(`   Price Range: ${this.minPrice} - ${this.maxPrice}`);
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
      const updateStartTime = Date.now();
      
      const timestamp = TimezoneUtil.getCurrentTimestamp();
      const newPrice = this.generatePriceMovement();
      
      const { completedBars, currentBars } = this.tfManager.updateOHLC(timestamp, newPrice);
      
      const date = new Date(timestamp * 1000);
      const dateTimeInfo = TimezoneUtil.getDateTimeInfo(date);

      const currentPriceData = {
        price: parseFloat(newPrice.toFixed(6)),
        timestamp: timestamp,
        datetime: dateTimeInfo.datetime,
        datetime_iso: dateTimeInfo.datetime_iso,
        timezone: 'Asia/Jakarta',
        change: parseFloat(((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)),
      };
      
      await this.firebase.setRealtimeValue(
        `${this.realtimeDbPath}/current_price`,
        currentPriceData
      );

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
      
      // 🔥 Track activity
      this.lastUpdateTime = Date.now();
      this.updateCount++;

      const now = Date.now();
      const updateDuration = now - updateStartTime;
      
      // 🔥 Warn if update is slow
      if (updateDuration > 1000) {
        logger.warn(`⚠️ [${this.asset.symbol}] Slow update: ${updateDuration}ms`);
      }
      
      if (now - this.lastLogTime > 30000) {
        const stats = this.firebase.getStats();
        logger.info(
          `[${this.asset.symbol}] ${this.isResumed ? '🔄 RESUMED' : '🆕 FRESH'} | ` +
          `Iter ${this.iteration}: ${newPrice.toFixed(6)} ` +
          `(${((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)}%) | ` +
          `Writes: ${stats.successRate}% | Queue: ${stats.queueSize}`
        );
        this.lastLogTime = now;
      }

    } catch (error) {
      logger.error(`[${this.asset.symbol}] Update error: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
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
    const timeSinceUpdate = Date.now() - this.lastUpdateTime;
    
    return {
      symbol: this.asset.symbol,
      name: this.asset.name,
      currentPrice: this.currentPrice,
      iteration: this.iteration,
      isResumed: this.isResumed,
      path: this.realtimeDbPath,
      updateCount: this.updateCount,
      lastUpdate: Math.floor(timeSinceUpdate / 1000),
      isHealthy: timeSinceUpdate < 5000
    };
  }
}

// ============================================
// 🔥 MULTI-ASSET MANAGER (WITH WATCHDOG)
// ============================================
class MultiAssetManager {
  constructor(firebaseManager) {
    this.firebase = firebaseManager;
    this.simulators = new Map();
    this.updateInterval = null;
    this.settingsRefreshInterval = null;
    this.statsInterval = null;
    this.isRunning = false;
    
    // 🔥 Watchdog for stuck detection
    this.watchdog = new Watchdog('PriceUpdateLoop', 60); // 60 second timeout
    this.lastActivityCheck = Date.now();
  }

  async initialize() {
    logger.info('🎯 Initializing Multi-Asset Manager (WATCHDOG EDITION)...');
    
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
          logger.info('');
          logger.info(`🗑️ ================================================`);
          logger.info(`🗑️ REMOVING SIMULATOR: ${simulator.asset.symbol}`);
          logger.info(`🗑️ ================================================`);
          this.simulators.delete(id);
        }
      }

      for (const asset of assets) {
        if (!currentIds.has(asset.id)) {
          logger.info('');
          logger.info(`➕ ================================================`);
          logger.info(`➕ NEW ASSET DETECTED: ${asset.symbol}`);
          logger.info(`➕ ================================================`);
          
          const simulator = new AssetSimulator(asset, this.firebase);
          await simulator.loadLastPrice();
          this.simulators.set(asset.id, simulator);
          
          logger.info(`➕ Simulator started for ${asset.symbol}`);
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

    try {
      // 🔥 Heartbeat to watchdog BEFORE processing
      this.watchdog.heartbeat();
      
      const promises = [];
      for (const simulator of this.simulators.values()) {
        promises.push(
          // 🔥 Add timeout per simulator
          Promise.race([
            simulator.updatePrice(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Update timeout')), 3000)
            )
          ]).catch(error => {
            logger.error(`❌ Simulator update failed: ${error.message}`);
          })
        );
      }

      await Promise.allSettled(promises);
      
      // 🔥 Heartbeat AFTER successful processing
      this.watchdog.heartbeat();
      
    } catch (error) {
      logger.error(`❌ updateAllPrices error: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
    }
  }

  // 🔥 Recovery mechanism
  async handleStuck() {
    logger.error('');
    logger.error('🔥 ================================================');
    logger.error('🔥 INITIATING AUTO-RECOVERY');
    logger.error('🔥 ================================================');
    logger.error('');
    
    try {
      // Log current state
      logger.info('📊 Current State:');
      for (const [id, simulator] of this.simulators.entries()) {
        const info = simulator.getInfo();
        logger.info(`   • ${info.symbol}: Last update ${info.lastUpdate}s ago, Healthy: ${info.isHealthy}`);
      }
      
      // Force garbage collection if available
      if (global.gc) {
        logger.info('🧹 Running garbage collection...');
        global.gc();
      }
      
      const stats = this.firebase.getStats();
      logger.info(`📊 Firebase Stats: Success ${stats.success}, Failed ${stats.failed}, Queue ${stats.queueSize}`);
      
      // If too many failures, restart process
      if (stats.consecutiveFailures > 20 || stats.queueSize > 200) {
        logger.error('🔥 Critical condition detected - restarting process...');
        process.exit(1); // PM2 will restart
      }
      
      // Clear intervals and restart
      logger.info('🔄 Clearing intervals...');
      if (this.updateInterval) {
        clearInterval(this.updateInterval);
        this.updateInterval = null;
      }
      
      logger.info('⏳ Waiting 5 seconds...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      logger.info('🔄 Restarting update loop...');
      this.updateInterval = setInterval(async () => {
        await this.updateAllPrices();
      }, 1000);
      
      // Reset watchdog
      this.watchdog.stop();
      this.watchdog = new Watchdog('PriceUpdateLoop', 60);
      this.watchdog.start(() => this.handleStuck());
      
      logger.info('✅ Recovery completed');
      logger.info('');
      
    } catch (error) {
      logger.error(`❌ Recovery failed: ${error.message}`);
      logger.error('🔥 Forcing process restart...');
      process.exit(1); // PM2 will restart
    }
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
    logger.info('🚀 MULTI-ASSET SIMULATOR v8.0 - WATCHDOG EDITION');
    logger.info('🚀 ================================================');
    logger.info('🚀 ✅ ADMIN SDK (BYPASSES RULES)');
    logger.info('🚀 ✅ REAL-TIME PRICE UPDATES (1s interval)');
    logger.info('🚀 ✅ WATCHDOG AUTO-RECOVERY (60s timeout)');
    logger.info('🚀 ✅ MEMORY MONITORING & GC');
    logger.info('🚀 ================================================');
    logger.info(`🌐 Timezone: Asia/Jakarta (WIB = UTC+7)`);
    logger.info(`⏰ Current Time: ${TimezoneUtil.formatDateTime()}`);
    logger.info(`📊 Active Assets: ${this.simulators.size}`);
    logger.info('⏱️ Price Update: 1 second');
    logger.info('🔄 Asset Refresh: Every 10 minutes');
    logger.info('🐕 Watchdog: 60 second timeout');
    logger.info('🗑️ Cleanup: Every 1 hour (keeps 7 days)');
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

    // 🔥 Start watchdog
    this.watchdog.start(() => this.handleStuck());

    // Price updates - 1 second
    this.updateInterval = setInterval(async () => {
      await this.updateAllPrices();
    }, 1000);

    // Asset refresh - 10 minutes
    this.settingsRefreshInterval = setInterval(async () => {
      await this.refreshAssets();
    }, 600000);

    // Stats logging - 1 minute
    this.statsInterval = setInterval(() => {
      const stats = this.firebase.getStats();
      const watchdogStatus = this.watchdog.getStatus();
      const memUsage = process.memoryUsage();
      
      logger.info('');
      logger.info(`📊 ================================================`);
      logger.info(`📊 STATISTICS`);
      logger.info(`📊 ================================================`);
      logger.info(`   Active Simulators: ${this.simulators.size}`);
      logger.info(`   Write Success: ${stats.success}`);
      logger.info(`   Write Failed: ${stats.failed}`);
      logger.info(`   Success Rate: ${stats.successRate}%`);
      logger.info(`   Write Queue: ${stats.queueSize}`);
      logger.info(`   Consecutive Failures: ${stats.consecutiveFailures}`);
      logger.info(`   Last Write: ${stats.lastSuccessfulWrite}s ago`);
      logger.info(`   💰 Firestore Reads: ${stats.billing.firestoreReads}`);
      logger.info(`   💰 Est. Reads/24h: ${stats.billing.readsPer24h}`);
      logger.info(`   🐕 Watchdog: ${watchdogStatus.healthy ? '✅ HEALTHY' : '⚠️ WARNING'}`);
      logger.info(`   🐕 Last Activity: ${watchdogStatus.lastActivity}s ago`);
      logger.info(`   💾 Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
      logger.info(`📊 ================================================`);
      logger.info('');
    }, 60000);

    logger.info('✅ All simulators running with watchdog protection!');
    logger.info('🐕 Auto-recovery enabled - will detect and fix stuck conditions');
    logger.info('💡 Add new asset via API - auto-detected in 10 minutes!');
    logger.info('Press Ctrl+C to stop');
    logger.info('');
  }

  async stop() {
    if (!this.isRunning) return;

    logger.info('');
    logger.info('⏹️ Stopping Multi-Asset Manager...');
    
    this.isRunning = false;
    
    // Stop watchdog
    if (this.watchdog) {
      this.watchdog.stop();
    }

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
    logger.info(`   Active Simulators: ${this.simulators.size}`);
    logger.info(`   Writes: Success: ${stats.success}, Failed: ${stats.failed}, Rate: ${stats.successRate}%`);
    logger.info(`   Firestore Reads: ${stats.billing.firestoreReads}`);
    
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
  console.log('🌐 MULTI-ASSET SIMULATOR v8.0 - WATCHDOG EDITION');
  console.log('🌐 ================================================');
  console.log(`🌐 Process TZ: ${process.env.TZ}`);
  console.log(`🌐 Current Time (WIB): ${TimezoneUtil.formatDateTime()}`);
  console.log(`🌐 Node Version: ${process.version}`);
  console.log(`🌐 Memory: ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`);
  console.log('🌐 ================================================');
  console.log('');

  try {
    const firebaseManager = new FirebaseManager();
    await firebaseManager.initialize();

    const manager = new MultiAssetManager(firebaseManager);
    
    // 🔥 Enhanced signal handlers
    process.on('SIGINT', () => {
      logger.info('');
      logger.info('⏹️ Received SIGINT - graceful shutdown...');
      manager.stop();
    });
    
    process.on('SIGTERM', () => {
      logger.info('');
      logger.info('⏹️ Received SIGTERM - graceful shutdown...');
      manager.stop();
    });
    
    process.on('SIGUSR2', () => {
      logger.info('');
      logger.info('⏹️ Received SIGUSR2 - graceful shutdown...');
      manager.stop();
    });
    
    process.on('uncaughtException', (error) => {
      logger.error('');
      logger.error('❌ ================================================');
      logger.error('❌ UNCAUGHT EXCEPTION');
      logger.error('❌ ================================================');
      logger.error(`Error: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
      logger.error('❌ ================================================');
      logger.error('');
      manager.stop();
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('');
      logger.error('❌ ================================================');
      logger.error('❌ UNHANDLED PROMISE REJECTION');
      logger.error('❌ ================================================');
      logger.error(`Reason: ${reason}`);
      logger.error(`Promise: ${promise}`);
      logger.error('❌ ================================================');
      logger.error('');
      manager.stop();
    });

    await manager.start();
    
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    logger.error(`Stack: ${error.stack}`);
    process.exit(1);
  }
}

// 🔥 Enable manual GC if running with --expose-gc
if (global.gc) {
  logger.info('🧹 Manual garbage collection enabled');
  setInterval(() => {
    const before = process.memoryUsage().heapUsed;
    global.gc();
    const after = process.memoryUsage().heapUsed;
    const freed = before - after;
    if (freed > 1024 * 1024) {
      logger.debug(`🧹 GC freed ${Math.round(freed / 1024 / 1024)}MB`);
    }
  }, 300000);
}

main();