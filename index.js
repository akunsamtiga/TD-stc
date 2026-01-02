// ============================================
// MULTI-ASSET SIMULATOR v9.0 - SELF-HEALING
// ============================================
// ✅ Auto-reconnect when write fails
// ✅ Aggressive connection monitoring
// ✅ Auto-restart on stale connection
// ✅ Independent from backend
// ============================================

import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();
process.env.TZ = 'Asia/Jakarta';

// ============================================
// LOGGER CONFIGURATION
// ============================================
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      if (stack) {
        return `${timestamp} - ${level.toUpperCase()} - ${message}\n${stack}`;
      }
      return `${timestamp} - ${level.toUpperCase()} - ${message}`;
    })
  ),
  transports: [
    new transports.File({ 
      filename: 'simulator.log', 
      maxsize: 5242880, 
      maxFiles: 3,
      tailable: true
    }),
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message }) => `${timestamp} - ${level} - ${message}`)
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
// FIREBASE MANAGER - SELF-HEALING
// ============================================
class FirebaseManager {
  constructor() {
    this.db = null;
    this.realtimeDbAdmin = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    
    this.writeQueue = [];
    this.isProcessingQueue = false;
    this.writeStats = { 
      success: 0, 
      failed: 0, 
      queued: 0,
      lastSuccessTime: Date.now() 
    };
    
    this.RETENTION_SMALL_TF = 3;
    this.RETENTION_MEDIUM_TF = 5;
    this.RETENTION_LARGE_TF = 7;
    this.lastCleanupTime = 0;
    this.CLEANUP_INTERVAL = 3600000;
    
    this.firestoreReadCount = 0;
    this.lastReadReset = Date.now();
    this.dailyTransferEstimate = 0;
    
    this.lastHeartbeat = Date.now();
    this.heartbeatInterval = null;
    
    this.consecutiveErrors = 0;
    this.MAX_CONSECUTIVE_ERRORS = 3; // ✅ Reduced from 5
    
    // ✅ NEW: Aggressive stale connection detection
    this.STALE_CONNECTION_THRESHOLD = 120000; // 2 minutes
    this.staleCheckInterval = null;
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

      // ✅ Reset admin if exists (for reconnection)
      if (admin.apps.length > 0) {
        logger.warn('🔄 Existing Firebase app detected, resetting...');
        await Promise.all(admin.apps.map(app => app?.delete()));
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_REALTIME_DB_URL,
      });

      this.db = admin.firestore();
      this.db.settings({
        ignoreUndefinedProperties: true,
        timestampsInSnapshots: true,
      });

      this.realtimeDbAdmin = admin.database();
      
      await this.testConnection();
      
      this.isConnected = true;
      this.consecutiveErrors = 0;
      this.reconnectAttempts = 0;
      
      logger.info('✅ Firebase Admin SDK initialized (SELF-HEALING v9.0)');
      logger.info('✅ Firestore ready');
      logger.info('✅ Realtime DB ready');
      logger.info('🔄 Auto-recovery: ENABLED');
      
      this.startQueueProcessor();
      this.startCleanupScheduler();
      this.startHeartbeat();
      this.startStaleConnectionMonitor(); // ✅ NEW
      
