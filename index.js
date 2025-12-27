// ============================================
// FIXED IDX_STC MULTI-TIMEFRAME SIMULATOR
// Version: 2.1 - TIMEZONE SYNCHRONIZED
// ============================================

import axios from 'axios';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';

dotenv.config();

// ✅ CRITICAL: Set timezone BEFORE anything else
process.env.TZ = 'Asia/Jakarta';

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
// TIMEZONE UTILITY (Same as Backend)
// ============================================
class TimezoneUtil {
  /**
   * Get current timestamp in seconds
   */
  static getCurrentTimestamp() {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Format date to Asia/Jakarta timezone
   * Format: YYYY-MM-DD HH:mm:ss
   */
  static formatDateTime(date = new Date()) {
    // ✅ Convert to Indonesia timezone (WIB = UTC+7)
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

  /**
   * Get ISO string
   */
  static toISOString(date = new Date()) {
    return date.toISOString();
  }

  /**
   * Get complete datetime info
   */
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
// FIREBASE REST API CLIENT
// ============================================
class FirebaseRestClient {
  constructor(databaseURL) {
    this.databaseURL = databaseURL.replace(/\/$/, '');
    
    this.client = axios.create({
      baseURL: this.databaseURL,
      timeout: 15000,
      family: 4, // Force IPv4
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: (status) => status >= 200 && status < 300,
      maxRedirects: 5,
    });
  }

  async set(path, data) {
    try {
      const response = await this.client.put(`${path}.json`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Firebase set error: ${error.message}`);
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

  async get(path) {
    try {
      const response = await this.client.get(`${path}.json`);
      return response.data;
    } catch (error) {
      throw new Error(`Firebase get error: ${error.message}`);
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
    
    Object.keys(this.timeframes).forEach(tf => {
      this.bars[tf] = null;
    });

    this.barsCreated = {};
    Object.keys(this.timeframes).forEach(tf => {
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

  getStatistics() {
    return {
      timeframes: Object.keys(this.timeframes),
      barsCreated: this.barsCreated,
      currentBars: Object.keys(this.bars).filter(tf => this.bars[tf] !== null)
    };
  }
}

// ============================================
// MULTI-TIMEFRAME SIMULATOR
// ============================================
class MultiTimeframeSimulator {
  constructor(config) {
    this.initialPrice = parseFloat(config.initialPrice);
    this.currentPrice = this.initialPrice;
    this.assetName = config.assetName;
    this.timezone = config.timezone;
    
    this.volatilityMin = parseFloat(config.secondVolatilityMin);
    this.volatilityMax = parseFloat(config.secondVolatilityMax);
    
    this.lastDirection = 1;
    this.iteration = 0;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;
    
    this.isRunning = false;
    this.intervalId = null;
    
    this.tfManager = new TimeframeManager();
    
    this.stats = {
      totalIterations: 0,
      totalWrites: 0,
      totalErrors: 0,
      startTime: null,
      lastWriteTime: null
    };
    
    logger.info(`${this.assetName} Multi-Timeframe Simulator v2.1 initialized`);
    logger.info(`Timeframes: 1s, 1m, 5m, 15m, 1h, 4h, 1d`);
  }

  async initializeFirebase(databaseURL) {
    try {
      logger.info('🔌 Initializing Firebase REST API Client...');
      this.firebase = new FirebaseRestClient(databaseURL);
      
      const assetPath = `/${this.assetName.toLowerCase()}`;
      this.basePath = assetPath;
      this.currentPricePath = `${assetPath}/current_price`;
      this.statsPath = `${assetPath}/stats`;
      
      await this.firebase.set('/test_connection', { 
        test: 'simulator_v2.1',
        timestamp: Date.now(),
        version: '2.1-timezone-sync',
        timezone: this.timezone
      });
      
      logger.info('✅ Firebase connection successful!');
      logger.info('✅ Multi-timeframe OHLC generation enabled');
      logger.info(`✅ Timezone: ${this.timezone} (WIB = UTC+7)`);
      return true;
      
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      throw error;
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
    
    const minPrice = this.initialPrice * 0.5;
    const maxPrice = this.initialPrice * 2.0;
    
    if (newPrice < minPrice) newPrice = minPrice;
    if (newPrice > maxPrice) newPrice = maxPrice;
    
    return newPrice;
  }

  /**
   * ✅ UPDATED: Save to Firebase with proper timezone
   */
  async saveToFirebase(timestamp, price) {
    try {
      const { completedBars, currentBars } = this.tfManager.updateOHLC(timestamp, price);
      
      // ✅ Use TimezoneUtil for consistent formatting
      const date = new Date(timestamp * 1000);
      const dateTimeInfo = TimezoneUtil.getDateTimeInfo(date);

      // Save completed bars
      for (const [tf, bar] of Object.entries(completedBars)) {
        const path = `${this.basePath}/ohlc_${tf}/${bar.timestamp}`;
        const barDate = new Date(bar.timestamp * 1000);
        const barDateTime = TimezoneUtil.getDateTimeInfo(barDate);
        
        const barData = {
          timestamp: bar.timestamp,
          datetime: barDateTime.datetime,
          datetime_iso: barDateTime.datetime_iso,
          timezone: this.timezone,
          open: parseFloat(bar.open.toFixed(3)),
          high: parseFloat(bar.high.toFixed(3)),
          low: parseFloat(bar.low.toFixed(3)),
          close: parseFloat(bar.close.toFixed(3)),
          volume: bar.volume,
          isCompleted: true
        };
        
        await this.firebase.set(path, barData);
        this.stats.totalWrites++;
      }

      // Save current bars
      for (const [tf, bar] of Object.entries(currentBars)) {
        const path = `${this.basePath}/ohlc_${tf}/${bar.timestamp}`;
        const barDate = new Date(bar.timestamp * 1000);
        const barDateTime = TimezoneUtil.getDateTimeInfo(barDate);
        
        const barData = {
          timestamp: bar.timestamp,
          datetime: barDateTime.datetime,
          datetime_iso: barDateTime.datetime_iso,
          timezone: this.timezone,
          open: parseFloat(bar.open.toFixed(3)),
          high: parseFloat(bar.high.toFixed(3)),
          low: parseFloat(bar.low.toFixed(3)),
          close: parseFloat(bar.close.toFixed(3)),
          volume: bar.volume,
          isCompleted: bar.isCompleted || false
        };
        
        await this.firebase.set(path, barData);
        this.stats.totalWrites++;
      }

      // Update current price
      const currentPriceData = {
        price: parseFloat(price.toFixed(3)),
        timestamp: timestamp,
        datetime: dateTimeInfo.datetime,
        datetime_iso: dateTimeInfo.datetime_iso,
        timezone: this.timezone,
        change: parseFloat(((price - this.initialPrice) / this.initialPrice * 100).toFixed(2)),
        change_24h: 0
      };
      
      await this.firebase.set(this.currentPricePath, currentPriceData);
      this.stats.totalWrites++;
      this.stats.lastWriteTime = Date.now();

      // Log completed bars
      if (Object.keys(completedBars).length > 0) {
        const completedTfs = Object.keys(completedBars).join(', ');
        logger.info(`[${dateTimeInfo.datetime} WIB] ✓ Completed: ${completedTfs} | Price: ${price.toFixed(3)}`);
      }
      
      this.consecutiveErrors = 0;
      
    } catch (error) {
      this.consecutiveErrors++;
      this.stats.totalErrors++;
      logger.error(`❌ Save error (${this.consecutiveErrors}/${this.maxConsecutiveErrors}): ${error.message}`);
      
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error(`❌ Too many consecutive errors. Stopping...`);
        await this.stop();
      }
      
      throw error;
    }
  }

  async saveStatistics() {
    try {
      const tfStats = this.tfManager.getStatistics();
      const uptime = this.stats.startTime ? (Date.now() - this.stats.startTime) / 1000 : 0;
      
      const statsData = {
        version: '2.1-timezone-sync',
        timezone: this.timezone,
        uptime_seconds: Math.floor(uptime),
        total_iterations: this.stats.totalIterations,
        total_writes: this.stats.totalWrites,
        total_errors: this.stats.totalErrors,
        current_price: this.currentPrice,
        initial_price: this.initialPrice,
        timeframes: tfStats.timeframes,
        bars_created: tfStats.barsCreated,
        last_update: TimezoneUtil.toISOString(),
        last_update_wib: TimezoneUtil.formatDateTime()
      };
      
      await this.firebase.set(this.statsPath, statsData);
    } catch (error) {
      logger.error(`Statistics update error: ${error.message}`);
    }
  }

  async processIteration() {
    if (!this.isRunning) return;
    
    try {
      const timestamp = TimezoneUtil.getCurrentTimestamp();
      const newPrice = this.generatePriceMovement();
      
      await this.saveToFirebase(timestamp, newPrice);
      
      this.currentPrice = newPrice;
      this.iteration++;
      this.stats.totalIterations++;
      
      if (this.iteration % 60 === 0) {
        await this.saveStatistics();
        
        const tfStats = this.tfManager.getStatistics();
        logger.info(`📊 Progress: ${this.iteration} iterations | Bars created: ${JSON.stringify(tfStats.barsCreated)}`);
      }
      
    } catch (error) {
      logger.error(`❌ Iteration error: ${error.message}`);
      
      if (this.consecutiveErrors < this.maxConsecutiveErrors) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async run() {
    const currentTime = TimezoneUtil.formatDateTime();
    
    logger.info(`🚀 Starting ${this.assetName} Multi-Timeframe Simulator v2.1...`);
    logger.info(`🌍 Timezone: ${this.timezone} (WIB = UTC+7)`);
    logger.info(`⏰ Current Time: ${currentTime}`);
    logger.info(`📊 Generating OHLC: 1s, 1m, 5m, 15m, 1h, 4h, 1d`);
    logger.info('⏱️  Running every second...');
    logger.info('');
    
    this.isRunning = true;
    this.stats.startTime = Date.now();
    
    logger.info(`✅ Started at ${currentTime} WIB`);
    logger.info('Press Ctrl+C to stop');
    logger.info('');
    
    await this.saveStatistics();
    
    this.intervalId = setInterval(() => {
      this.processIteration();
    }, 1000);
  }

  async stop() {
    if (!this.isRunning) return;
    
    logger.info('');
    logger.info('⏹️  Stopping simulator...');
    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    await this.saveStatistics();
    
    const tfStats = this.tfManager.getStatistics();
    logger.info(`📊 Total iterations: ${this.iteration}`);
    logger.info(`📊 Bars created: ${JSON.stringify(tfStats.barsCreated)}`);
    logger.info(`📊 Total writes: ${this.stats.totalWrites}`);
    logger.info(`📊 Total errors: ${this.stats.totalErrors}`);
    logger.info('✅ Simulator stopped gracefully');
    
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
  console.log('🌍 ================================================');
  console.log('🌍 TIMEZONE CONFIGURATION');
  console.log('🌍 ================================================');
  console.log(`🌍 Process TZ: ${process.env.TZ}`);
  console.log(`🌍 Current Time (WIB): ${TimezoneUtil.formatDateTime()}`);
  console.log(`🌍 Current Time (ISO): ${TimezoneUtil.toISOString()}`);
  console.log(`🌍 Unix Timestamp: ${TimezoneUtil.getCurrentTimestamp()}`);
  console.log('🌍 ================================================');
  console.log('');
  console.log('🔧 System Configuration:');
  console.log(`   Node.js: ${process.version}`);
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Mode: Fixed Multi-Timeframe v2.1 (Timezone Sync)`);
  console.log('');

  const config = {
    initialPrice: process.env.INITIAL_PRICE || 40.022,
    assetName: process.env.ASSET_NAME || 'IDX_STC',
    timezone: process.env.TIMEZONE || 'Asia/Jakarta',
    secondVolatilityMin: process.env.SECOND_VOLATILITY_MIN || 0.00001,
    secondVolatilityMax: process.env.SECOND_VOLATILITY_MAX || 0.00008,
  };

  logger.info('Configuration loaded:');
  logger.info(`  Asset: ${config.assetName}`);
  logger.info(`  Initial Price: ${config.initialPrice}`);
  logger.info(`  Timezone: ${config.timezone}`);
  logger.info(`  Volatility: ${config.secondVolatilityMin} - ${config.secondVolatilityMax}`);
  logger.info('');

  const simulator = new MultiTimeframeSimulator(config);
  
  process.on('SIGINT', () => simulator.stop());
  process.on('SIGTERM', () => simulator.stop());
  process.on('SIGUSR2', () => simulator.stop());
  
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
    await simulator.initializeFirebase(process.env.FIREBASE_DATABASE_URL);
    await simulator.run();
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

main();