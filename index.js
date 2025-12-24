// ============================================
// FIXED IDX_STC MULTI-TIMEFRAME SIMULATOR
// Version: 2.0 - Complete OHLC Generation
// ============================================

import axios from 'axios';
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
// TIMEFRAME MANAGER (FIXED VERSION)
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

    // Statistics
    this.barsCreated = {};
    Object.keys(this.timeframes).forEach(tf => {
      this.barsCreated[tf] = 0;
    });
  }

  /**
   * Get the bar timestamp (floor to boundary)
   */
  getBarTimestamp(timestamp, timeframeSeconds) {
    return Math.floor(timestamp / timeframeSeconds) * timeframeSeconds;
  }

  /**
   * Update OHLC for a price tick
   * Returns: { completed: [...], current: [...] }
   */
  updateOHLC(timestamp, price) {
    const completedBars = {};
    const currentBars = {};

    Object.entries(this.timeframes).forEach(([tf, seconds]) => {
      const barTimestamp = this.getBarTimestamp(timestamp, seconds);

      // Check if we need a new bar
      if (!this.bars[tf] || this.bars[tf].timestamp !== barTimestamp) {
        // Save completed bar
        if (this.bars[tf]) {
          completedBars[tf] = {
            ...this.bars[tf],
            isCompleted: true
          };
          this.barsCreated[tf]++;
        }

        // Start new bar
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
        // Update existing bar
        this.bars[tf].high = Math.max(this.bars[tf].high, price);
        this.bars[tf].low = Math.min(this.bars[tf].low, price);
        this.bars[tf].close = price;
      }
      
      // Add volume
      this.bars[tf].volume += Math.floor(1000 + Math.random() * 49000);

      // Always include current bar
      currentBars[tf] = { ...this.bars[tf] };
    });

    return { completedBars, currentBars };
  }

  /**
   * Get statistics
   */
  getStatistics() {
    return {
      timeframes: Object.keys(this.timeframes),
      barsCreated: this.barsCreated,
      currentBars: Object.keys(this.bars).filter(tf => this.bars[tf] !== null)
    };
  }
}

