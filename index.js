import axios from 'axios';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();

// ============================================
// LOGGER CONFIGURATION (WITH ROTATION)
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
      maxsize: 5242880, // 5MB
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
// FIREBASE REST API CLIENT (OPTIMIZED)
// ============================================
class FirebaseRestClient {
  constructor(databaseURL) {
    this.databaseURL = databaseURL.replace(/\/$/, '');
    
    // Create axios instance with optimized config
    this.client = axios.create({
      baseURL: this.databaseURL,
      timeout: 15000, // Reduced to 15s
      family: 4,
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: (status) => status >= 200 && status < 300,
      maxRedirects: 5,
      // Important: prevent keep-alive issues
      httpAgent: null,
      httpsAgent: null
    });
    
    this.client.interceptors.request.use(
      (config) => {
        logger.debug(`→ ${config.method.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        logger.error(`Request interceptor error: ${error.message}`);
        return Promise.reject(error);
      }
    );
    
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`← ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        if (error.response) {
          logger.error(`Response error: ${error.response.status} - ${error.response.statusText}`);
        } else if (error.request) {
          logger.error(`Network error: ${error.message}`);
        } else {
          logger.error(`Error: ${error.message}`);
        }
        return Promise.reject(error);
      }
    );
  }

  async set(path, data) {
    try {
      const response = await this.client.put(`${path}.json`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Firebase set error: ${error.message}`);
    }
  }

  async get(path) {
    try {
      const response = await this.client.get(`${path}.json`);
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return null;
      }
      throw new Error(`Firebase get error: ${error.message}`);
    }
  }

  async update(path, data) {
    try {
      const response = await this.client.patch(`${path}.json`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Firebase update error: ${error.message}`);
    }
  }

  async delete(path) {
    try {
      const response = await this.client.delete(`${path}.json`);
      return response.data;
    } catch (error) {
      throw new Error(`Firebase delete error: ${error.message}`);
    }
  }

  // Batch delete for optimization
  async batchDelete(paths) {
    const updates = {};
    paths.forEach(path => {
      updates[path] = null;
    });
    
    try {
      const response = await this.client.patch('/.json', updates);
      return response.data;
    } catch (error) {
      throw new Error(`Firebase batch delete error: ${error.message}`);
    }
  }
}

// ============================================
// IDX_STC SIMULATOR CLASS (OPTIMIZED)
// ============================================
class IDXSTCSimulator {
  constructor(config) {
    this.initialPrice = parseFloat(config.initialPrice);
    this.currentPrice = this.initialPrice;
    this.assetName = config.assetName;
    this.timezone = config.timezone;
    
    this.dailyVolatilityMin = parseFloat(config.dailyVolatilityMin);
    this.dailyVolatilityMax = parseFloat(config.dailyVolatilityMax);
    this.secondVolatilityMin = parseFloat(config.secondVolatilityMin);
    this.secondVolatilityMax = parseFloat(config.secondVolatilityMax);
    
    this.dataRetentionDays = parseInt(config.dataRetentionDays);
    this.cleanupIntervalHours = parseInt(config.cleanupIntervalHours);
    
    this.lastDirection = 1;
    this.iteration = 0;
    this.lastCleanup = Date.now();
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;
    
    // Add memory monitoring
    this.lastMemoryCheck = Date.now();
    this.memoryCheckInterval = 60000; // 1 minute
    
    // Control flag for graceful shutdown
    this.isRunning = false;
    this.intervalId = null;
    
    logger.info(`${this.assetName} Simulator initialized`);
    logger.info(`Initial Price: ${this.initialPrice}`);
    logger.info(`Timezone: ${this.timezone}`);
  }

  async initializeFirebase(databaseURL) {
    try {
      logger.info('🔌 Initializing Firebase REST API Client (Axios)...');
      this.firebase = new FirebaseRestClient(databaseURL);
      
      const assetPath = `/${this.assetName.toLowerCase()}`;
      this.ohlcPath = `${assetPath}/ohlc`;
      this.currentPricePath = `${assetPath}/current_price`;
      this.statsPath = `${assetPath}/stats`;
      
      // Test connection
      logger.info('🔌 Testing Firebase connection...');
      logger.info(`   Database URL: ${databaseURL}`);
      
      const testData = { 
        test: 'connection_test', 
        timestamp: Date.now(),
        version: '2.1-optimized'
      };
      
      await this.firebase.set('/test', testData);
      
      logger.info('✅ Firebase connection successful!');
      logger.info('✅ Firebase REST API initialized (Optimized mode)');
      return true;
      
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      throw error;
    }
  }

  getCurrentTime() {
    return new Date();
  }

  formatDateTime(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    
    return {
      datetime: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
      iso: date.toISOString()
    };
  }

