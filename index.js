// ============================================
// SECURE IDX_STC MULTI-TIMEFRAME SIMULATOR
// Version: 2.3 - FIXED AUTHENTICATION
// ============================================

import axios from 'axios';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';
import { readFileSync } from 'fs';
import { join } from 'path';
import jwt from 'jsonwebtoken';

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
// ✅ SECURE FIREBASE REST API CLIENT
// With OAuth2 Authentication
// ============================================
class SecureFirebaseRestClient {
  constructor(databaseURL, credentialsPath) {
    this.databaseURL = databaseURL.replace(/\/$/, '');
    this.credentialsPath = credentialsPath;
    this.accessToken = null;
    this.tokenExpiry = 0;
    
    // Load service account credentials
    try {
      const credentialsData = readFileSync(this.credentialsPath, 'utf8');
      this.credentials = JSON.parse(credentialsData);
      logger.info('✅ Service account credentials loaded');
    } catch (error) {
      logger.error(`❌ Failed to load credentials: ${error.message}`);
      throw error;
    }
    
    this.client = axios.create({
      baseURL: this.databaseURL,
      timeout: 15000,
      family: 4,
      headers: {
        'Content-Type': 'application/json'
      },
      validateStatus: (status) => status >= 200 && status < 300,
      maxRedirects: 5,
    });

    // ✅ Add interceptor to inject authentication token
    this.client.interceptors.request.use(async (config) => {
      try {
        const token = await this.getAccessToken();
        config.headers['Authorization'] = `Bearer ${token}`;
        return config;
      } catch (error) {
        logger.error(`❌ Interceptor error: ${error.message}`);
        throw error;
      }
    });
  }

  /**
   * ✅ Get OAuth2 Access Token using Service Account
   */
  async getAccessToken() {
    // Check if token is still valid
    const now = Date.now();
    if (this.accessToken && this.tokenExpiry > now + 60000) {
      return this.accessToken;
    }

    try {
      logger.debug('🔑 Getting new access token...');

      // Create JWT for Google OAuth2
      const nowSeconds = Math.floor(Date.now() / 1000);
      
      const payload = {
        iss: this.credentials.client_email,
        sub: this.credentials.client_email,
        aud: 'https://oauth2.googleapis.com/token',
        iat: nowSeconds,
        exp: nowSeconds + 3600,
        scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email'
      };

      logger.debug(`🔑 JWT Payload: ${JSON.stringify(payload)}`);

      // Sign JWT
      let token;
      try {
        token = jwt.sign(payload, this.credentials.private_key, { 
          algorithm: 'RS256' 
        });
        logger.debug('✅ JWT signed successfully');
      } catch (jwtError) {
        logger.error(`❌ JWT signing failed: ${jwtError.message}`);
        throw new Error(`JWT signing failed: ${jwtError.message}`);
      }

      // Exchange JWT for access token
      logger.debug('🔄 Exchanging JWT for access token...');
      
      const response = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: token
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      this.accessToken = response.data.access_token;
      this.tokenExpiry = now + (response.data.expires_in * 1000);
      
      logger.info('✅ Access token obtained successfully');
      logger.debug(`🔑 Token expires in: ${response.data.expires_in} seconds`);
      
      return this.accessToken;

    } catch (error) {
      if (error.response) {
        // Server responded with error
        logger.error(`❌ OAuth2 error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
        // Request made but no response
        logger.error(`❌ No response from OAuth2 server: ${error.message}`);
      } else {
        // Error setting up request
        logger.error(`❌ Request setup error: ${error.message}`);
      }
      throw new Error(`Failed to get access token: ${error.message}`);
    }
  }

  async set(path, data) {
    try {
      const response = await this.client.put(`${path}.json`, data);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        logger.warn('⚠️ Token expired, refreshing...');
        this.accessToken = null;
        return await this.set(path, data);
      }
      
      // Better error logging
      if (error.response) {
        logger.error(`❌ Firebase set error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
      } else {
        logger.error(`❌ Firebase set error: ${error.message}`);
      }
      
      throw new Error(`Firebase set error: ${error.message}`);
    }
  }

  async update(path, data) {
    try {
      const response = await this.client.patch(`${path}.json`, data);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        logger.warn('⚠️ Token expired, refreshing...');
        this.accessToken = null;
        return await this.update(path, data);
      }
      throw new Error(`Firebase update error: ${error.message}`);
    }
  }

