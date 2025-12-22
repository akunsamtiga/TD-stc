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
    new transports.File({ 
      filename: 'simulator.log',
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
// FIREBASE REST API CLIENT
// ============================================
class FirebaseRestClient {
  constructor(databaseURL) {
    this.databaseURL = databaseURL.replace(/\/$/, '');
    
    this.client = axios.create({
      baseURL: this.databaseURL,
      timeout: 15000,
      family: 4,
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: (status) => status >= 200 && status < 300,
      maxRedirects: 5,
      httpAgent: null,
      httpsAgent: null
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

  async batchUpdate(updates) {
    try {
      const response = await this.client.patch('/.json', updates);
      return response.data;
    } catch (error) {
      throw new Error(`Firebase batch update error: ${error.message}`);
    }
  }
}

// ============================================
// TIMEFRAME MANAGER
// ============================================
class TimeframeManager {
  constructor() {
    // Timeframe definitions in seconds
    this.timeframes = {
      '1s': 1,
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '1h': 3600,
      '4h': 14400,
      '1d': 86400
    };

    // Current OHLC bars for each timeframe
    this.bars = {};
    
    // Initialize bars
    Object.keys(this.timeframes).forEach(tf => {
      this.bars[tf] = null;
    });
  }

  // Check if timestamp is at the boundary of a timeframe
  isTimeframeBoundary(timestamp, timeframeSeconds) {
    return timestamp % timeframeSeconds === 0;
  }

  // Get the timeframe bar timestamp (floor to boundary)
  getBarTimestamp(timestamp, timeframeSeconds) {
    return Math.floor(timestamp / timeframeSeconds) * timeframeSeconds;
  }

  // Update OHLC for a price tick
  updateOHLC(timestamp, price, volume = 0) {
    const updates = {};

    Object.entries(this.timeframes).forEach(([tf, seconds]) => {
      const barTimestamp = this.getBarTimestamp(timestamp, seconds);

      // If this is a new bar or first bar
      if (!this.bars[tf] || this.bars[tf].timestamp !== barTimestamp) {
        // Finalize previous bar if exists
        if (this.bars[tf]) {
          updates[tf] = { ...this.bars[tf], isClosed: true };
        }

        // Start new bar
        this.bars[tf] = {
          timestamp: barTimestamp,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: volume,
          isClosed: false
        };
      } else {
        // Update existing bar
        this.bars[tf].high = Math.max(this.bars[tf].high, price);
        this.bars[tf].low = Math.min(this.bars[tf].low, price);
        this.bars[tf].close = price;
        this.bars[tf].volume += volume;
      }
    });

    return updates;
  }

  // Get current bars (for saving)
  getCurrentBars() {
    const current = {};
    Object.entries(this.bars).forEach(([tf, bar]) => {
      if (bar) {
        current[tf] = { ...bar };
      }
    });
    return current;
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
    
    this.dailyVolatilityMin = parseFloat(config.dailyVolatilityMin);
    this.dailyVolatilityMax = parseFloat(config.dailyVolatilityMax);
    this.secondVolatilityMin = parseFloat(config.secondVolatilityMin);
    this.secondVolatilityMax = parseFloat(config.secondVolatilityMax);
    
    this.dataRetentionDays = parseInt(config.dataRetentionDays);
    
    this.lastDirection = 1;
    this.iteration = 0;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;
    
    this.isRunning = false;
    this.intervalId = null;
    
    // Initialize timeframe manager
    this.tfManager = new TimeframeManager();
    
    logger.info(`${this.assetName} Multi-Timeframe Simulator initialized`);
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
      
      // Test connection
      await this.firebase.set('/test', { 
        test: 'connection_test', 
        timestamp: Date.now(),
        version: '3.0-multi-timeframe'
      });
      
      logger.info('✅ Firebase connection successful!');
      logger.info('✅ Multi-timeframe mode enabled');
      return true;
      
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      throw error;
    }
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

  formatDateTime(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    
    return {
      datetime: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
      iso: date.toISOString()
    };
  }

  async saveToFirebase(timestamp, price) {
    try {
      const volume = Math.floor(1000 + Math.random() * 49000);
      
      // Update all timeframes
      const closedBars = this.tfManager.updateOHLC(timestamp, price, volume);
      
      // Prepare batch update
      const updates = {};
      const date = new Date(timestamp * 1000);
      const { datetime, iso } = this.formatDateTime(date);

      // Save closed bars (completed timeframes)
      Object.entries(closedBars).forEach(([tf, bar]) => {
        const path = `${this.basePath}/ohlc_${tf}/${bar.timestamp}`;
        updates[path] = {
          timestamp: bar.timestamp,
          datetime: this.formatDateTime(new Date(bar.timestamp * 1000)).datetime,
          datetime_iso: this.formatDateTime(new Date(bar.timestamp * 1000)).iso,
          timezone: this.timezone,
          open: parseFloat(bar.open.toFixed(3)),
          high: parseFloat(bar.high.toFixed(3)),
          low: parseFloat(bar.low.toFixed(3)),
          close: parseFloat(bar.close.toFixed(3)),
          volume: bar.volume
        };
      });

      // Always save current bars (including in-progress bars)
      const currentBars = this.tfManager.getCurrentBars();
      Object.entries(currentBars).forEach(([tf, bar]) => {
        const path = `${this.basePath}/ohlc_${tf}/${bar.timestamp}`;
        updates[path] = {
          timestamp: bar.timestamp,
          datetime: this.formatDateTime(new Date(bar.timestamp * 1000)).datetime,
          datetime_iso: this.formatDateTime(new Date(bar.timestamp * 1000)).iso,
          timezone: this.timezone,
          open: parseFloat(bar.open.toFixed(3)),
          high: parseFloat(bar.high.toFixed(3)),
          low: parseFloat(bar.low.toFixed(3)),
          close: parseFloat(bar.close.toFixed(3)),
          volume: bar.volume
        };
      });

      // Update current price
      updates[this.currentPricePath] = {
        price: parseFloat(price.toFixed(3)),
        timestamp: timestamp,
        datetime: datetime,
        datetime_iso: iso,
        timezone: this.timezone,
        change: parseFloat(((price - this.initialPrice) / this.initialPrice * 100).toFixed(2))
      };

      // Batch update to Firebase
      await this.firebase.batchUpdate(updates);
      
      // Log only on closed bars
      if (Object.keys(closedBars).length > 0) {
        const closedTfs = Object.keys(closedBars).join(', ');
        logger.info(`[${datetime}] Closed bars: ${closedTfs} | Price: ${price.toFixed(3)}`);
      }
      
      this.consecutiveErrors = 0;
      
    } catch (error) {
      this.consecutiveErrors++;
      logger.error(`Error saving to Firebase (${this.consecutiveErrors}/${this.maxConsecutiveErrors}): ${error.message}`);
      
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error(`❌ Too many consecutive errors. Stopping...`);
        await this.stop();
      }
      
      throw error;
    }
  }

  async processIteration() {
    if (!this.isRunning) return;
    
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const newPrice = this.generatePriceMovement();
      
      await this.saveToFirebase(timestamp, newPrice);
      
      this.currentPrice = newPrice;
      this.iteration++;
      
    } catch (error) {
      logger.error(`Iteration error: ${error.message}`);
      
      if (this.consecutiveErrors < this.maxConsecutiveErrors) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async run() {
    logger.info(`🚀 Starting ${this.assetName} Multi-Timeframe Simulator...`);
    logger.info(`📊 Generating: 1s, 1m, 5m, 15m, 1h, 4h, 1d`);
    logger.info('⏱️  Running every second...');
    
    this.isRunning = true;
    
    const startTime = new Date();
    logger.info(`✅ Started at ${this.formatDateTime(startTime).datetime}`);
    logger.info('Press Ctrl+C to stop\n');
    
    this.intervalId = setInterval(() => {
      this.processIteration();
    }, 1000);
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
  console.log(`   Mode: Multi-Timeframe REST API`);
  console.log('');

  const config = {
    initialPrice: process.env.INITIAL_PRICE || 40.022,
    assetName: process.env.ASSET_NAME || 'IDX_STC',
    timezone: process.env.TIMEZONE || 'Asia/Jakarta',
    dailyVolatilityMin: process.env.DAILY_VOLATILITY_MIN || 0.001,
    dailyVolatilityMax: process.env.DAILY_VOLATILITY_MAX || 0.005,
    secondVolatilityMin: process.env.SECOND_VOLATILITY_MIN || 0.00001,
    secondVolatilityMax: process.env.SECOND_VOLATILITY_MAX || 0.00008,
    dataRetentionDays: process.env.DATA_RETENTION_DAYS || 7
  };

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