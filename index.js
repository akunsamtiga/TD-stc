import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
import { createLogger, format, transports } from 'winston';
import dns from 'dns';
import { promisify } from 'util';

dotenv.config();

// ============================================
// DNS FIX untuk Windows/Node.js
// ============================================
// Force IPv4 first (fix untuk ENOTFOUND error)
dns.setDefaultResultOrder('ipv4first');

// Set Google DNS & Cloudflare DNS
dns.setServers([
  '8.8.8.8',      // Google Primary
  '8.8.4.4',      // Google Secondary
  '1.1.1.1',      // Cloudflare Primary
  '1.0.0.1'       // Cloudflare Secondary
]);

// Test DNS resolution
const dnsResolve = promisify(dns.resolve4);
async function testDNS() {
  try {
    const addresses = await dnsResolve('accounts.google.com');
    console.log('✅ DNS Resolution Test: SUCCESS');
    console.log(`   Resolved accounts.google.com → ${addresses[0]}`);
    return true;
  } catch (error) {
    console.error('❌ DNS Resolution Test: FAILED');
    console.error(`   Error: ${error.message}`);
    return false;
  }
}

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
// IDX_STC SIMULATOR CLASS
// ============================================
class IDXSTCSimulator {
  constructor(config) {
    this.initialPrice = parseFloat(config.initialPrice);
    this.currentPrice = this.initialPrice;
    this.assetName = config.assetName;
    this.timezone = config.timezone;
    
    // Volatility settings
    this.dailyVolatilityMin = parseFloat(config.dailyVolatilityMin);
    this.dailyVolatilityMax = parseFloat(config.dailyVolatilityMax);
    this.secondVolatilityMin = parseFloat(config.secondVolatilityMin);
    this.secondVolatilityMax = parseFloat(config.secondVolatilityMax);
    
    // Data retention
    this.dataRetentionDays = parseInt(config.dataRetentionDays);
    this.cleanupIntervalHours = parseInt(config.cleanupIntervalHours);
    
    // State tracking
    this.lastDirection = 1;
    this.iteration = 0;
    this.lastCleanup = Date.now();
    
    logger.info(`${this.assetName} Simulator initialized`);
    logger.info(`Initial Price: ${this.initialPrice}`);
    logger.info(`Timezone: ${this.timezone}`);
  }

  async initializeFirebase(credsPath, databaseURL) {
    try {
      logger.info('🔍 Testing DNS resolution...');
      const dnsOk = await testDNS();
      
      if (!dnsOk) {
        logger.warn('⚠️  DNS test failed, but continuing...');
      }

      logger.info('📥 Loading Firebase credentials...');
      const serviceAccount = JSON.parse(readFileSync(credsPath, 'utf8'));
      
      logger.info('🔐 Initializing Firebase Admin SDK...');
      
      // Initialize with extended timeout and retry options
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: databaseURL,
        httpAgent: undefined, // Let SDK use default agent
      });
      
      this.db = admin.database();
      this.ohlcRef = this.db.ref(`/${this.assetName.toLowerCase()}/ohlc`);
      this.currentPriceRef = this.db.ref(`/${this.assetName.toLowerCase()}/current_price`);
      this.statsRef = this.db.ref(`/${this.assetName.toLowerCase()}/stats`);
      
      // Test connection
      logger.info('🔌 Testing Firebase connection...');
      await this.currentPriceRef.once('value');
      
