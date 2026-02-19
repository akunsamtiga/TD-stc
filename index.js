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
      '1s': 0.002778,
      '1m': 0.166667,
      '5m': 0.833333,
      '15m': 2.5,
      '30m': 5,
      '1h': 10,
      '4h': 40,
      '1d': 240,
    };
    
    this.lastCleanupTime = 0;
    this.CLEANUP_INTERVAL = 300000; // [OPT] 5 menit (dari 60s) — hemat 5x download cleanup
    this.firestoreReadCount = 0;
    this.realtimeWriteCount = 0;
    this.lastReadReset = Date.now();
    this.lastHeartbeat = Date.now();
    this.heartbeatInterval = null;
    this.consecutiveErrors = 0;
    this.MAX_CONSECUTIVE_ERRORS = 5;
    
    // Registry simulator untuk in-memory cleanup tracking
    this.simulatorRegistry = null; // diset oleh MultiAssetManager
    
    // [FIX] Add cleanup throttling to prevent stack overflow
    this.isCleaningUp = false;
    this.cleanupQueue = [];
    this.lastCleanupAttempt = 0;
    this.CLEANUP_THROTTLE_MS = 100;
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
      // [OPT] Kalau ada write sukses dalam 2 menit terakhir, koneksi pasti ok
      // Tidak perlu baca RTDB → hemat download
      const timeSinceWrite = Date.now() - this.writeStats.lastSuccessTime;
      if (timeSinceWrite < 120000 && this.writeStats.success > 0) {
        this.lastHeartbeat = Date.now();
        this.consecutiveErrors = 0;
        logger.debug('Heartbeat: skipped (recent write confirms connection)');
        return;
      }
      // Baca RTDB hanya jika tidak ada write dalam 2 menit terakhir
      try {
        await this.realtimeDbAdmin.ref('/.info/connected').once('value');
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

  async getRealtimeDbValue(path) {
    if (!this.isConnected) {
      return null;
    }

    try {
      const snapshot = await this.realtimeDbAdmin.ref(path).once('value');
      return snapshot.val();
    } catch (error) {
      logger.debug(`Failed to get value at ${path}: ${error.message}`);
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

  // [FIX] Tambahkan deleteRealtimeValue untuk cleanup expired trends
  async deleteRealtimeValue(path) {
    if (!this.isConnected) {
      return false;
    }
    try {
      await this.realtimeDbAdmin.ref(path).remove();
      return true;
    } catch (error) {
      logger.debug(`Failed to delete value at ${path}: ${error.message}`);
      return false;
    }
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

      // [FIX] Prevent concurrent cleanup operations
      if (this.isCleaningUp) {
        logger.debug('Cleanup already in progress, skipping...');
        return;
      }

      logger.info('Starting automatic cleanup');
      
      try {
        this.isCleaningUp = true;
        const assets = await this.getAssets();
        
        for (const asset of assets) {
          await new Promise(resolve => setTimeout(resolve, 200));
          // [OPT] Teruskan simulator instance agar cleanup bisa pakai in-memory tracking
          const simulator = this.simulatorRegistry ? this.simulatorRegistry.get(asset.id) : null;
          await this.cleanupAsset(asset, simulator);
        }

        this.lastCleanupTime = now;
        logger.info('Cleanup completed');
        
      } catch (error) {
        logger.error(`Cleanup error: ${error.message}`);
      } finally {
        this.isCleaningUp = false;
      }
    }, this.CLEANUP_INTERVAL);
  }

  async listenForNewAssets(onNewAsset) {
    if (!this.isConnected || !this.db) {
      logger.warn('Firebase not connected, cannot listen for new assets');
      return;
    }

    try {
      logger.info('Setting up Firestore listener for new assets...');
      
      this.db.collection('assets')
        .where('isActive', '==', true)
        .where('category', '==', 'normal')
        .onSnapshot(snapshot => {
          snapshot.docChanges().forEach(change => {
            if (change.type === 'added') {
              const asset = change.doc.data();
              logger.info(`🔥 Firestore: New asset detected ${asset.symbol}`);
              onNewAsset({ id: change.doc.id, ...asset });
            }
          });
        });
        
      logger.info('Firestore listener active for new assets');
    } catch (error) {
      logger.error(`Failed to setup Firestore listener: ${error.message}`);
    }
  }

  // [OPT] cleanupAsset — in-memory tracking utama, fallback shallow REST
  // SEBELUM: limitToFirst(1000) = download ~300KB per TF per aset, 8 TF x 10 aset x 1440/min = 3.5GB/hari
  // SESUDAH: 0 download (in-memory) atau ~2KB/TF (shallow keys only = hemat 98%)
  async cleanupAsset(asset, simulator = null) {
    const path = this.getAssetPath(asset);
    
    const timeframes = [
      { tf: '1s',  retentionSeconds: Math.floor(this.RETENTION_DAYS['1s']  * 86400) },
      { tf: '1m',  retentionSeconds: Math.floor(this.RETENTION_DAYS['1m']  * 86400) },
      { tf: '5m',  retentionSeconds: Math.floor(this.RETENTION_DAYS['5m']  * 86400) },
      { tf: '15m', retentionSeconds: Math.floor(this.RETENTION_DAYS['15m'] * 86400) },
      { tf: '30m', retentionSeconds: Math.floor(this.RETENTION_DAYS['30m'] * 86400) },
      { tf: '1h',  retentionSeconds: Math.floor(this.RETENTION_DAYS['1h']  * 86400) },
      { tf: '4h',  retentionSeconds: Math.floor(this.RETENTION_DAYS['4h']  * 86400) },
      { tf: '1d',  retentionSeconds: Math.floor(this.RETENTION_DAYS['1d']  * 86400) },
    ];
    
    for (const { tf, retentionSeconds } of timeframes) {
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const now = TimezoneUtil.getCurrentTimestamp();
      const cutoff = now - retentionSeconds;
      const fullPath = `${path}/ohlc_${tf}`;
      
      try {
        let keysToDelete = [];

        if (simulator && simulator.writtenTimestamps && simulator.writtenTimestamps[tf]) {
          // [OPT] Path 1: dari in-memory tracking → 0 RTDB read sama sekali
          keysToDelete = simulator.getExpiredTimestamps(tf, retentionSeconds).map(String);
          if (keysToDelete.length > 0) {
            logger.debug(`Cleanup ${asset.symbol} ${tf}: in-memory (${keysToDelete.length} expired)`);
          }
        } else {
          // [OPT] Path 2 fallback: Shallow REST → keys only, bukan nilai penuh
          // ~15 byte/key vs ~300 byte/bar penuh = hemat 95%
          keysToDelete = await this.getShallowExpiredKeys(fullPath, cutoff);
          if (keysToDelete.length > 0) {
            logger.debug(`Cleanup ${asset.symbol} ${tf}: shallow fallback (${keysToDelete.length} expired)`);
          }
        }
        
        if (keysToDelete.length === 0) continue;
        
        // Satu batch update = 1 write operation, bukan N write
        const updates = {};
        keysToDelete.forEach(key => { updates[key] = null; });
        await this.realtimeDbAdmin.ref(fullPath).update(updates);
        
        logger.info(`Cleanup ${asset.symbol} ${tf}: ${keysToDelete.length} bars deleted`);
        
      } catch (error) {
        logger.error(`Cleanup error for ${asset.symbol} ${tf}: ${error.message}`);
      }
    }
  }

  // [OPT] Shallow read: ambil keys saja via Firebase REST API (?shallow=true)
  // Response: { "1735000001": true, "1735000002": true, ... } — hanya keys!
  async getShallowExpiredKeys(fullPath, cutoffTimestamp) {
    try {
      const dbUrl = process.env.FIREBASE_REALTIME_DB_URL;
      if (!dbUrl) return [];

      const tokenResult = await this.realtimeDbAdmin.app.options.credential?.getAccessToken?.();
      if (!tokenResult?.access_token) {
        logger.debug('getShallowExpiredKeys: no access token, skipping');
        return [];
      }

      const cleanPath = fullPath.startsWith('/') ? fullPath.slice(1) : fullPath;
      const url = `${dbUrl.replace(/\/$/, '')}/${cleanPath}.json?shallow=true&access_token=${tokenResult.access_token}`;

      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return [];

      const data = await response.json();
      if (!data || typeof data !== 'object') return [];

      return Object.keys(data).filter(k => parseInt(k) < cutoffTimestamp);
    } catch (error) {
      logger.debug(`Shallow read failed for ${fullPath}: ${error.message}`);
      return [];
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
    
    this.originalVolatilityMin = this.volatilityMin;
    this.originalVolatilityMax = this.volatilityMax;
    
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
    this.scheduledTrend = null;

    // [FIX] Improved stuck detection with higher threshold
    this.stuckCounter = 0;
    this.lastPriceForStuckCheck = this.currentPrice;
    this.STUCK_THRESHOLD = 10; // [FIX] Increased from 5 to 10
    this.stuckBoostActive = false;
    this.stuckBoostEndTime = 0;
    
    // [FIX] Add cooldown for stuck detection logging
    this.lastStuckLogTime = 0;
    this.STUCK_LOG_COOLDOWN = 30000; // 30 seconds

    // [OPT] Track timestamps yang ditulis ke RTDB per timeframe
    // Digunakan oleh FirebaseManager.cleanupAsset() agar tidak perlu baca RTDB saat cleanup
    this.writtenTimestamps = {
      '1s': [], '1m': [], '5m': [], '15m': [],
      '30m': [], '1h': [], '4h': [], '1d': []
    };
    this.MAX_TRACKED_TIMESTAMPS = 1500;

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
          this.lastPriceForStuckCheck = this.currentPrice;
          
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
    // Reset stuck boost if time expired
    if (this.stuckBoostActive && Date.now() > this.stuckBoostEndTime) {
      this.volatilityMin = this.originalVolatilityMin;
      this.volatilityMax = this.originalVolatilityMax;
      this.stuckBoostActive = false;
      logger.debug(`[${this.asset.symbol}] Stuck boost ended, volatility normalized`);
    }

    if (this.scheduledTrend) {
      const now = Date.now();
      
      if (now >= this.scheduledTrend.startTime && now <= this.scheduledTrend.endTime) {
        const volatility = this.volatilityMin + Math.random() * (this.volatilityMax - this.volatilityMin);
        
        // [FIX] Gunakan bias probabilistik seperti mode normal, bukan forced direction 100%
        // Buy trend: 80% naik, 20% turun — organik tapi tetap trending ke atas
        // Sell trend: 80% turun, 20% naik — organik tapi tetap trending ke bawah
        let trendBias;
        if (this.scheduledTrend.trend === 'buy') {
          trendBias = 0.80; // 80% peluang naik
        } else {
          trendBias = 0.20; // 20% peluang naik (= 80% turun)
        }
        
        let direction;
        if (Math.random() < trendBias) {
          direction = 1;
        } else {
          direction = -1;
        }
        // Tetap simpan lastDirection agar transisi ke normal mode mulus
        this.lastDirection = direction;
        
        // [FIX] Hapus trendVolatilityMultiplier 2.0 agar volatility sama seperti mode normal
        const priceChange = this.currentPrice * volatility * direction;
        let newPrice = this.currentPrice + priceChange;
        
        if (newPrice < this.minPrice) {
          newPrice = this.minPrice;
          logger.debug(`[${this.asset.symbol}] Scheduled trend hit min price ${this.minPrice}`);
        }
        if (newPrice > this.maxPrice) {
          newPrice = this.maxPrice;
          logger.debug(`[${this.asset.symbol}] Scheduled trend hit max price ${this.maxPrice}`);
        }
        
        return newPrice;
      } else {
        logger.info(`[${this.asset.symbol}] Scheduled trend expired, reverting to normal`);
        this.scheduledTrend = null;
      }
    }
    
    const volatility = this.volatilityMin + Math.random() * (this.volatilityMax - this.volatilityMin);
    
    let direction = Math.random() < 0.5 ? -1 : 1;
    if (Math.random() < 0.7) {
      direction = this.lastDirection;
    }
    this.lastDirection = direction;
    
    const priceChange = this.currentPrice * volatility * direction;
    let newPrice = this.currentPrice + priceChange;
    
    const priceRange = this.maxPrice - this.minPrice;
    const bounceRange = priceRange * 0.02;
    
    if (newPrice < this.minPrice) {
      newPrice = this.minPrice + Math.random() * bounceRange;
      this.lastDirection = 1;
      logger.debug(`[${this.asset.symbol}] Bounced from min: ${newPrice.toFixed(6)}`);
    }
    if (newPrice > this.maxPrice) {
      newPrice = this.maxPrice - Math.random() * bounceRange;
      this.lastDirection = -1;
      logger.debug(`[${this.asset.symbol}] Bounced from max: ${newPrice.toFixed(6)}`);
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
      
      // [FIX] Improved stuck detection with cooldown
      const priceDiff = Math.abs(this.currentPrice - this.lastPriceForStuckCheck);
      const priceDiffPercent = priceDiff / this.currentPrice;
      
      if (priceDiffPercent < 0.000001) {
        this.stuckCounter++;
        
        if (this.stuckCounter >= this.STUCK_THRESHOLD && !this.stuckBoostActive) {
          this.volatilityMin = this.originalVolatilityMin * 5;
          this.volatilityMax = this.originalVolatilityMax * 5;
          this.stuckBoostActive = true;
          this.stuckBoostEndTime = Date.now() + 5000;
          
          // [FIX] Add cooldown for logging to prevent log spam
          if (now - this.lastStuckLogTime > this.STUCK_LOG_COOLDOWN) {
            logger.info(`[${this.asset.symbol}] ⚠️ PRICE STUCK DETECTED! Boosting volatility 5x for 5s`);
            this.lastStuckLogTime = now;
          }
          
          this.stuckCounter = 0;
        }
      } else {
        this.stuckCounter = 0;
      }
      
      this.lastPriceForStuckCheck = this.currentPrice;
      
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

        // [OPT] Track timestamp yang ditulis untuk cleanup in-memory
        if (this.writtenTimestamps[tf] && !this.writtenTimestamps[tf].includes(bar.timestamp)) {
          this.writtenTimestamps[tf].push(bar.timestamp);
          if (this.writtenTimestamps[tf].length > this.MAX_TRACKED_TIMESTAMPS) {
            this.writtenTimestamps[tf] = this.writtenTimestamps[tf].slice(-this.MAX_TRACKED_TIMESTAMPS);
          }
        }
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

        // [OPT] Track completed bar timestamp juga
        if (this.writtenTimestamps[tf] && !this.writtenTimestamps[tf].includes(bar.timestamp)) {
          this.writtenTimestamps[tf].push(bar.timestamp);
          if (this.writtenTimestamps[tf].length > this.MAX_TRACKED_TIMESTAMPS) {
            this.writtenTimestamps[tf] = this.writtenTimestamps[tf].slice(-this.MAX_TRACKED_TIMESTAMPS);
          }
        }
      }

      this.currentPrice = newPrice;
      this.iteration++;

      if (now - this.lastLogTime > 30000) {
        const pricePosition = ((newPrice - this.minPrice) / (this.maxPrice - this.minPrice) * 100).toFixed(1);
        const boostIndicator = this.stuckBoostActive ? ' [BOOST]' : '';
        logger.info(
          `[${this.asset.symbol}]${boostIndicator} | ` +
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
    
    this.originalVolatilityMin = this.volatilityMin;
    this.originalVolatilityMax = this.volatilityMax;
    
    if (settings.minPrice !== undefined && settings.minPrice !== null) {
      this.minPrice = settings.minPrice;
    }
    if (settings.maxPrice !== undefined && settings.maxPrice !== null) {
      this.maxPrice = settings.maxPrice;
    }
    
    this.asset = newAsset;
    
    logger.info(`[${this.asset.symbol}] Settings updated - Range: ${this.minPrice}-${this.maxPrice}`);
  }

  applyScheduledTrend(trendData) {
    const now = Date.now();
    
    if (now < trendData.startTime || now > trendData.endTime) {
      logger.info(`[${this.asset.symbol}] Scheduled trend expired or not yet active`);
      this.scheduledTrend = null;
      return;
    }
    
    // [FIX] Cegah menimpa trend aktif yang sama (idempotent check)
    if (
      this.scheduledTrend &&
      this.scheduledTrend.scheduleId === trendData.scheduleId
    ) {
      return; // Sudah diterapkan, tidak perlu diulang
    }
    
    this.scheduledTrend = {
      trend: trendData.trend,
      timeframe: trendData.timeframe,
      startTime: trendData.startTime,
      endTime: trendData.endTime,
      scheduleId: trendData.scheduleId,
      startPrice: trendData.startPrice,
    };
    
    const remainingMs = trendData.endTime - now;
    const remainingSeconds = Math.floor(remainingMs / 1000);
    
    logger.info(`[${this.asset.symbol}] ✅ Scheduled trend applied: ${trendData.trend} (${trendData.timeframe})`);
    logger.info(`[${this.asset.symbol}] 📅 Active for ${remainingSeconds}s (until ${new Date(trendData.endTime).toLocaleTimeString()})`);
    
    setTimeout(() => {
      if (this.scheduledTrend && this.scheduledTrend.scheduleId === trendData.scheduleId) {
        logger.info(`[${this.asset.symbol}] 🏁 Scheduled trend ${trendData.trend} completed`);
        this.scheduledTrend = null;
      }
    }, remainingMs);
  }

  // [OPT] Ambil timestamps yang sudah expired untuk cleanup tanpa baca RTDB
  getExpiredTimestamps(tf, retentionSeconds) {
    if (!this.writtenTimestamps[tf]) return [];
    const cutoff = TimezoneUtil.getCurrentTimestamp() - retentionSeconds;
    const expired = this.writtenTimestamps[tf].filter(ts => ts < cutoff);
    // Hapus yang expired dari tracking memory
    this.writtenTimestamps[tf] = this.writtenTimestamps[tf].filter(ts => ts >= cutoff);
    return expired;
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
      stuckBoostActive: this.stuckBoostActive,
      stuckCounter: this.stuckCounter,
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

    // [OPT] Daftarkan simulatorRegistry ke FirebaseManager agar cleanup bisa pakai in-memory
    this.firebase.simulatorRegistry = this.simulators;

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

  async setupFirestoreListener() {
    await this.firebase.listenForNewAssets(async (asset) => {
      if (this.simulators.has(asset.id)) {
        return;
      }
      
      logger.info(`🆕 Auto-adding new asset from Firestore: ${asset.symbol}`);
      
      try {
        const simulator = new AssetSimulator(asset, this.firebase);
        await simulator.loadLastPrice();
        
        await this.initializeCandlesForAsset(asset, simulator);
        
        this.simulators.set(asset.id, simulator);
        logger.info(`✅ Asset ${asset.symbol} added and initialized with 240 candles`);
      } catch (error) {
        logger.error(`Failed to add new asset ${asset.symbol}: ${error.message}`);
      }
    });
  }

  // ============================================================
  // [FIX] setupScheduledTrendListener - PERUBAHAN UTAMA
  //
  // Struktur RTDB lama:  _scheduled_trends/{symbol}  (object tunggal)
  // Struktur RTDB baru:  _scheduled_trends/{symbol}/{scheduleId}  (nested)
  //
  // Perubahan:
  // 1. Loop dua level: symbol → scheduleId → trendData
  // 2. Cleanup otomatis: hapus trend yang sudah expired dari RTDB
  //    agar tidak menumpuk memory
  // 3. Skip trend yang belum aktif (startTime di masa depan)
  // ============================================================
  async setupScheduledTrendListener() {
    const checkTrends = async () => {
      try {
        if (!this.firebase.isConnected) return;
        
        const trendsData = await this.firebase.getRealtimeDbValue('_scheduled_trends');
        
        if (!trendsData) return;

        const now = Date.now();
        
        // [FIX] Loop dua level: assetSymbol → scheduleId → trendData
        for (const [assetSymbol, scheduleMap] of Object.entries(trendsData)) {

          // scheduleMap adalah { scheduleId: trendData, ... }
          if (typeof scheduleMap !== 'object' || scheduleMap === null) continue;

          for (const [scheduleId, trendData] of Object.entries(scheduleMap)) {

            // Validasi struktur data
            if (!trendData || typeof trendData !== 'object') continue;
            if (!trendData.isActive) continue;
            if (!trendData.startTime || !trendData.endTime) continue;

            // [FIX] Hapus expired trends dari RTDB (cleanup otomatis)
            if (now > trendData.endTime) {
              logger.debug(`🧹 Cleaning up expired trend: ${assetSymbol}/${scheduleId}`);
              const normalizedSymbol = assetSymbol.toLowerCase().replace(/[^a-z0-9]/g, '_');
              await this.firebase.deleteRealtimeValue(
                `_scheduled_trends/${normalizedSymbol}/${scheduleId}`
              );
              continue;
            }

            // [FIX] Skip trend yang belum waktunya (startTime di masa depan)
            if (now < trendData.startTime) {
              logger.debug(`⏳ Trend not yet active: ${assetSymbol}/${scheduleId} starts at ${new Date(trendData.startTime).toLocaleTimeString()}`);
              continue;
            }

            // Trend aktif: startTime <= now <= endTime
            // Cari simulator yang cocok dengan assetSymbol
            for (const [, simulator] of this.simulators.entries()) {
              const normalizedSimbol = simulator.asset.symbol.toLowerCase().replace(/[^a-z0-9]/g, '_');
              const normalizedAsset  = assetSymbol.toLowerCase().replace(/[^a-z0-9]/g, '_');

              if (normalizedSimbol === normalizedAsset) {
                logger.info(`📊 Applying trend to ${simulator.asset.symbol} [${scheduleId}]`);
                simulator.applyScheduledTrend(trendData);
              }
            }
          }
        }
      } catch (error) {
        logger.debug(`Trend poll error: ${error.message}`);
      }
    };
    
    setInterval(checkTrends, 1000);
    logger.info('Scheduled trends polling started (1s interval) - FIXED: per-scheduleId structure');
  }

  async initializeCandlesForAsset(asset, simulator) {
    const now = TimezoneUtil.getCurrentTimestamp();
    const initialPrice = simulator.initialPrice;
    
    const VOLATILITY_MULTIPLIER = 10;
    
    const originalVolatilityMax = simulator.volatilityMax;
    const originalVolatilityMin = simulator.volatilityMin;
    
    const volatilityMax = originalVolatilityMax * VOLATILITY_MULTIPLIER;
    const volatilityMin = originalVolatilityMin * VOLATILITY_MULTIPLIER;
    
    logger.info(`[${asset.symbol}] Initializing 240 candles with ${VOLATILITY_MULTIPLIER}x volatility:`);
    logger.info(`[${asset.symbol}]   Original: ${originalVolatilityMin} - ${originalVolatilityMax}`);
    logger.info(`[${asset.symbol}]   Used: ${volatilityMin} - ${volatilityMax}`);
    logger.info(`[${asset.symbol}]   Initial Price: ${initialPrice}`);
    
    const timeframes = {
      '1s': 1, '1m': 60, '5m': 300, '15m': 900, 
      '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400
    };
    
    const getVolatilityForTimeframe = (tf) => {
      if (tf === '1s' || tf === '1m') {
        return volatilityMin + Math.random() * (volatilityMax - volatilityMin);
      } else if (tf === '5m' || tf === '15m' || tf === '30m') {
        const dailyMin = volatilityMin * 10;
        const dailyMax = volatilityMax * 10;
        return ((volatilityMin + dailyMin) / 2) + Math.random() * ((volatilityMax + dailyMax) / 2 - (volatilityMin + dailyMin) / 2);
      } else {
        return (volatilityMin * 10) + Math.random() * (volatilityMax * 10 - volatilityMin * 10);
      }
    };
    
    let finalPrice = initialPrice;
    const assetPath = this.firebase.getAssetPath(asset);

    for (const [tf, duration] of Object.entries(timeframes)) {
      const candles = {};
      let price = initialPrice;
      const volatility = getVolatilityForTimeframe(tf);
      
      for (let i = 239; i >= 0; i--) {
        const timestamp = now - (i * duration);
        const open = price;
        
        const u1 = Math.random();
        const u2 = Math.random();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        const change = price * volatility * z;
        
        let close = open + change;
        close = Math.max(
          asset.simulatorSettings?.minPrice ?? initialPrice * 0.5,
          Math.min(asset.simulatorSettings?.maxPrice ?? initialPrice * 2.0, close)
        );
        
        const high = Math.max(open, close) + Math.abs(change) * Math.random() * 0.5;
        const low = Math.min(open, close) - Math.abs(change) * Math.random() * 0.5;
        
        candles[timestamp] = {
          timestamp,
          datetime: TimezoneUtil.formatDateTime(new Date(timestamp * 1000)),
          datetime_iso: new Date(timestamp * 1000).toISOString(),
          timezone: 'Asia/Jakarta',
          open: parseFloat(open.toFixed(6)),
          high: parseFloat(high.toFixed(6)),
          low: parseFloat(low.toFixed(6)),
          close: parseFloat(close.toFixed(6)),
          volume: Math.floor(1000 + Math.random() * 9000),
          isCompleted: true
        };
        
        price = close;
      }
      
      const path = `${assetPath}/ohlc_${tf}`;
      await this.firebase.setRealtimeValue(path, candles);
      
      if (tf === '1s') {
        finalPrice = price;
      }
      
      logger.debug(`[${asset.symbol}] Generated ${tf} candles, final price: ${price.toFixed(6)}`);
    }
    
    const currentPriceData = {
      price: parseFloat(finalPrice.toFixed(6)),
      current: parseFloat(finalPrice.toFixed(6)),
      timestamp: now,
      datetime: TimezoneUtil.formatDateTime(new Date(now * 1000)),
      datetime_iso: new Date(now * 1000).toISOString(),
      timezone: 'Asia/Jakarta',
      change: 0
    };
    
    await this.firebase.setRealtimeValue(
      `${assetPath}/current_price`,
      currentPriceData
    );
    
    simulator.currentPrice = finalPrice;
    simulator.isResumed = true;
    
    logger.info(`[${asset.symbol}] ✅ 240 candles generated (${VOLATILITY_MULTIPLIER}x volatility).`);
    logger.info(`[${asset.symbol}]    Current price set to: ${finalPrice.toFixed(6)} (was ${initialPrice.toFixed(6)})`);
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

    this.updateInterval = setInterval(async () => {
      await this.updateAllPrices();
    }, 1000);

    this.settingsRefreshInterval = setInterval(async () => {
      await this.refreshAssets();
    }, 600000);

    this.statsInterval = setInterval(() => {
      this.logStats();
    }, 600000);

    this.startHealthCheck();

    logger.info('');
    logger.info('MULTI-ASSET SIMULATOR v17.5 - OPTIMIZED RTDB COST');
    logger.info('================================================');
    logger.info(`Normal Assets: ${this.simulators.size}`);
    logger.info('Timezone: Asia/Jakarta (WIB = UTC+7)');
    logger.info(`Current: ${TimezoneUtil.formatDateTime()}`);
    logger.info('Update: 1 second');
    logger.info('Refresh: 10 minutes');
    logger.info('1s Retention: 10 minutes (600 detik) ✅ 240 CANDLES SAFE');
    logger.info('Cleanup: Every 5 minutes (in-memory tracking, shallow REST fallback)');
    logger.info('Stuck Detection: ENABLED (10x threshold with log cooldown)');
    logger.info('Scheduled Trend: FIXED - per-scheduleId (no overwrite)');
    logger.info('================================================');
    logger.info('');
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
        bars1s: sim.tfManager.barsCreated['1s'] || 0,
        stuckBoost: sim.stuckBoostActive ? 'BOOST' : 'OK'
      });
    }
    
    logger.info('');
    logger.info(`STATUS REPORT (10-MIN RETENTION - 240 CANDLES SAFE)`);
    logger.info(`================================================`);
    logger.info(`Normal Simulators: ${this.simulators.size}`);
    logger.info(`Status: ${this.isPaused ? 'PAUSED' : 'RUNNING'}`);
    logger.info(`Connection: ${stats.connection.isConnected ? 'OK' : 'DOWN'}`);
    logger.info(`1s Bars Created: ${total1sBars}`);
    logger.info(`1s Retention: 10 minutes (600 detik) ✅`);
    logger.info('');
    
    if (assetInfo.length > 0) {
      logger.info(`Asset Prices & Status:`);
      assetInfo.forEach(a => {
        logger.info(`${a.symbol}: ${a.price} (${a.position}% in ${a.range}) | 1s: ${a.bars1s} | ${a.stuckBoost}`);
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
    
    logger.info('Shutdown complete');
    
    this.isShuttingDown = false;
  }
}

// ============================================
// MAIN ENTRY POINT
// ============================================
async function main() {
  const firebaseManager = new FirebaseManager();
  const multiAssetManager = new MultiAssetManager(firebaseManager);

  process.on('SIGINT', async () => {
    logger.info('');
    logger.info('SIGINT received');
    await multiAssetManager.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('');
    logger.info('SIGTERM received');
    await multiAssetManager.stop();
    process.exit(0);
  });

  process.on('uncaughtException', async (error) => {
    logger.error('Uncaught Exception:', error);
    await multiAssetManager.stop();
    process.exit(1);
  });

  process.on('unhandledRejection', async (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  try {
    const initialized = await firebaseManager.initialize();
    
    if (!initialized) {
      logger.error('Failed to initialize Firebase. Exiting');
      process.exit(1);
    }

    await multiAssetManager.start();
    
    await multiAssetManager.setupFirestoreListener();
    await multiAssetManager.setupScheduledTrendListener();
    
  } catch (error) {
    logger.error('Fatal error:', error);
    await multiAssetManager.stop();
    process.exit(1);
  }
}

main();