  async get(path) {
    try {
      const response = await this.client.get(`${path}.json`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        logger.warn('⚠️ Token expired, refreshing...');
        this.accessToken = null;
        return await this.get(path);
      }
      throw new Error(`Firebase get error: ${error.message}`);
    }
  }

  async delete(path) {
    try {
      const response = await this.client.delete(`${path}.json`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 401) {
        logger.warn('⚠️ Token expired, refreshing...');
        this.accessToken = null;
        return await this.delete(path);
      }
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
// ✅ SECURE MULTI-TIMEFRAME SIMULATOR
// ============================================
class SecureMultiTimeframeSimulator {
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
    
    logger.info(`${this.assetName} SECURE Multi-Timeframe Simulator v2.3 initialized`);
    logger.info(`🔐 Authentication: Service Account`);
    logger.info(`📊 Timeframes: 1s, 1m, 5m, 15m, 1h, 4h, 1d`);
  }

  async initializeFirebase(databaseURL, credentialsPath) {
    try {
      logger.info('🔌 Initializing SECURE Firebase REST API Client...');
      
      // ✅ Use secure client with authentication
      this.firebase = new SecureFirebaseRestClient(databaseURL, credentialsPath);
      
      const assetPath = `/${this.assetName.toLowerCase()}`;
      this.basePath = assetPath;
      this.currentPricePath = `${assetPath}/current_price`;
      this.statsPath = `${assetPath}/stats`;
      
      // Test connection with authentication
      logger.info('🧪 Testing Firebase connection...');
      await this.firebase.set('/test_connection', { 
        test: 'secure_simulator_v2.3',
        timestamp: Date.now(),
        version: '2.3-secure-authenticated',
        timezone: this.timezone,
        authenticated: true
      });
      
      logger.info('✅ SECURE Firebase connection successful!');
      logger.info('✅ Authentication verified');
      logger.info('✅ Multi-timeframe OHLC generation enabled');
      logger.info(`✅ Timezone: ${this.timezone} (WIB = UTC+7)`);
      return true;
      
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      if (error.stack) {
        logger.error(`Stack trace: ${error.stack}`);
      }
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

  async saveToFirebase(timestamp, price) {
    try {
      const { completedBars, currentBars } = this.tfManager.updateOHLC(timestamp, price);
      
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
        version: '2.3-secure-authenticated',
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
        last_update_wib: TimezoneUtil.formatDateTime(),
        authenticated: true
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
    
    logger.info(`🚀 Starting SECURE ${this.assetName} Multi-Timeframe Simulator v2.3...`);
    logger.info(`🔐 Authentication: Enabled (Service Account)`);
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
  console.log('🔐 ================================================');
  console.log('🔐 SECURE SIMULATOR - AUTHENTICATION ENABLED');
  console.log('🔐 ================================================');
  console.log(`🔐 Service Account: ${process.env.FIREBASE_SERVICE_ACCOUNT || 'firebase_credentials.json'}`);
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
  console.log(`   Mode: Secure Multi-Timeframe v2.3 (Authenticated)`);
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
  logger.info(`  🔐 Authentication: Service Account`);
  logger.info('');

  const simulator = new SecureMultiTimeframeSimulator(config);
  
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
    const credentialsPath = process.env.FIREBASE_SERVICE_ACCOUNT || 
                           join(process.cwd(), 'firebase_credentials.json');
    
    await simulator.initializeFirebase(
      process.env.FIREBASE_DATABASE_URL,
      credentialsPath
    );
    
    await simulator.run();
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  }
}

main();