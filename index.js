// trading-simulator/index.js
import admin from 'firebase-admin';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();
process.env.TZ = 'Asia/Jakarta';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) => {
      if (stack) return `${timestamp} - ${level.toUpperCase()} - ${message}\n${stack}`;
      return `${timestamp} - ${level.toUpperCase()} - ${message}`;
    })
  ),
  transports: [
    new transports.File({ 
      filename: 'simulator.log', 
      maxsize: 3145728,
      maxFiles: 2,
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
    
    this.RETENTION_DAYS = {
      '1s': 0.000694,
      '1m': 2,
      '5m': 2,
      '15m': 3,
      '30m': 4,
      '1h': 5,
      '4h': 7,
      '1d': 14,
    };
    
    this.lastCleanupTime = 0;
    this.CLEANUP_INTERVAL = 60000;
    this.firestoreReadCount = 0;
    this.realtimeWriteCount = 0;
    this.lastReadReset = Date.now();
    this.lastHeartbeat = Date.now();
    this.heartbeatInterval = null;
    this.consecutiveErrors = 0;
    this.MAX_CONSECUTIVE_ERRORS = 5;
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

      logger.info('Initializing Firebase');

      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          databaseURL: process.env.FIREBASE_REALTIME_DB_URL,
        });
      }

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
      
      logger.info('Firebase Admin SDK initialized');
      
      this.startQueueProcessor();
      this.startCleanupScheduler();
      this.startHeartbeat();
      
      return true;
    } catch (error) {
      logger.error(`Firebase initialization error: ${error.message}`);
      await this.handleConnectionError(error);
      return false;
    }
  }

  async testConnection() {
    try {
      await this.db.collection('_health_check').limit(1).get();
      await this.realtimeDbAdmin.ref('/.info/connected').once('value');
      logger.debug('Connection test passed');
      return true;
    } catch (error) {
      logger.error(`Connection test failed: ${error.message}`);
      throw error;
    }
  }

  async handleConnectionError(error) {
    this.isConnected = false;
    this.consecutiveErrors++;
    
    if (this.consecutiveErrors >= this.MAX_CONSECUTIVE_ERRORS) {
      throw new Error('Firebase connection critically failed');
    }

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
      
      logger.warn(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
      
      try {
        await this.initialize();
      } catch (retryError) {
        logger.error(`Reconnection failed: ${retryError.message}`);
      }
    }
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.realtimeDbAdmin.ref('/.info/serverTimeOffset').once('value');
        this.lastHeartbeat = Date.now();
        this.consecutiveErrors = 0;
      } catch (error) {
        logger.warn(`Heartbeat failed: ${error.message}`);
        this.consecutiveErrors++;
        
        if (this.consecutiveErrors >= 3) {
          await this.handleConnectionError(error);
        }
      }
    }, 60000);
  }

  async getAssets() {
    if (!this.isConnected) {
      logger.warn('Firebase not connected, skipping asset fetch');
      return [];
    }

    try {
      this.firestoreReadCount++;
      
      const snapshot = await this.db.collection('assets')
        .where('isActive', '==', true)
        .get();

      const normalAssets = [];
      const skippedAssets = {
        cryptoAssets: [],
        missingCategory: [],
        invalidDataSource: [],
        missingPath: [],
        validationErrors: []
      };

      snapshot.forEach(doc => {
        const data = doc.data();
        
        if (!data.category) {
          skippedAssets.missingCategory.push(data.symbol);
          logger.warn(`Asset ${data.symbol} missing category field, skipping`);
          return;
        }
        
        if (data.category === 'crypto') {
          skippedAssets.cryptoAssets.push({
            symbol: data.symbol,
            dataSource: data.dataSource,
            path: data.realtimeDbPath || 'auto-generated'
          });
          logger.debug(`Skipping crypto asset: ${data.symbol}`);
          return;
        }
        
        if (data.category !== 'normal') {
          skippedAssets.validationErrors.push({
            symbol: data.symbol,
            issue: `Unknown category: ${data.category}`
          });
          logger.warn(`Unknown category '${data.category}' for ${data.symbol}, skipping`);
          return;
        }
        
        const validSources = ['realtime_db', 'mock', 'api'];
        if (!validSources.includes(data.dataSource)) {
          skippedAssets.invalidDataSource.push({
            symbol: data.symbol,
            dataSource: data.dataSource,
            expected: validSources.join(', ')
          });
          logger.error(`Asset ${data.symbol} has invalid dataSource '${data.dataSource}' for simulator`);
          return;
        }
        
        if (data.dataSource === 'realtime_db' && !data.realtimeDbPath) {
          skippedAssets.missingPath.push(data.symbol);
          logger.error(`Asset ${data.symbol} with realtime_db source MUST have realtimeDbPath, skipping`);
          return;
        }
        
        if (!data.simulatorSettings) {
          logger.info(`Asset ${data.symbol} missing simulatorSettings, will use defaults`);
        }
        
        normalAssets.push({ 
          id: doc.id, 
          ...data,
          category: 'normal'
        });
      });

      if (normalAssets.length > 0) {
        logger.info('');
        logger.info(`Loaded ${normalAssets.length} normal assets for simulation`);
        normalAssets.forEach(a => {
          const pathDisplay = this.getAssetPathPreview(a);
          logger.info(`${a.symbol} (${a.dataSource}) → ${pathDisplay}`);
        });
      }

      logger.debug(`Firestore read #${this.firestoreReadCount}: ${normalAssets.length} normal assets`);

      return normalAssets;
    } catch (error) {
      logger.error(`Error fetching assets: ${error.message}`);
      this.consecutiveErrors++;
      return [];
    }
  }

  getAssetPathPreview(asset) {
    if (asset.dataSource === 'realtime_db') {
      return asset.realtimeDbPath || '[ERROR: NO PATH]';
    }
    if (asset.dataSource === 'mock') {
      return `/mock/${asset.symbol.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    }
    if (asset.dataSource === 'api') {
      return asset.apiEndpoint || '[API: NO ENDPOINT]';
    }
    return '[UNKNOWN SOURCE]';
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

  async setRealtimeValue(path, data, retries = 2) {
    if (!this.isConnected) {
      this.writeStats.failed++;
      return false;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.realtimeDbAdmin.ref(path).set(data);
        this.writeStats.success++;
        this.realtimeWriteCount++;
        this.writeStats.lastSuccessTime = Date.now();
        this.consecutiveErrors = 0;
        
        return true;
      } catch (error) {
        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        } else {
          this.writeStats.failed++;
          this.consecutiveErrors++;
          logger.error(`Write failed at ${path}: ${error.message}`);
          
          if (this.consecutiveErrors >= 3) {
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
    
    if (this.writeQueue.length > 500) {
      logger.warn(`Write queue overflow (${this.writeQueue.length}), dropping oldest entries`);
      this.writeQueue = this.writeQueue.slice(-250);
    }
  }

  async startQueueProcessor() {
    setInterval(async () => {
      if (this.isProcessingQueue || this.writeQueue.length === 0 || !this.isConnected) {
        return;
      }
      
      this.isProcessingQueue = true;
      
      const batch = this.writeQueue.splice(0, 20);
      
      await Promise.allSettled(
        batch.map(({ path, data }) => this.setRealtimeValue(path, data, 1))
      );
      
      const now = Date.now();
      this.writeQueue = this.writeQueue.filter(item => now - item.addedAt < 300000);
      
      this.isProcessingQueue = false;
    }, 500);
  }

  async startCleanupScheduler() {
    setInterval(async () => {
      const now = Date.now();
      
      if (now - this.lastCleanupTime < this.CLEANUP_INTERVAL || !this.isConnected) {
        return;
      }

      logger.info('Starting automatic cleanup');
      
      try {
        const assets = await this.getAssets();
        
        for (const asset of assets) {
          await this.cleanupAsset(asset);
        }

        this.lastCleanupTime = now;
        logger.info('Cleanup completed');
        
      } catch (error) {
        logger.error(`Cleanup error: ${error.message}`);
      }
    }, this.CLEANUP_INTERVAL);
  }

  async cleanupAsset(asset) {
  const path = this.getAssetPath(asset);
  
  const timeframes = [
    { tf: '1s', retention: this.RETENTION_DAYS['1s'], isSeconds: true },
    { tf: '1m', retention: this.RETENTION_DAYS['1m'], isSeconds: false },
    { tf: '5m', retention: this.RETENTION_DAYS['5m'], isSeconds: false },
    { tf: '15m', retention: this.RETENTION_DAYS['15m'], isSeconds: false },
    { tf: '30m', retention: this.RETENTION_DAYS['30m'], isSeconds: false },
    { tf: '1h', retention: this.RETENTION_DAYS['1h'], isSeconds: false },
    { tf: '4h', retention: this.RETENTION_DAYS['4h'], isSeconds: false },
    { tf: '1d', retention: this.RETENTION_DAYS['1d'], isSeconds: false },
  ];
  
  const BATCH_DELETE_SIZE = 100;
  const QUERY_BATCH_SIZE = 500;
  const MAX_1S_BARS = 60;
  
  for (const { tf, retention, isSeconds } of timeframes) {
    const startTime = Date.now();
    const now = TimezoneUtil.getCurrentTimestamp();
    const cutoffTimestamp = isSeconds ? now - 60 : now - (retention * 86400);
    const fullPath = `${path}/ohlc_${tf}`;
    
    logger.debug(`Starting cleanup for ${asset.symbol} ${tf} (cutoff: ${cutoffTimestamp})`);
    
    let totalDeleted = 0;
    let queryCount = 0;
    
    try {
      while (true) {
        const snapshot = await this.realtimeDbAdmin
          .ref(fullPath)
          .orderByKey()
          .limitToFirst(QUERY_BATCH_SIZE)
          .once('value');
        
        const data = snapshot.val();
        if (!data) break;
        
        const allKeys = Object.keys(data).sort((a, b) => parseInt(a) - parseInt(b));
        if (allKeys.length === 0) break;
        
        let keysToDelete = [];
        
        if (tf === '1s') {
          // ✅ TWO-PHASE CLEANUP for 1s
          // Phase 1: Time-based (older than 1 minute)
          const oldKeys = allKeys.filter(key => parseInt(key) < cutoffTimestamp);
          keysToDelete.push(...oldKeys);
          
          // Phase 2: Count-based (keep only 60 newest)
          const remaining = allKeys.filter(key => !keysToDelete.includes(key));
          if (remaining.length > MAX_1S_BARS) {
            const excessCount = remaining.length - MAX_1S_BARS;
            const oldestRemaining = remaining.slice(0, excessCount);
            keysToDelete.push(...oldestRemaining);
          }
        } else {
          // Regular time-based cleanup for other timeframes
          keysToDelete = allKeys.filter(key => parseInt(key) < cutoffTimestamp);
        }
        
        if (keysToDelete.length === 0) break;
        
        // ✅ BATCH DELETE with relative paths
        const deletePromises = [];
        for (let i = 0; i < keysToDelete.length; i += BATCH_DELETE_SIZE) {
          const batch = keysToDelete.slice(i, i + BATCH_DELETE_SIZE);
          const updates = {};
          batch.forEach(key => {
            updates[key] = null; // Relative path
          });
          deletePromises.push(
            this.realtimeDbAdmin.ref(fullPath).update(updates)
          );
        }
        
        await Promise.allSettled(deletePromises);
        totalDeleted += keysToDelete.length;
        
        queryCount++;
        
        if (totalDeleted % 1000 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          logger.info(
            `${asset.symbol} ${tf}: ${totalDeleted.toLocaleString()} bars deleted (${elapsed}s)`
          );
        }
        
        if (queryCount % 20 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (Object.keys(data).length < QUERY_BATCH_SIZE) break;
      }
      
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
      if (totalDeleted > 0) {
        logger.info(
          `Cleanup ${asset.symbol} ${tf}: ${totalDeleted.toLocaleString()} bars in ${totalTime}s`
        );
      } else {
        logger.debug(`Cleanup ${asset.symbol} ${tf}: No old data (${totalTime}s)`);
      }
      
    } catch (error) {
      logger.error(`Cleanup error for ${asset.symbol} ${tf}: ${error.message}`);
    }
  }
}

  getAssetPath(asset) {
    if (asset.dataSource === 'realtime_db') {
      if (!asset.realtimeDbPath) {
        const errorMsg = `CRITICAL: Asset ${asset.symbol} has realtime_db source but missing realtimeDbPath`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }
      
      let path = asset.realtimeDbPath.trim();
      
      if (!path.startsWith('/')) {
        path = `/${path}`;
      }
      
      if (path.endsWith('/') && path !== '/') {
        path = path.slice(0, -1);
      }
      
      if (path.includes('//')) {
        path = path.replace(/\/+/g, '/');
      }
      
      const invalidChars = /[^a-zA-Z0-9/_-]/g;
      if (invalidChars.test(path)) {
        logger.error(`Asset ${asset.symbol} path contains invalid characters: ${path}`);
        throw new Error(`Invalid characters in realtimeDbPath for ${asset.symbol}`);
      }
      
      return path;
    }
    
    if (asset.dataSource === 'mock') {
      return `/mock/${asset.symbol.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    }
    
    if (asset.dataSource === 'api' && asset.apiEndpoint) {
      let path = asset.realtimeDbPath?.trim() || `/api/${asset.symbol.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      if (!path.startsWith('/')) path = `/${path}`;
      return path;
    }
    
    const errorMsg = `Invalid dataSource for ${asset.symbol}: ${asset.dataSource}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
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
        realtimeWrites: this.realtimeWriteCount,
        estimatedDailyReads: hoursSinceReset > 0 
          ? Math.round(this.firestoreReadCount / hoursSinceReset * 24) 
          : 0,
        estimatedDailyWrites: hoursSinceReset > 0 
          ? Math.round(this.realtimeWriteCount / hoursSinceReset * 24) 
          : 0,
        timeSinceReset: `${Math.floor(hoursSinceReset)}h ${Math.floor((hoursSinceReset % 1) * 60)}m`,
      }
    };
  }

  async shutdown() {
    logger.info('Shutting down Firebase Manager');
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.writeQueue.length > 0) {
      logger.info(`Processing ${this.writeQueue.length} remaining writes`);
      
      while (this.writeQueue.length > 0) {
        const batch = this.writeQueue.splice(0, 10);
        await Promise.allSettled(
          batch.map(({ path, data }) => this.setRealtimeValue(path, data, 1))
        );
      }
    }
    
    logger.info('Firebase Manager shutdown complete');
  }
}