      logger.info('✅ Firebase initialized successfully');
      return true;
    } catch (error) {
      logger.error(`❌ Firebase initialization error: ${error.message}`);
      logger.error(`   Error code: ${error.code || 'unknown'}`);
      
      if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
        logger.error('');
        logger.error('💡 DNS Resolution Issue Detected!');
        logger.error('   Possible solutions:');
        logger.error('   1. Run in Command Prompt (not Git Bash)');
        logger.error('   2. Disable VPN/Proxy temporarily');
        logger.error('   3. Check Windows Firewall settings');
        logger.error('   4. Restart your computer');
        logger.error('');
      }
      
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
    // Random walk with momentum
    const volatility = this.secondVolatilityMin + 
      Math.random() * (this.secondVolatilityMax - this.secondVolatilityMin);
    
    let direction = Math.random() < 0.5 ? -1 : 1;
    
    // 70% chance to continue previous direction (momentum)
    if (Math.random() < 0.7) {
      direction = this.lastDirection;
    }
    
    this.lastDirection = direction;
    
    // Calculate price change
    const priceChange = this.currentPrice * volatility * direction;
    let newPrice = this.currentPrice + priceChange;
    
    // Price bounds (50% - 200% of initial)
    const minPrice = this.initialPrice * 0.5;
    const maxPrice = this.initialPrice * 2.0;
    
    if (newPrice < minPrice) newPrice = minPrice;
    if (newPrice > maxPrice) newPrice = maxPrice;
    
    return newPrice;
  }

  generateOHLCBar(timestamp) {
    const openPrice = this.currentPrice;
    
    // Generate 4 price points for realistic OHLC
    const prices = [openPrice];
    for (let i = 0; i < 3; i++) {
      prices.push(this.generatePriceMovement());
    }
    
    const closePrice = prices[prices.length - 1];
    const highPrice = Math.max(...prices);
    const lowPrice = Math.min(...prices);
    
    // Update current price
    this.currentPrice = closePrice;
    
    // Generate volume
    const volume = Math.floor(1000 + Math.random() * 49000);
    
    // Format datetime
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
      await this.ohlcRef.child(timestampKey).set(ohlcData);
      
      // Update current price
      const priceChange = ((ohlcData.close - this.initialPrice) / this.initialPrice) * 100;
      
      await this.currentPriceRef.set({
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
      
    } catch (error) {
      logger.error(`Error saving to Firebase: ${error.message}`);
    }
  }

  async updateStats(ohlcData) {
    try {
      const snapshot = await this.statsRef.once('value');
      const currentStats = snapshot.val() || {};
      
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
      
      await this.statsRef.set(stats);
      
    } catch (error) {
      logger.error(`Error updating stats: ${error.message}`);
    }
  }

  async cleanupOldData() {
    try {
      const currentTime = Math.floor(Date.now() / 1000);
      const cutoffTime = currentTime - (this.dataRetentionDays * 24 * 60 * 60);
      
      const snapshot = await this.ohlcRef.once('value');
      const allData = snapshot.val() || {};
      
      let deletedCount = 0;
      const deletePromises = [];
      
      for (const timestampKey in allData) {
        if (parseInt(timestampKey) < cutoffTime) {
          deletePromises.push(this.ohlcRef.child(timestampKey).remove());
          deletedCount++;
        }
      }
      
      await Promise.all(deletePromises);
      
      if (deletedCount > 0) {
        logger.info(`🗑️  Cleaned up ${deletedCount} old records`);
      }
      
    } catch (error) {
      logger.error(`Error cleaning up old data: ${error.message}`);
    }
  }

  async run() {
    logger.info(`🚀 Starting ${this.assetName} simulator...`);
    logger.info(`📍 Timezone: ${this.timezone}`);
    logger.info('⏱️  Synchronizing with system clock...');
    
    // Wait for next second boundary
    await this.waitForNextSecond();
    
    const startTime = this.getCurrentTime();
    logger.info(`✅ Synchronized! Starting at ${this.formatDateTime(startTime).datetime}`);
    logger.info('Press Ctrl+C to stop\n');
    
    const cleanupIntervalMs = this.cleanupIntervalHours * 60 * 60 * 1000;
    
    // Main loop
    const runLoop = async () => {
      try {
        const timestamp = Date.now();
        const startProcess = Date.now();
        
        // Generate and save OHLC
        const ohlcData = this.generateOHLCBar(timestamp);
        await this.saveToFirebase(ohlcData);
        
        const processTime = (Date.now() - startProcess) / 1000;
        this.iteration++;
        
        // Warning if processing too slow
        if (processTime > 0.5) {
          logger.warn(`⚠️  Processing took ${processTime.toFixed(3)}s - may affect precision`);
        }
        
        // Periodic cleanup
        if (Date.now() - this.lastCleanup > cleanupIntervalMs) {
          await this.cleanupOldData();
          this.lastCleanup = Date.now();
        }
        
        // Wait for next second
        await this.waitForNextSecond();
        runLoop();
        
      } catch (error) {
        logger.error(`Simulator error: ${error.message}`);
        process.exit(1);
      }
    };
    
    runLoop();
  }

  async stop() {
    logger.info('\n⏹️  Simulator stopped by user');
    logger.info(`📊 Total iterations: ${this.iteration}`);
    await admin.app().delete();
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
  
  // Handle graceful shutdown
  process.on('SIGINT', () => simulator.stop());
  process.on('SIGTERM', () => simulator.stop());
  
  try {
    // Initialize Firebase
    await simulator.initializeFirebase(
      'firebase_credentials.json',
      process.env.FIREBASE_DATABASE_URL
    );
    
    // Run simulator
    await simulator.run();
    
  } catch (error) {
    logger.error(`❌ Fatal error: ${error.message}`);
    process.exit(1);
  }
}

main();