  generatePriceMovement() {
    const volatility = this.secondVolatilityMin + 
      Math.random() * (this.secondVolatilityMax - this.secondVolatilityMin);
    
    let direction = Math.random() < 0.5 ? -1 : 1;
    
    if (Math.random() < 0.7) {
      direction = this.lastDirection;
    }
    
    this.lastDirection = direction;
    
    const priceChange = this.currentPrice * volatility * direction;
    let newPrice = this.currentPrice + priceChange;
    
    const minPrice = this.initialPrice * 0.5;
    const maxPrice = this.initialPrice * 2.0;
    
    if (newPrice < minPrice) newPrice = minPrice;
    if (newPrice > maxPrice) newPrice = maxPrice;
    
    return newPrice;
  }

  generateOHLCBar(timestamp) {
    const openPrice = this.currentPrice;
    
    const prices = [openPrice];
    for (let i = 0; i < 3; i++) {
      prices.push(this.generatePriceMovement());
    }
    
    const closePrice = prices[prices.length - 1];
    const highPrice = Math.max(...prices);
    const lowPrice = Math.min(...prices);
    
    this.currentPrice = closePrice;
    
    const volume = Math.floor(1000 + Math.random() * 49000);
    
    const date = new Date(timestamp);
    const { datetime, iso } = this.formatDateTime(date);
    
    return {
      timestamp: Math.floor(timestamp / 1000),
      datetime,
      datetime_iso: iso,
      timezone: this.timezone,
      open: parseFloat(openPrice.toFixed(3)),
      high: parseFloat(highPrice.toFixed(3)),
      low: parseFloat(lowPrice.toFixed(3)),
      close: parseFloat(closePrice.toFixed(3)),
      volume
    };
  }

  async saveToFirebase(ohlcData) {
    try {
      const timestampKey = ohlcData.timestamp.toString();
      
      // Parallel execution for better performance
      await Promise.all([
        // Save OHLC data
        this.firebase.set(`${this.ohlcPath}/${timestampKey}`, ohlcData),
        
        // Update current price
        this.firebase.set(this.currentPricePath, {
          price: ohlcData.close,
          timestamp: ohlcData.timestamp,
          datetime: ohlcData.datetime,
          datetime_iso: ohlcData.datetime_iso,
          timezone: ohlcData.timezone,
          change: parseFloat(((ohlcData.close - this.initialPrice) / this.initialPrice * 100).toFixed(2))
        }),
        
        // Update statistics
        this.updateStats(ohlcData)
      ]);
      
      logger.info(
        `[${ohlcData.datetime}] OHLC - ` +
        `O:${ohlcData.open} H:${ohlcData.high} ` +
        `L:${ohlcData.low} C:${ohlcData.close} ` +
        `V:${ohlcData.volume}`
      );
      
      // Reset error counter on success
      this.consecutiveErrors = 0;
      
    } catch (error) {
      this.consecutiveErrors++;
      logger.error(`Error saving to Firebase (${this.consecutiveErrors}/${this.maxConsecutiveErrors}): ${error.message}`);
      
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error(`❌ Too many consecutive errors (${this.consecutiveErrors}). Stopping...`);
        await this.stop();
      }
      
      throw error; // Re-throw to trigger retry mechanism
    }
  }

  async updateStats(ohlcData) {
    try {
      const currentStats = await this.firebase.get(this.statsPath) || {};
      
      const stats = {
        total_bars: (currentStats.total_bars || 0) + 1,
        last_update: ohlcData.datetime,
        last_update_iso: ohlcData.datetime_iso,
        timezone: ohlcData.timezone,
        initial_price: this.initialPrice,
        current_price: ohlcData.close,
        highest_price: Math.max(
          currentStats.highest_price || this.initialPrice,
          ohlcData.high
        ),
        lowest_price: Math.min(
          currentStats.lowest_price || this.initialPrice,
          ohlcData.low
        ),
        total_volume: (currentStats.total_volume || 0) + ohlcData.volume
      };
      
      await this.firebase.set(this.statsPath, stats);
      
    } catch (error) {
      logger.error(`Error updating stats: ${error.message}`);
    }
  }

  async cleanupOldData() {
    try {
      logger.info('🗑️  Starting data cleanup...');
      
      const currentTime = Math.floor(Date.now() / 1000);
      const cutoffTime = currentTime - (this.dataRetentionDays * 24 * 60 * 60);
      
      const allData = await this.firebase.get(this.ohlcPath) || {};
      
      const pathsToDelete = [];
      
      for (const timestampKey in allData) {
        if (parseInt(timestampKey) < cutoffTime) {
          pathsToDelete.push(`${this.ohlcPath}/${timestampKey}`);
        }
      }
      
      if (pathsToDelete.length > 0) {
        // Use batch delete for better performance
        await this.firebase.batchDelete(pathsToDelete);
        logger.info(`🗑️  Cleaned up ${pathsToDelete.length} old records`);
      } else {
        logger.info('🗑️  No old records to clean up');
      }
      
    } catch (error) {
      logger.error(`Error cleaning up old data: ${error.message}`);
    }
  }