class TimeframeManager {
  constructor() {
    this.timeframes = {
      '1s': 1,
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

class AssetSimulator {
  constructor(asset, firebaseManager) {
    this.asset = asset;
    this.firebase = firebaseManager;
    this.tfManager = new TimeframeManager();

    const settings = asset.simulatorSettings || {};
    
    this.initialPrice = settings.initialPrice || 40.022;
    
    if (settings.minPrice !== undefined && settings.minPrice !== null) {
      this.minPrice = settings.minPrice;
    } else {
      this.minPrice = this.initialPrice * 0.5;
    }
    
    if (settings.maxPrice !== undefined && settings.maxPrice !== null) {
      this.maxPrice = settings.maxPrice;
    } else {
      this.maxPrice = this.initialPrice * 2.0;
    }
    
    this.currentPrice = this.initialPrice;
    this.volatilityMin = settings.secondVolatilityMin || 0.00001;
    this.volatilityMax = settings.secondVolatilityMax || 0.00008;
    
    this.lastDirection = 1;
    this.iteration = 0;
    this.lastLogTime = 0;
    this.isResumed = false;
    this.lastPriceData = null;
    this.consecutiveErrors = 0;
    this.MAX_ERRORS = 5;
    this.lastPriceUpdateTime = 0;
    this.PRICE_UPDATE_INTERVAL = 1000;
    this.realtimeDbPath = this.firebase.getAssetPath(asset);

    logger.info('');
    logger.info(`Simulator initialized: ${asset.symbol}`);
    logger.info(`Name: ${asset.name}`);
    logger.info(`Category: ${asset.category || 'normal'}`);
    logger.info(`DataSource: ${asset.dataSource}`);
    logger.info(`Path: ${this.realtimeDbPath}`);
    logger.info(`SETTINGS:`);
    logger.info(`Initial Price: ${this.initialPrice}`);
    logger.info(`Min Price: ${this.minPrice}`);
    logger.info(`Max Price: ${this.maxPrice}`);
    logger.info(`Range Width: ${(this.maxPrice - this.minPrice).toFixed(2)}`);
    logger.info(`Volatility: ${this.volatilityMin} - ${this.volatilityMax}`);
  }

  async loadLastPrice() {
    try {
      logger.info(`[${this.asset.symbol}] Checking last price`);
      
      const lastPriceData = await this.firebase.getLastPrice(this.realtimeDbPath);
      
      if (lastPriceData && lastPriceData.price) {
        const price = lastPriceData.price;
        
        if (price >= this.minPrice && price <= this.maxPrice) {
          this.currentPrice = price;
          this.lastPriceData = lastPriceData;
          this.isResumed = true;
          
          logger.info(`[${this.asset.symbol}] RESUMED: ${price.toFixed(6)}`);
          return true;
        } else {
          logger.warn(`[${this.asset.symbol}] Last price ${price} outside range, resetting to initial`);
        }
      }
      
      logger.info(`[${this.asset.symbol}] Starting fresh: ${this.initialPrice}`);
      return false;
    } catch (error) {
      logger.warn(`[${this.asset.symbol}] Could not load last price: ${error.message}`);
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
      logger.debug(`[${this.asset.symbol}] Hit min price ${this.minPrice}, bouncing up`);
    }
    if (newPrice > this.maxPrice) {
      newPrice = this.maxPrice;
      this.lastDirection = -1;
      logger.debug(`[${this.asset.symbol}] Hit max price ${this.maxPrice}, bouncing down`);
    }
    
    return newPrice;
  }

  async updatePrice() {
    try {
      const now = Date.now();
      
      if (now - this.lastPriceUpdateTime < this.PRICE_UPDATE_INTERVAL) {
        return;
      }
      
      this.lastPriceUpdateTime = now;
      
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
          logger.error(`[${this.asset.symbol}] Too many errors, skipping update cycle`);
          this.consecutiveErrors = 0;
          return;
        }
      } else {
        this.consecutiveErrors = 0;
      }

      for (const [tf, bar] of Object.entries(currentBars)) {
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
          isCompleted: false
        };
        
        this.firebase.setRealtimeValueAsync(
          `${this.realtimeDbPath}/ohlc_${tf}/${bar.timestamp}`,
          barData
        );
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
        
        await this.firebase.setRealtimeValue(
          `${this.realtimeDbPath}/ohlc_${tf}/${bar.timestamp}`,
          barData
        );
      }

      this.currentPrice = newPrice;
      this.iteration++;

      if (now - this.lastLogTime > 30000) {
        const pricePosition = ((newPrice - this.minPrice) / (this.maxPrice - this.minPrice) * 100).toFixed(1);
        logger.info(
          `[${this.asset.symbol}] ${this.isResumed ? '' : ''} | ` +
          `#${this.iteration}: ${newPrice.toFixed(6)} ` +
          `(${pricePosition}% in range ${this.minPrice}-${this.maxPrice})`
        );
        this.lastLogTime = now;
      }

    } catch (error) {
      this.consecutiveErrors++;
      logger.error(`[${this.asset.symbol}] Update error: ${error.message}`);
      
      if (this.consecutiveErrors >= this.MAX_ERRORS) {
        logger.error(`[${this.asset.symbol}] Critical errors, pausing`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        this.consecutiveErrors = 0;
      }
    }
  }

  updateSettings(newAsset) {
    const settings = newAsset.simulatorSettings || {};
    
    this.volatilityMin = settings.secondVolatilityMin || this.volatilityMin;
    this.volatilityMax = settings.secondVolatilityMax || this.volatilityMax;
    
    if (settings.minPrice !== undefined && settings.minPrice !== null) {
      this.minPrice = settings.minPrice;
    }
    if (settings.maxPrice !== undefined && settings.maxPrice !== null) {
      this.maxPrice = settings.maxPrice;
    }
    
    this.asset = newAsset;
    
    logger.info(`[${this.asset.symbol}] Settings updated - Range: ${this.minPrice}-${this.maxPrice}`);
  }

  getInfo() {
    return {
      symbol: this.asset.symbol,
      name: this.asset.name,
      category: this.asset.category || 'normal',
      dataSource: this.asset.dataSource,
      currentPrice: this.currentPrice,
      minPrice: this.minPrice,
      maxPrice: this.maxPrice,
      priceRange: this.maxPrice - this.minPrice,
      iteration: this.iteration,
      isResumed: this.isResumed,
      path: this.realtimeDbPath,
      consecutiveErrors: this.consecutiveErrors,
    };
  }
}

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
    logger.info('Initializing Multi-Asset Manager');
    