// ============================================
// MULTI-TIMEFRAME SIMULATOR (FIXED VERSION)
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
    
    // Initialize timeframe manager
    this.tfManager = new TimeframeManager();
    
    // Statistics
    this.stats = {
      totalIterations: 0,
      totalWrites: 0,
      totalErrors: 0,
      startTime: null,
      lastWriteTime: null
    };
    
    logger.info(`${this.assetName} Multi-Timeframe Simulator v2.0 initialized`);
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
      await this.firebase.set('/test_connection', { 
        test: 'simulator_v2',
        timestamp: Date.now(),
        version: '2.0-fixed'
      });
      
      logger.info('✅ Firebase connection successful!');
      logger.info('✅ Multi-timeframe OHLC generation enabled');
      return true;
      
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate next price with random walk
   */
  generatePriceMovement() {
    const volatility = this.volatilityMin + 
      Math.random() * (this.volatilityMax - this.volatilityMin);
    
    // Random direction with momentum
    let direction = Math.random() < 0.5 ? -1 : 1;
    if (Math.random() < 0.7) {
      direction = this.lastDirection;
    }
    this.lastDirection = direction;
    
    const priceChange = this.currentPrice * volatility * direction;
    let newPrice = this.currentPrice + priceChange;
    
    // Price bounds
    const minPrice = this.initialPrice * 0.5;
    const maxPrice = this.initialPrice * 2.0;
    
    if (newPrice < minPrice) newPrice = minPrice;
    if (newPrice > maxPrice) newPrice = maxPrice;
    
    return newPrice;
  }

  /**
   * Format datetime
   */
  formatDateTime(date) {
    const pad = (n) => n.toString().padStart(2, '0');
    
    return {
      datetime: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
      iso: date.toISOString()
    };
  }

  /**
   * Save data to Firebase (FIXED VERSION)
   */
  async saveToFirebase(timestamp, price) {
    try {
      // Update all timeframes
      const { completedBars, currentBars } = this.tfManager.updateOHLC(timestamp, price);
      
      const date = new Date(timestamp * 1000);
      const { datetime, iso } = this.formatDateTime(date);

      // ✅ STEP 1: Save all completed bars
      for (const [tf, bar] of Object.entries(completedBars)) {
        const path = `${this.basePath}/ohlc_${tf}/${bar.timestamp}`;
        const barData = {
          timestamp: bar.timestamp,
          datetime: this.formatDateTime(new Date(bar.timestamp * 1000)).datetime,
          datetime_iso: this.formatDateTime(new Date(bar.timestamp * 1000)).iso,
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

      // ✅ STEP 2: Save all current bars (including in-progress)
      for (const [tf, bar] of Object.entries(currentBars)) {
        const path = `${this.basePath}/ohlc_${tf}/${bar.timestamp}`;
        const barData = {
          timestamp: bar.timestamp,
          datetime: this.formatDateTime(new Date(bar.timestamp * 1000)).datetime,
          datetime_iso: this.formatDateTime(new Date(bar.timestamp * 1000)).iso,
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

      // ✅ STEP 3: Update current price
      const currentPriceData = {
        price: parseFloat(price.toFixed(3)),
        timestamp: timestamp,
        datetime: datetime,
        datetime_iso: iso,
        timezone: this.timezone,
        change: parseFloat(((price - this.initialPrice) / this.initialPrice * 100).toFixed(2)),
        change_24h: 0 // TODO: Calculate 24h change
      };
      
      await this.firebase.set(this.currentPricePath, currentPriceData);
      this.stats.totalWrites++;
      this.stats.lastWriteTime = Date.now();

      // Log completed bars
      if (Object.keys(completedBars).length > 0) {
        const completedTfs = Object.keys(completedBars).join(', ');
        logger.info(`[${datetime}] ✓ Completed: ${completedTfs} | Price: ${price.toFixed(3)}`);
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

  /**
   * Save statistics
   */
  async saveStatistics() {
    try {
      const tfStats = this.tfManager.getStatistics();
      const uptime = this.stats.startTime ? (Date.now() - this.stats.startTime) / 1000 : 0;
      
      const statsData = {
        version: '2.0-fixed',
        uptime_seconds: Math.floor(uptime),
        total_iterations: this.stats.totalIterations,
        total_writes: this.stats.totalWrites,
        total_errors: this.stats.totalErrors,
        current_price: this.currentPrice,
        initial_price: this.initialPrice,
        timeframes: tfStats.timeframes,
        bars_created: tfStats.barsCreated,
        last_update: new Date().toISOString()
      };
      
      await this.firebase.set(this.statsPath, statsData);
    } catch (error) {
      logger.error(`Statistics update error: ${error.message}`);
    }
  }

  /**
   * Process single iteration
   */
  async processIteration() {
    if (!this.isRunning) return;
    
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const newPrice = this.generatePriceMovement();
      
      await this.saveToFirebase(timestamp, newPrice);
      
      this.currentPrice = newPrice;
      this.iteration++;
      this.stats.totalIterations++;
      
      // Save statistics every 60 seconds
      if (this.iteration % 60 === 0) {
        await this.saveStatistics();
        
        // Log progress
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

  /**
   * Start simulator
   */
  async run() {
    logger.info(`🚀 Starting ${this.assetName} Multi-Timeframe Simulator v2.0...`);
    logger.info(`📊 Generating OHLC: 1s, 1m, 5m, 15m, 1h, 4h, 1d`);
    logger.info('⏱️  Running every second...');
    logger.info('');
    
    this.isRunning = true;
    this.stats.startTime = Date.now();
    
    const startTime = new Date();
    logger.info(`✅ Started at ${this.formatDateTime(startTime).datetime}`);
    logger.info('Press Ctrl+C to stop');
    logger.info('');
    
    // Initial statistics save
    await this.saveStatistics();
    
    this.intervalId = setInterval(() => {
      this.processIteration();
    }, 1000);
  }

  /**
   * Stop simulator
   */
  async stop() {
    if (!this.isRunning) return;
    
    logger.info('');
    logger.info('⏹️  Stopping simulator...');
    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    
    // Final statistics
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
  console.log('🔧 System Configuration:');
  console.log(`   Node.js: ${process.version}`);
  console.log(`   Platform: ${process.platform}`);
  console.log(`   Mode: Fixed Multi-Timeframe v2.0`);
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
  
  // Handle signals
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

// Start simulator
main();