  checkMemoryUsage() {
    const used = process.memoryUsage();
    const mbUsed = (used.heapUsed / 1024 / 1024).toFixed(2);
    const mbTotal = (used.heapTotal / 1024 / 1024).toFixed(2);
    
    logger.info(`💾 Memory: ${mbUsed}MB / ${mbTotal}MB heap`);
    
    // Alert if memory usage is high
    if (used.heapUsed / used.heapTotal > 0.9) {
      logger.warn(`⚠️  High memory usage detected! Consider restarting.`);
    }
  }

  async processIteration() {
    if (!this.isRunning) return;
    
    try {
      const timestamp = Date.now();
      const startProcess = Date.now();
      
      const ohlcData = this.generateOHLCBar(timestamp);
      await this.saveToFirebase(ohlcData);
      
      const processTime = (Date.now() - startProcess) / 1000;
      this.iteration++;
      
      if (processTime > 0.5) {
        logger.warn(`⚠️  Processing took ${processTime.toFixed(3)}s - may affect precision`);
      }
      
      // Periodic cleanup
      const cleanupIntervalMs = this.cleanupIntervalHours * 60 * 60 * 1000;
      if (Date.now() - this.lastCleanup > cleanupIntervalMs) {
        await this.cleanupOldData();
        this.lastCleanup = Date.now();
      }
      
      // Periodic memory check
      if (Date.now() - this.lastMemoryCheck > this.memoryCheckInterval) {
        this.checkMemoryUsage();
        this.lastMemoryCheck = Date.now();
      }
      
    } catch (error) {
      logger.error(`Iteration error: ${error.message}`);
      
      // Don't stop on single error, but wait before retry
      if (this.consecutiveErrors < this.maxConsecutiveErrors) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async run() {
    logger.info(`🚀 Starting ${this.assetName} simulator...`);
    logger.info(`📍 Timezone: ${this.timezone}`);
    logger.info('⏱️  Starting with interval-based execution...');
    
    this.isRunning = true;
    
    const startTime = this.getCurrentTime();
    logger.info(`✅ Started at ${this.formatDateTime(startTime).datetime}`);
    logger.info('Press Ctrl+C to stop\n');
    
    // Use setInterval instead of recursion to prevent stack overflow
    this.intervalId = setInterval(() => {
      this.processIteration();
    }, 1000); // Run every second
    
    // Initial check
    this.checkMemoryUsage();
  }

  async stop() {
    if (!this.isRunning) return;
    
    logger.info('\n⏹️  Stopping simulator...');
    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    logger.info(`📊 Total iterations: ${this.iteration}`);
    logger.info('✅ Simulator stopped gracefully');
    
    // Give time for final logs to flush
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
  console.log('🔧 System Configuration:');
  console.log(`   Node.js: ${process.version}`);
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Architecture: ${process.arch}`);
  console.log(`   Mode: REST API (Optimized)`);
  console.log('');

  const config = {
    initialPrice: process.env.INITIAL_PRICE || 40.022,
    assetName: process.env.ASSET_NAME || 'IDX_STC',
    timezone: process.env.TIMEZONE || 'Asia/Jakarta',
    dailyVolatilityMin: process.env.DAILY_VOLATILITY_MIN || 0.001,
    dailyVolatilityMax: process.env.DAILY_VOLATILITY_MAX || 0.005,
    secondVolatilityMin: process.env.SECOND_VOLATILITY_MIN || 0.00001,
    secondVolatilityMax: process.env.SECOND_VOLATILITY_MAX || 0.00008,
    dataRetentionDays: process.env.DATA_RETENTION_DAYS || 7,
    cleanupIntervalHours: process.env.CLEANUP_INTERVAL_HOURS || 1
  };

  const simulator = new IDXSTCSimulator(config);
  
  // Graceful shutdown handlers
  process.on('SIGINT', () => simulator.stop());
  process.on('SIGTERM', () => simulator.stop());
  process.on('SIGUSR2', () => simulator.stop()); // PM2 reload
  
  // Handle uncaught errors
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`);
    logger.error(error.stack);
    simulator.stop();
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    simulator.stop();
  });
  
  try {
    await simulator.initializeFirebase(
      process.env.FIREBASE_DATABASE_URL
    );
    
    await simulator.run();
    
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

main();