    const assets = await this.firebase.getAssets();
    
    if (assets.length === 0) {
      logger.error('NO ACTIVE NORMAL ASSETS FOUND. Simulator shutting down');
      logger.error('To start simulator, add normal assets with category: normal and isActive: true');
      logger.error('Example dataSource: realtime_db, mock, or api');
      
      await this.stop();
      setTimeout(() => process.exit(0), 1000);
      return false;
    }

    logger.info(`Found ${assets.length} active normal assets`);
    
    for (const asset of assets) {
      try {
        const simulator = new AssetSimulator(asset, this.firebase);
        await simulator.loadLastPrice();
        this.simulators.set(asset.id, simulator);
      } catch (error) {
        logger.error(`Failed to init ${asset.symbol}: ${error.message}`);
      }
    }

    logger.info(`${this.simulators.size} simulators initialized`);
    logger.info('Crypto assets: Backend Binance API');
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
          logger.info(`Removing: ${simulator.asset.symbol}`);
          this.simulators.delete(id);
        }
      }

      for (const asset of assets) {
        if (!currentIds.has(asset.id)) {
          logger.info(`New asset: ${asset.symbol}`);
          
          try {
            const simulator = new AssetSimulator(asset, this.firebase);
            await simulator.loadLastPrice();
            this.simulators.set(asset.id, simulator);
          } catch (error) {
            logger.error(`Failed to add ${asset.symbol}: ${error.message}`);
          }
        } else {
          const simulator = this.simulators.get(asset.id);
          simulator.updateSettings(asset);
        }
      }

      logger.debug(`Assets refreshed: ${this.simulators.size} active`);
    } catch (error) {
      logger.error(`Refresh error: ${error.message}`);
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
        logger.warn('Firebase disconnected, pausing updates');
        this.isPaused = true;
      } else if (this.isPaused) {
        logger.info('Firebase reconnected, resuming updates');
        this.isPaused = false;
      }
      
      const timeSinceLastSuccess = Date.now() - this.firebase.writeStats.lastSuccessTime;
      if (timeSinceLastSuccess > 120000 && this.firebase.writeStats.success > 0) {
        logger.warn(`No successful writes in ${Math.floor(timeSinceLastSuccess / 1000)}s`);
      }
      
    }, 120000);
  }

  async start() {
    if (this.isRunning) {
      logger.warn('Manager already running');
      return;
    }

    const initialized = await this.initialize();
    
    if (!initialized || this.simulators.size === 0) {
      logger.error('Failed to start simulators. Exiting');
      await this.stop();
      setTimeout(() => process.exit(1), 1000);
      return;
    }

    this.isRunning = true;

    logger.info('');
    logger.info('MULTI-ASSET SIMULATOR v15.0');
    logger.info('================================================');
    logger.info(`Normal Assets: ${this.simulators.size}`);
    logger.info(`Timezone: Asia/Jakarta (WIB = UTC+7)`);
    logger.info(`Current: ${TimezoneUtil.formatDateTime()}`);
    logger.info(`Update: 1 second`);
    logger.info(`Refresh: 10 minutes`);
    logger.info(`1s Retention: 60 bars (1 minute)`);
    logger.info(`Cleanup: Every 2 hours`);
    logger.info('================================================');
    logger.info('');

    this.updateInterval = setInterval(async () => {
      await this.updateAllPrices();
    }, 1000);

    this.settingsRefreshInterval = setInterval(async () => {
      await this.refreshAssets();
    }, 600000);

    this.statsInterval = setInterval(() => {
      this.logStats();
    }, 120000);

    this.startHealthCheck();

    logger.info('All systems running');
  }

  logStats() {
    const stats = this.firebase.getStats();
    
    let total1sBars = 0;
    const assetInfo = [];
    
    for (const sim of this.simulators.values()) {
      total1sBars += sim.tfManager.barsCreated['1s'] || 0;
      assetInfo.push({
        symbol: sim.asset.symbol,
        price: sim.currentPrice.toFixed(6),
        range: `${sim.minPrice}-${sim.maxPrice}`,
        position: ((sim.currentPrice - sim.minPrice) / (sim.maxPrice - sim.minPrice) * 100).toFixed(1),
        bars1s: sim.tfManager.barsCreated['1s'] || 0
      });
    }
    
    logger.info('');
    logger.info(`STATUS REPORT (1s TIMEFRAME - 60 BAR RETENTION)`);
    logger.info(`================================================`);
    logger.info(`Normal Simulators: ${this.simulators.size}`);
    logger.info(`Status: ${this.isPaused ? 'PAUSED' : 'RUNNING'}`);
    logger.info(`Connection: ${stats.connection.isConnected ? 'OK' : 'DOWN'}`);
    logger.info(`1s Bars Created: ${total1sBars}`);
    logger.info('');
    
    if (assetInfo.length > 0) {
      logger.info(`Asset Prices & 1s Bars:`);
      assetInfo.forEach(a => {
        logger.info(`${a.symbol}: ${a.price} (${a.position}% in ${a.range}) | 1s: ${a.bars1s}`);
      });
      logger.info('');
    }
    
    logger.info(`Writes Success: ${stats.writes.success}`);
    logger.info(`Writes Failed: ${stats.writes.failed}`);
    logger.info(`Success Rate: ${stats.writes.successRate}%`);
    logger.info(`Queue Size: ${stats.writes.queued}`);
    logger.info('');
    logger.info(`Firestore Reads: ${stats.billing.firestoreReads}`);
    logger.info(`Est. Daily Reads: ${stats.billing.estimatedDailyReads}`);
    logger.info(`Realtime Writes: ${stats.billing.realtimeWrites}`);
    logger.info(`Est. Daily Writes: ${stats.billing.estimatedDailyWrites}`);
    logger.info(`================================================`);
    logger.info('');
  }

  async stop() {
    if (!this.isRunning || this.isShuttingDown) return;

    this.isShuttingDown = true;

    logger.info('');
    logger.info('Initiating graceful shutdown');
    
    this.isRunning = false;

    if (this.updateInterval) clearInterval(this.updateInterval);
    if (this.settingsRefreshInterval) clearInterval(this.settingsRefreshInterval);
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    logger.info('Final Statistics:');
    this.logStats();
    
    await this.firebase.shutdown();
    
    logger.info('Graceful shutdown complete');
    
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  }
}

async function main() {
  console.log('');
  console.log('MULTI-ASSET SIMULATOR v16.0 - 1S TIMEFRAME ENABLED');
  console.log(`Process TZ: ${process.env.TZ}`);
  console.log(`Current Time: ${TimezoneUtil.formatDateTime()}`);
  console.log('1-SECOND TRADING: ENABLED');
  console.log('1s Retention: 60 bars (1 minute)');
  console.log('Crypto: Backend Binance API');
  console.log('Normal: This Simulator');
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
    logger.error(`Uncaught Exception: ${error.message}`);
    logger.error(error.stack);
  });
  
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
  });
  
  setInterval(() => {
    const usage = process.memoryUsage();
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
    
    if (heapUsedMB > 300) {
      logger.warn(`High memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB`);
      
      if (global.gc) {
        logger.info('Running garbage collection');
        global.gc();
      }
    }
  }, 300000);

  try {
    const initialized = await firebaseManager.initialize();
    
    if (!initialized) {
      logger.error('Firebase initialization failed');
      process.exit(1);
    }
    
    await manager.start();
    
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

main();