      return true;
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      await this.handleConnectionError(error);
      return false;
    }
  }

  async testConnection() {
    try {
      await this.db.collection('_health_check').limit(1).get();
      await this.realtimeDbAdmin.ref('/.info/connected').once('value');
      logger.debug('✅ Connection test passed');
      return true;
    } catch (error) {
      logger.error(`❌ Connection test failed: ${error.message}`);
      throw error;
    }
  }

  async handleConnectionError(error) {
    this.isConnected = false;
    this.consecutiveErrors++;
    
    logger.error(`❌ Connection error #${this.consecutiveErrors}: ${error.message}`);

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
      
      logger.warn(`🔄 Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      try {
        await this.initialize();
        logger.info('✅ Reconnection successful!');
      } catch (retryError) {
        logger.error(`❌ Reconnection failed: ${retryError.message}`);
      }
    } else {
      logger.error('❌ Max reconnection attempts reached, will retry in 60s...');
      await new Promise(resolve => setTimeout(resolve, 60000));
      this.reconnectAttempts = 0;
      await this.initialize();
    }
  }

  // ✅ NEW: Detect stale connections
  startStaleConnectionMonitor() {
    this.staleCheckInterval = setInterval(() => {
      const timeSinceLastSuccess = Date.now() - this.writeStats.lastSuccessTime;
      
      if (timeSinceLastSuccess > this.STALE_CONNECTION_THRESHOLD && this.writeStats.success > 0) {
        logger.error(`❌ STALE CONNECTION DETECTED! No writes in ${Math.floor(timeSinceLastSuccess / 1000)}s`);
        logger.warn('🔄 Forcing reconnection...');
        
        // Force reconnection
        this.isConnected = false;
        this.handleConnectionError(new Error('Stale connection detected'));
      }
    }, 15000); // Check every 15 seconds
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.realtimeDbAdmin.ref('/.info/serverTimeOffset').once('value');
        this.lastHeartbeat = Date.now();
        this.consecutiveErrors = 0;
      } catch (error) {
        logger.warn(`⚠️ Heartbeat failed: ${error.message}`);
        this.consecutiveErrors++;
        
        if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
          logger.error('❌ Multiple heartbeat failures, attempting reconnection...');
          await this.handleConnectionError(error);
        }
      }
    }, 15000); // ✅ Reduced from 30s to 15s
  }

  async getAssets() {
    if (!this.isConnected) {
      logger.warn('⚠️ Firebase not connected, skipping asset fetch');
      return [];
    }

    try {
      this.firestoreReadCount++;
      
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

      logger.debug(`📊 Firestore read #${this.firestoreReadCount}: ${assets.length} assets`);
      this.dailyTransferEstimate += 0.001;

      return assets;
    } catch (error) {
      logger.error(`❌ Error fetching assets: ${error.message}`);
      this.consecutiveErrors++;
      return [];
    }
  }

  async getLastPrice(path) {
    if (!this.isConnected) {
      return null;
    }

    try {
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
      logger.debug(`No last price at ${path}: ${error.message}`);
      return null;
    }
  }

  async setRealtimeValue(path, data, retries = 3) {
    if (!this.isConnected) {
      this.writeStats.failed++;
      return false;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.realtimeDbAdmin.ref(path).set(data);
        this.writeStats.success++;
        this.writeStats.lastSuccessTime = Date.now(); // ✅ Update success time
        this.consecutiveErrors = 0;
        
        this.dailyTransferEstimate += JSON.stringify(data).length / 1024 / 1024;
        
        return true;
      } catch (error) {
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        } else {
          this.writeStats.failed++;
          this.consecutiveErrors++;
          logger.error(`❌ Write failed at ${path}: ${error.message}`);
          
          // ✅ Trigger reconnection faster
          if (this.consecutiveErrors >= 2) {
            logger.warn('🔄 Multiple write failures, reconnecting...');
            await this.handleConnectionError(error);
          }
          
          return false;
        }
      }
    }
    return false;
  }

  async setRealtimeValueAsync(path, data) {
    this.writeStats.queued++;
    this.writeQueue.push({ path, data, addedAt: Date.now() });
    
    if (this.writeQueue.length > 1000) {
      logger.warn(`⚠️ Write queue overflow (${this.writeQueue.length}), dropping oldest entries`);
      this.writeQueue = this.writeQueue.slice(-500);
    }
  }

  async startQueueProcessor() {
    setInterval(async () => {
      if (this.isProcessingQueue || this.writeQueue.length === 0 || !this.isConnected) {
        return;
      }
      
      this.isProcessingQueue = true;
      
      const batch = this.writeQueue.splice(0, 10);
      
      await Promise.allSettled(
        batch.map(({ path, data }) => this.setRealtimeValue(path, data, 1))
      );
      
      const now = Date.now();
      this.writeQueue = this.writeQueue.filter(item => now - item.addedAt < 300000);
      
      this.isProcessingQueue = false;
    }, 200);
  }

  async startCleanupScheduler() {
    setInterval(async () => {
      const now = Date.now();
      
      if (now - this.lastCleanupTime < this.CLEANUP_INTERVAL || !this.isConnected) {
        return;
      }

      logger.info('🗑️ Starting automatic cleanup...');
      
      try {
        const assets = await this.getAssets();
        
        for (const asset of assets) {
          await this.cleanupAsset(asset);
        }

        this.lastCleanupTime = now;
        logger.info('✅ Cleanup completed');
        
      } catch (error) {
        logger.error(`❌ Cleanup error: ${error.message}`);
      }
    }, this.CLEANUP_INTERVAL);
  }

  async cleanupAsset(asset) {
    const path = this.getAssetPath(asset);
    
    const timeframes = [
      { tf: '1m', retention: this.RETENTION_SMALL_TF },
      { tf: '5m', retention: this.RETENTION_SMALL_TF },
      { tf: '15m', retention: this.RETENTION_SMALL_TF },
      { tf: '30m', retention: this.RETENTION_MEDIUM_TF },
      { tf: '1h', retention: this.RETENTION_MEDIUM_TF },
      { tf: '4h', retention: this.RETENTION_LARGE_TF },
      { tf: '1d', retention: this.RETENTION_LARGE_TF },
    ];
    
    for (const { tf, retention } of timeframes) {
      try {
        const cutoffTimestamp = TimezoneUtil.getCurrentTimestamp() - (retention * 86400);
        
        const snapshot = await this.realtimeDbAdmin.ref(`${path}/ohlc_${tf}`).once('value');
        const data = snapshot.val();
        
        if (data) {
          const oldKeys = Object.keys(data).filter(timestamp => {
            return parseInt(timestamp) < cutoffTimestamp;
          });

          if (oldKeys.length > 0) {
            logger.info(`  🗑️ Deleting ${oldKeys.length} old ${tf} bars for ${asset.symbol}`);
            
            const updates = {};
            oldKeys.forEach(key => {
              updates[`${path}/ohlc_${tf}/${key}`] = null;
            });
            
            await this.realtimeDbAdmin.ref().update(updates);
          }
        }
      } catch (error) {
        logger.debug(`No ${tf} data to cleanup for ${asset.symbol}`);
      }
    }
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
    const timeSinceLastSuccess = now - this.writeStats.lastSuccessTime;
    
    return {
      connection: {
        isConnected: this.isConnected,
        reconnectAttempts: this.reconnectAttempts,
        lastHeartbeat: `${Math.floor((now - this.lastHeartbeat) / 1000)}s ago`,
        consecutiveErrors: this.consecutiveErrors,
        timeSinceLastWrite: `${Math.floor(timeSinceLastSuccess / 1000)}s ago`, // ✅ NEW
      },
      writes: {
        success: this.writeStats.success,
        failed: this.writeStats.failed,
        queued: this.writeQueue.length,
        queuedItems: this.writeStats.queued,
        successRate: this.writeStats.success > 0 
          ? Math.round((this.writeStats.success / (this.writeStats.success + this.writeStats.failed)) * 100)
          : 0,
        lastSuccess: `${Math.floor(timeSinceLastSuccess / 1000)}s ago`,
      },
      billing: {
        firestoreReads: this.firestoreReadCount,
        estimatedReadsPer24h: hoursSinceReset > 0 
          ? Math.round(this.firestoreReadCount / hoursSinceReset * 24) 
          : 0,
        estimatedDailyTransfer: `${this.dailyTransferEstimate.toFixed(2)} MB`,
        timeSinceReset: `${Math.floor(hoursSinceReset)}h ${Math.floor((hoursSinceReset % 1) * 60)}m`,
        status: this.dailyTransferEstimate < 300 ? '✅ OK' : '⚠️ HIGH',
      }
    };
  }

  async shutdown() {
    logger.info('🛑 Shutting down Firebase Manager...');
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.staleCheckInterval) {
      clearInterval(this.staleCheckInterval);
    }
    
    if (this.writeQueue.length > 0) {
      logger.info(`📤 Processing ${this.writeQueue.length} remaining writes...`);
      
      while (this.writeQueue.length > 0) {
        const batch = this.writeQueue.splice(0, 10);
        await Promise.allSettled(
          batch.map(({ path, data }) => this.setRealtimeValue(path, data, 1))
        );
      }
    }
    
    logger.info('✅ Firebase Manager shutdown complete');
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
      '30m': 1800,
      '1h': 3600,
      '4h': 14400,
      '1d': 86400,
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
      timeframeSeconds: this.timeframes,
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
    
    this.consecutiveErrors = 0;
    this.MAX_ERRORS = 3; // ✅ Reduced from 5

    this.realtimeDbPath = this.firebase.getAssetPath(asset);

    logger.info('');
    logger.info(`✅ Simulator initialized: ${asset.symbol}`);
    logger.info(`   Name: ${asset.name}`);
    logger.info(`   Path: ${this.realtimeDbPath}`);
    logger.info(`   Initial: ${this.initialPrice}`);
    logger.info(`   Range: ${this.minPrice} - ${this.maxPrice}`);
    logger.info(`   Timeframes: 1m, 5m, 15m, 30m, 1h, 4h, 1d`);
  }

  async loadLastPrice() {
    try {
      logger.info(`🔍 [${this.asset.symbol}] Checking last price...`);
      
      const lastPriceData = await this.firebase.getLastPrice(this.realtimeDbPath);
      
      if (lastPriceData && lastPriceData.price) {
        const price = lastPriceData.price;
        
        if (price >= this.minPrice && price <= this.maxPrice) {
          this.currentPrice = price;
          this.lastPriceData = lastPriceData;
          this.isResumed = true;
          
          logger.info(`🔄 [${this.asset.symbol}] RESUMED: ${price.toFixed(6)}`);
          return true;
        }
      }
      
      logger.info(`ℹ️ [${this.asset.symbol}] Starting fresh: ${this.initialPrice}`);
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
    
    if (newPrice < this.minPrice) {
      newPrice = this.minPrice;
      this.lastDirection = 1;
    }
    if (newPrice > this.maxPrice) {
      newPrice = this.maxPrice;
      this.lastDirection = -1;
    }
    
    return newPrice;
  }

  async updatePrice() {
    try {
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
      
      const writeSuccess = await this.firebase.setRealtimeValue(
        `${this.realtimeDbPath}/current_price`,
        currentPriceData
      );

      if (!writeSuccess) {
        this.consecutiveErrors++;
        
        if (this.consecutiveErrors >= this.MAX_ERRORS) {
          logger.error(`❌ [${this.asset.symbol}] Too many errors, pausing...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          this.consecutiveErrors = 0;
        }
        return;
      } else {
        this.consecutiveErrors = 0;
      }

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

      const now = Date.now();
      if (now - this.lastLogTime > 30000) {
        logger.info(
          `[${this.asset.symbol}] ${this.isResumed ? '🔄' : '🆕'} | ` +
          `#${this.iteration}: ${newPrice.toFixed(6)} ` +
          `(${((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)}%)`
        );
        this.lastLogTime = now;
      }

    } catch (error) {
      this.consecutiveErrors++;
      logger.error(`❌ [${this.asset.symbol}] Update error: ${error.message}`);
      
      if (this.consecutiveErrors >= this.MAX_ERRORS) {
        logger.error(`❌ [${this.asset.symbol}] Critical errors, pausing...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        this.consecutiveErrors = 0;
      }
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
      path: this.realtimeDbPath,
      consecutiveErrors: this.consecutiveErrors,
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
    this.healthCheckInterval = null;
    this.isRunning = false;
    this.isPaused = false;
    this.isShuttingDown = false;
  }

  async initialize() {
    logger.info('🎯 Initializing Multi-Asset Manager (SELF-HEALING v9.0)...');
    
    const assets = await this.firebase.getAssets();
    
    if (assets.length === 0) {
      logger.warn('⚠️ No active assets. Retrying in 30s...');
      setTimeout(() => this.initialize(), 30000);
      return false;
    }

    logger.info(`📊 Found ${assets.length} active assets`);
    
    for (const asset of assets) {
      try {
        const simulator = new AssetSimulator(asset, this.firebase);
        await simulator.loadLastPrice();
        this.simulators.set(asset.id, simulator);
      } catch (error) {
        logger.error(`❌ Failed to init ${asset.symbol}: ${error.message}`);
      }
    }

    logger.info(`✅ ${this.simulators.size} simulators initialized`);
    return true;
  }

  async refreshAssets() {
    if (this.isPaused) return;

    try {
      const assets = await this.firebase.getAssets();
      const currentIds = new Set(this.simulators.keys());
      const newIds = new Set(assets.map(a => a.id));

      for (const id of currentIds) {
        if (!newIds.has(id)) {
          const simulator = this.simulators.get(id);
          logger.info(`🗑️ Removing: ${simulator.asset.symbol}`);
          this.simulators.delete(id);
        }
      }

      for (const asset of assets) {
        if (!currentIds.has(asset.id)) {
          logger.info(`➕ New asset: ${asset.symbol}`);
          
          try {
            const simulator = new AssetSimulator(asset, this.firebase);
            await simulator.loadLastPrice();
            this.simulators.set(asset.id, simulator);
          } catch (error) {
            logger.error(`❌ Failed to add ${asset.symbol}: ${error.message}`);
          }
        } else {
          const simulator = this.simulators.get(asset.id);
          simulator.updateSettings(asset);
        }
      }

      logger.debug(`🔄 Assets refreshed: ${this.simulators.size} active`);
    } catch (error) {
      logger.error(`❌ Refresh error: ${error.message}`);
    }
  }

  async updateAllPrices() {
    if (this.simulators.size === 0 || this.isPaused) return;

    const promises = [];
    for (const simulator of this.simulators.values()) {
      promises.push(simulator.updatePrice());
    }

    await Promise.allSettled(promises);
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      const stats = this.firebase.getStats();
      
      if (!stats.connection.isConnected) {
        logger.warn('⚠️ Firebase disconnected, pausing updates...');
        this.isPaused = true;
      } else if (this.isPaused) {
        logger.info('✅ Firebase reconnected, resuming updates...');
        this.isPaused = false;
      }
      
      const timeSinceLastSuccess = Date.now() - this.firebase.writeStats.lastSuccessTime;
      if (timeSinceLastSuccess > 60000 && this.firebase.writeStats.success > 0) {
        logger.warn(`⚠️ No successful writes in ${Math.floor(timeSinceLastSuccess / 1000)}s`);
      }
      
      if (stats.billing.estimatedDailyTransfer && 
          parseFloat(stats.billing.estimatedDailyTransfer) > 300) {
        logger.error('❌ Daily transfer limit exceeded! Pausing...');
        this.isPaused = true;
      }
      
    }, 30000); // Every 30 seconds
  }

  async start() {
    if (this.isRunning) {
      logger.warn('⚠️ Manager already running');
      return;
    }

    const initialized = await this.initialize();
    
    if (!initialized || this.simulators.size === 0) {
      logger.warn('⚠️ No simulators started. Retrying in 30s...');
      setTimeout(() => this.start(), 30000);
      return;
    }

    this.isRunning = true;

    logger.info('');
    logger.info('🚀 ================================================');
    logger.info('🚀 MULTI-ASSET SIMULATOR v9.0 - SELF-HEALING');
    logger.info('🚀 ================================================');
    logger.info('🚀 ✅ Auto-Reconnect on Write Failure');
    logger.info('🚀 ✅ Stale Connection Detection (2min)');
    logger.info('🚀 ✅ Aggressive Error Recovery');
    logger.info('🚀 ✅ Independent from Backend');
    logger.info('🚀 ================================================');
    logger.info(`🌐 Timezone: Asia/Jakarta (WIB = UTC+7)`);
    logger.info(`⏰ Current: ${TimezoneUtil.formatDateTime()}`);
    logger.info(`📊 Assets: ${this.simulators.size}`);
    logger.info('⏱️ Update: 1 second (real-time)');
    logger.info('🔄 Refresh: 10 minutes');
    logger.info('💊 Health Check: 15 seconds');
    logger.info('🚀 ================================================');
    logger.info('');

    this.updateInterval = setInterval(async () => {
      await this.updateAllPrices();
    }, 1000);

    this.settingsRefreshInterval = setInterval(async () => {
      await this.refreshAssets();
    }, 600000);

    this.statsInterval = setInterval(() => {
      this.logStats();
    }, 60000);

    this.startHealthCheck();

    logger.info('✅ All systems running!');
    logger.info('');
    logger.info('💡 Self-Healing Features:');
    logger.info('   • Auto-detect stale connection (2min)');
    logger.info('   • Force reconnect on write failure');
    logger.info('   • Aggressive error recovery (3 errors)');
    logger.info('   • Independent Firebase connection');
    logger.info('');
    logger.info('Press Ctrl+C for graceful shutdown');
    logger.info('');
  }

  logStats() {
    const stats = this.firebase.getStats();
    
    logger.info('');
    logger.info(`📊 ================================================`);
    logger.info(`📊 STATUS REPORT - v9.0 SELF-HEALING`);
    logger.info(`📊 ================================================`);
    logger.info(`   Simulators: ${this.simulators.size}`);
    logger.info(`   Status: ${this.isPaused ? '⸫ PAUSED' : '▶️ RUNNING'}`);
    logger.info(`   Connection: ${stats.connection.isConnected ? '✅ OK' : '❌ DOWN'}`);
    logger.info(`   Heartbeat: ${stats.connection.lastHeartbeat}`);
    logger.info(`   Errors: ${stats.connection.consecutiveErrors}`);
    logger.info(`   Last Write: ${stats.connection.timeSinceLastWrite}`); // ✅ NEW
    logger.info('');
    logger.info(`   Writes Success: ${stats.writes.success}`);
    logger.info(`   Writes Failed: ${stats.writes.failed}`);
    logger.info(`   Success Rate: ${stats.writes.successRate}%`);
    logger.info(`   Queue Size: ${stats.writes.queued}`);
    logger.info(`   Last Success: ${stats.writes.lastSuccess}`);
    logger.info('');
    logger.info(`   💰 Firestore Reads: ${stats.billing.firestoreReads}`);
    logger.info(`   💰 Est. Daily Transfer: ${stats.billing.estimatedDailyTransfer}`);
    logger.info(`   💰 Status: ${stats.billing.status}`);
    logger.info(`📊 ================================================`);
    logger.info('');
  }

  async stop() {
    if (!this.isRunning || this.isShuttingDown) return;

    this.isShuttingDown = true;

    logger.info('');
    logger.info('🛑 Initiating graceful shutdown...');
    
    this.isRunning = false;

    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.settingsRefreshInterval) clearInterval(this.settingsRefreshInterval);
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    logger.info('📊 Final Statistics:');
    this.logStats();
    
    await this.firebase.shutdown();
    
    logger.info('✅ Graceful shutdown complete');
    
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('');
  console.log('🌐 ================================================');
  console.log('🌐 MULTI-ASSET SIMULATOR v9.0 - SELF-HEALING');
  console.log('🌐 ================================================');
  console.log(`🌐 Process TZ: ${process.env.TZ}`);
  console.log(`🌐 Current Time: ${TimezoneUtil.formatDateTime()}`);
  console.log('🌐 ================================================');
  console.log('');

  const firebaseManager = new FirebaseManager();
  const manager = new MultiAssetManager(firebaseManager);
  
  const shutdownHandler = async () => {
    await manager.stop();
  };
  
  process.on('SIGINT', shutdownHandler);
  process.on('SIGTERM', shutdownHandler);
  process.on('SIGUSR2', shutdownHandler);
  
  process.on('uncaughtException', (error) => {
    logger.error(`💥 Uncaught Exception: ${error.message}`);
    logger.error(error.stack);
    logger.warn('⚠️ Attempting to continue...');
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`💥 Unhandled Rejection: ${reason}`);
    logger.warn('⚠️ Continuing after unhandled rejection...');
  });
  
  setInterval(() => {
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
    
    if (heapUsedMB > 250) {
      logger.warn(`⚠️ High memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB`);
      
      if (global.gc) {
        logger.info('🗑️ Running garbage collection...');
        global.gc();
      }
    }
  }, 300000);

  try {
    const initialized = await firebaseManager.initialize();
    
    if (!initialized) {
      logger.error('❌ Firebase initialization failed');
      process.exit(1);
    }
    
    await manager.start();
    
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

main();