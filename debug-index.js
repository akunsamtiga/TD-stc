// ============================================
// MULTI-ASSET TRADING SIMULATOR v3.0 - DEBUG VERSION
// ============================================
// Enhanced error logging for troubleshooting
// ============================================

import admin from 'firebase-admin';
import axios from 'axios';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();

// Set timezone
process.env.TZ = 'Asia/Jakarta';

// ============================================
// LOGGER CONFIGURATION - ENHANCED
// ============================================
const logger = createLogger({
  level: 'debug',  // Changed to debug
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(({ timestamp, level, message }) => {
      return `${timestamp} - ${level.toUpperCase()} - ${message}`;
    })
  ),
  transports: [
    new transports.File({ 
      filename: 'simulator-debug.log',
      maxsize: 5242880,
      maxFiles: 3,
      tailable: true
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
// FIREBASE INITIALIZATION - ENHANCED
// ============================================
class FirebaseManager {
  constructor() {
    this.db = null;
    this.realtimeDb = null;
    this.restClient = null;
    this.useREST = false;
  }

  async initialize() {
    try {
      logger.info('🔧 Initializing Firebase...');
      
      // Validate environment variables
      const requiredVars = [
        'FIREBASE_PROJECT_ID',
        'FIREBASE_PRIVATE_KEY',
        'FIREBASE_CLIENT_EMAIL',
        'FIREBASE_REALTIME_DB_URL'
      ];

      for (const varName of requiredVars) {
        if (!process.env[varName]) {
          throw new Error(`Missing required environment variable: ${varName}`);
        }
      }

      logger.debug(`Project ID: ${process.env.FIREBASE_PROJECT_ID}`);
      logger.debug(`Client Email: ${process.env.FIREBASE_CLIENT_EMAIL}`);
      logger.debug(`Realtime DB URL: ${process.env.FIREBASE_REALTIME_DB_URL}`);

      const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      };

      // Validate private key format
      if (!serviceAccount.privateKey.includes('BEGIN PRIVATE KEY')) {
        throw new Error('Invalid private key format');
      }

      logger.debug('✅ Service account credentials validated');

      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert(serviceAccount),
          databaseURL: process.env.FIREBASE_REALTIME_DB_URL,
        });
        logger.debug('✅ Firebase Admin SDK initialized');
      }

      this.db = admin.firestore();
      logger.debug('✅ Firestore instance created');

      // Try Admin SDK first
      try {
        logger.info('🔄 Testing Admin SDK connection...');
        this.realtimeDb = admin.database();
        
        // Test write
        const testRef = this.realtimeDb.ref('_test/connection');
        await testRef.set({
          status: 'connected',
          timestamp: Date.now(),
          method: 'admin-sdk'
        });
        
        logger.info('✅ Admin SDK connection successful!');
        this.useREST = false;
        
        // Clean up test
        await testRef.remove();
        
      } catch (sdkError) {
        logger.warn(`⚠️ Admin SDK failed: ${sdkError.message}`);
        logger.info('🔄 Falling back to REST API...');
        
        // Try REST API
        const baseURL = process.env.FIREBASE_REALTIME_DB_URL.replace(/\/$/, '');
        this.restClient = axios.create({
          baseURL,
          timeout: 10000,
          headers: { 
            'Content-Type': 'application/json'
          }
        });

        // Test REST connection
        try {
          const testData = {
            status: 'connected',
            timestamp: Date.now(),
            method: 'rest-api'
          };
          
          logger.debug(`Testing REST write to: ${baseURL}/_test/connection.json`);
          const response = await this.restClient.put('/_test/connection.json', testData);
          
          logger.debug(`REST Response Status: ${response.status}`);
          logger.debug(`REST Response Data: ${JSON.stringify(response.data)}`);
          
          logger.info('✅ REST API connection successful!');
          this.useREST = true;
          
          // Clean up test
          await this.restClient.delete('/_test/connection.json');
          
        } catch (restError) {
          logger.error(`❌ REST API failed: ${restError.message}`);
          if (restError.response) {
            logger.error(`   Status: ${restError.response.status}`);
            logger.error(`   Data: ${JSON.stringify(restError.response.data)}`);
          }
          throw new Error('Both Admin SDK and REST API failed');
        }
      }

      logger.info(`✅ Firebase initialized successfully (using ${this.useREST ? 'REST API' : 'Admin SDK'})`);
      return true;
      
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
      throw error;
    }
  }

  async getAssets() {
    try {
      logger.debug('📊 Fetching assets from Firestore...');
      
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
          logger.debug(`   Found: ${data.symbol} (${data.dataSource})`);
        }
      });

      logger.info(`✅ Found ${assets.length} active assets for simulation`);
      return assets;
      
    } catch (error) {
      logger.error(`❌ Error fetching assets: ${error.message}`);
      return [];
    }
  }

  async setRealtimeValue(path, data) {
    try {
      logger.debug(`📝 Writing to: ${path}`);
      logger.debug(`   Data: ${JSON.stringify(data).substring(0, 100)}...`);
      
      if (this.useREST) {
        // Use REST API
        const url = `${path}.json`;
        logger.debug(`   Using REST: PUT ${url}`);
        
        const response = await this.restClient.put(url, data);
        
        logger.debug(`   ✅ REST write successful (status: ${response.status})`);
        
      } else {
        // Use Admin SDK
        logger.debug(`   Using Admin SDK`);
        
        await this.realtimeDb.ref(path).set(data);
        
        logger.debug(`   ✅ Admin SDK write successful`);
      }
      
    } catch (error) {
      logger.error(`❌ Error setting realtime value at ${path}`);
      logger.error(`   Error message: ${error.message}`);
      
      if (error.response) {
        logger.error(`   Response status: ${error.response.status}`);
        logger.error(`   Response data: ${JSON.stringify(error.response.data)}`);
      }
      
      if (error.code) {
        logger.error(`   Error code: ${error.code}`);
      }
      
      throw error;
    }
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
    this.successfulWrites = 0;
    this.failedWrites = 0;

    if (asset.dataSource === 'realtime_db') {
      this.realtimeDbPath = asset.realtimeDbPath;
    } else {
      this.realtimeDbPath = `/mock/${asset.symbol.toLowerCase()}`;
    }

    logger.info(`✅ Simulator initialized for ${asset.symbol}`);
    logger.debug(`   Initial Price: ${this.initialPrice}`);
    logger.debug(`   Volatility: ${this.volatilityMin} - ${this.volatilityMax}`);
    logger.debug(`   Price Range: ${this.minPrice} - ${this.maxPrice}`);
    logger.debug(`   Path: ${this.realtimeDbPath}`);
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

      const currentPriceData = {
        price: parseFloat(newPrice.toFixed(6)),
        timestamp: timestamp,
        datetime: dateTimeInfo.datetime,
        datetime_iso: dateTimeInfo.datetime_iso,
        timezone: 'Asia/Jakarta',
        change: parseFloat(((newPrice - this.initialPrice) / this.initialPrice * 100).toFixed(2)),
      };
      
      logger.debug(`[${this.asset.symbol}] Writing current price: ${newPrice.toFixed(6)}`);
      
      await this.firebase.setRealtimeValue(
        `${this.realtimeDbPath}/current_price`,
        currentPriceData
      );
      
      this.successfulWrites++;

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
        
        logger.debug(`[${this.asset.symbol}] Writing ${tf} bar`);
        
        await this.firebase.setRealtimeValue(
          `${this.realtimeDbPath}/ohlc_${tf}/${bar.timestamp}`,
          barData
        );
      }

      this.currentPrice = newPrice;
      this.iteration++;

      if (Object.keys(completedBars).length > 0) {
        const completedTfs = Object.keys(completedBars).join(', ');
        logger.info(`[${this.asset.symbol}] ✅ Completed: ${completedTfs} | Price: ${newPrice.toFixed(6)} | Success: ${this.successfulWrites}`);
      }

    } catch (error) {
      this.failedWrites++;
      logger.error(`[${this.asset.symbol}] ❌ Update error: ${error.message}`);
      logger.error(`   Failed writes: ${this.failedWrites} / Total attempts: ${this.iteration}`);
    }
  }

  updateSettings(newAsset) {
    const settings = newAsset.simulatorSettings || {};
    
    this.volatilityMin = settings.secondVolatilityMin || this.volatilityMin;
    this.volatilityMax = settings.secondVolatilityMax || this.volatilityMax;
    this.minPrice = settings.minPrice || this.minPrice;
    this.maxPrice = settings.maxPrice || this.maxPrice;

    logger.debug(`[${this.asset.symbol}] Settings updated`);
    
    this.asset = newAsset;
  }

  getStats() {
    return {
      symbol: this.asset.symbol,
      iteration: this.iteration,
      successfulWrites: this.successfulWrites,
      failedWrites: this.failedWrites,
      successRate: this.iteration > 0 
        ? Math.round((this.successfulWrites / this.iteration) * 100) 
        : 0
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
    logger.info('🎯 Initializing Multi-Asset Manager...');
    
    const assets = await this.firebase.getAssets();
    
    if (assets.length === 0) {
      logger.warn('⚠️ No active assets found. Waiting...');
      return;
    }

    logger.info(`📊 Found ${assets.length} active assets`);
    
    for (const asset of assets) {
      const simulator = new AssetSimulator(asset, this.firebase);
      this.simulators.set(asset.id, simulator);
    }

    logger.info(`✅ ${this.simulators.size} simulators initialized`);
  }

  async refreshAssets() {
    try {
      logger.debug('🔄 Refreshing assets...');
      
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
          this.simulators.set(asset.id, simulator);
        } else {
          const simulator = this.simulators.get(asset.id);
          simulator.updateSettings(asset);
        }
      }

      logger.debug(`✅ Assets refreshed: ${this.simulators.size} active`);
    } catch (error) {
      logger.error(`❌ Error refreshing assets: ${error.message}`);
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

  printStats() {
    logger.info('');
    logger.info('📊 ================================================');
    logger.info('📊 SIMULATOR STATISTICS');
    logger.info('📊 ================================================');
    
    for (const simulator of this.simulators.values()) {
      const stats = simulator.getStats();
      logger.info(`   ${stats.symbol}:`);
      logger.info(`      Iterations: ${stats.iteration}`);
      logger.info(`      Successful: ${stats.successfulWrites}`);
      logger.info(`      Failed: ${stats.failedWrites}`);
      logger.info(`      Success Rate: ${stats.successRate}%`);
    }
    
    logger.info('📊 ================================================');
    logger.info('');
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
    logger.info('🚀 MULTI-ASSET SIMULATOR v3.0 DEBUG MODE');
    logger.info('🚀 ================================================');
    logger.info(`🌐 Timezone: Asia/Jakarta (WIB = UTC+7)`);
    logger.info(`⏰ Current Time: ${currentTime}`);
    logger.info(`📊 Active Assets: ${this.simulators.size}`);
    logger.info(`🔧 Connection: ${this.firebase.useREST ? 'REST API' : 'Admin SDK'}`);
    logger.info('⏱️  Update Interval: 1 second');
    logger.info('🔄 Settings Refresh: Every 60 seconds');
    logger.info('📊 Stats Report: Every 30 seconds');
    logger.info('🚀 ================================================');
    logger.info('');

    for (const simulator of this.simulators.values()) {
      logger.info(`   📈 ${simulator.asset.symbol} - ${simulator.asset.name}`);
      logger.info(`      Path: ${simulator.realtimeDbPath}`);
    }
    logger.info('');

    // Start price updates
    this.updateInterval = setInterval(async () => {
      await this.updateAllPrices();
    }, parseInt(process.env.UPDATE_INTERVAL_MS || 1000));

    // Start settings refresh
    this.settingsRefreshInterval = setInterval(async () => {
      await this.refreshAssets();
    }, parseInt(process.env.SETTINGS_REFRESH_INTERVAL_MS || 60000));

    // Start stats reporting
    this.statsInterval = setInterval(() => {
      this.printStats();
    }, 30000); // Every 30 seconds

    logger.info('✅ All simulators running in DEBUG mode!');
    logger.info('📝 Check simulator-debug.log for detailed logs');
    logger.info('Press Ctrl+C to stop');
    logger.info('');
  }

  async stop() {
    if (!this.isRunning) return;

    logger.info('');
    logger.info('⏹️  Stopping Multi-Asset Manager...');
    
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

    this.printStats();

    logger.info('✅ Multi-Asset Manager stopped gracefully');
    
    setTimeout(() => {
      process.exit(0);
    }, 500);
  }
}

// ============================================
// MAIN EXECUTION
// ============================================
async function main() {
  console.log('');
  console.log('🔍 ================================================');
  console.log('🔍 MULTI-ASSET SIMULATOR - DEBUG MODE');
  console.log('🔍 ================================================');
  console.log(`🌐 Process TZ: ${process.env.TZ}`);
  console.log(`🌐 Current Time (WIB): ${TimezoneUtil.formatDateTime()}`);
  console.log(`🌐 Unix Timestamp: ${TimezoneUtil.getCurrentTimestamp()}`);
  console.log('🔍 ================================================');
  console.log('');
  console.log('🔧 System Configuration:');
  console.log(`   Node.js: ${process.version}`);
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Mode: DEBUG with Enhanced Logging`);
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