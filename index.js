import axios from 'axios';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();

// ============================================
// LOGGER CONFIGURATION
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
    new transports.File({ filename: 'simulator.log' }),
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
// FIREBASE REST API CLIENT (AXIOS)
// ============================================
class FirebaseRestClient {
  constructor(databaseURL) {
    this.databaseURL = databaseURL.replace(/\/$/, '');
    
    // Create axios instance with custom config
    this.client = axios.create({
      baseURL: this.databaseURL,
      timeout: 8000, // 8 second timeout
      headers: {
        'Content-Type': 'application/json'
      },
      // Retry configuration
      validateStatus: (status) => status >= 200 && status < 300
    });
    
    // Add request interceptor for logging
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
    
    // Add response interceptor
    this.client.interceptors.response.use(
      (response) => {
        logger.debug(`← ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        if (error.response) {
          logger.error(`Response error: ${error.response.status} - ${error.response.statusText}`);
        } else if (error.request) {
          logger.error(`Request timeout or network error: ${error.message}`);
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
        return null; // Path doesn't exist
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
}

// ============================================
// IDX_STC SIMULATOR CLASS
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
        version: '2.0-axios'
      };
      
      await this.firebase.set('/test', testData);
      
      logger.info('✅ Firebase connection successful!');
      logger.info('✅ Firebase REST API initialized (Axios mode)');
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

  async waitForNextSecond() {
    const now = Date.now();
    const msToNextSecond = 1000 - (now % 1000);
    
    return new Promise(resolve => {
      setTimeout(() => resolve(Date.now()), msToNextSecond);
    });
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
      
      // Save OHLC data
      await this.firebase.set(`${this.ohlcPath}/${timestampKey}`, ohlcData);
      
      // Update current price
      const priceChange = ((ohlcData.close - this.initialPrice) / this.initialPrice) * 100;
      
      await this.firebase.set(this.currentPricePath, {
        price: ohlcData.close,
        timestamp: ohlcData.timestamp,
        datetime: ohlcData.datetime,
        datetime_iso: ohlcData.datetime_iso,
        timezone: ohlcData.timezone,
        change: parseFloat(priceChange.toFixed(2))
      });
      
      // Update statistics
      await this.updateStats(ohlcData);
      
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
        logger.error(`❌ Too many consecutive errors (${this.consecutiveErrors}). Exiting...`);
        process.exit(1);
      }
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
      
      let deletedCount = 0;
      const deletePromises = [];
      
      for (const timestampKey in allData) {
        if (parseInt(timestampKey) < cutoffTime) {
          deletePromises.push(
            this.firebase.delete(`${this.ohlcPath}/${timestampKey}`)
              .catch(err => logger.error(`Error deleting ${timestampKey}: ${err.message}`))
          );
          deletedCount++;
        }
      }
      
      if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
        logger.info(`🗑️  Cleaned up ${deletedCount} old records`);
      } else {
        logger.info('🗑️  No old records to clean up');
      }
      
    } catch (error) {
      logger.error(`Error cleaning up old data: ${error.message}`);
    }
  }

  async run() {
    logger.info(`🚀 Starting ${this.assetName} simulator...`);
    logger.info(`📍 Timezone: ${this.timezone}`);
    logger.info('⏱️  Synchronizing with system clock...');
    
    await this.waitForNextSecond();
    
    const startTime = this.getCurrentTime();
    logger.info(`✅ Synchronized! Starting at ${this.formatDateTime(startTime).datetime}`);
    logger.info('Press Ctrl+C to stop\n');
    
    const cleanupIntervalMs = this.cleanupIntervalHours * 60 * 60 * 1000;
    
    const runLoop = async () => {
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
        
        if (Date.now() - this.lastCleanup > cleanupIntervalMs) {
          await this.cleanupOldData();
          this.lastCleanup = Date.now();
        }
        
        await this.waitForNextSecond();
        runLoop();
        
      } catch (error) {
        logger.error(`Simulator error: ${error.message}`);
        logger.info('Continuing after error...');
        await this.waitForNextSecond();
        runLoop();
      }
    };
    
    runLoop();
  }

  async stop() {
    logger.info('\n⏹️  Simulator stopped by user');
    logger.info(`📊 Total iterations: ${this.iteration}`);
    process.exit(0);
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
  console.log(`   Mode: REST API (Axios)`);
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
  
  process.on('SIGINT', () => simulator.stop());
  process.on('SIGTERM', () => simulator.stop());
  
  try {
    await simulator.initializeFirebase(
      process.env.FIREBASE_DATABASE_URL
    );
    
    await simulator.run();
    
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    process.exit(1);
  }
}

main();