#!/usr/bin/env node

/**
 * =======================================================
 * REALTIME DATABASE AUTO CLEANUP - DELETE ALL DATA
 * FIXED: Stuck on large root scan, now using targeted paths
 * =======================================================
 * 
 * CARA PAKAI:
 * 1. Jalankan dengan PM2:
 *    pm2 start cleanup-all-auto.js --name "db-cleanup" --node-args="--max-old-space-size=4096"
 * 
 * 2. Monitor progress:
 *    pm2 logs db-cleanup
 * 
 * 3. Stop jika perlu:
 *    pm2 stop db-cleanup
 * 
 * FIXES:
 * - Tidak lagi scan root (/) yang bikin hang pada DB besar
 * - Menggunakan Firebase REST API shallow query untuk check paths
 * - Chunk size dinamis: kecil untuk OHLC 1s/1m, besar untuk lainnya
 * - Progress tracking real-time dengan ETA
 * 
 * =======================================================
 */

import admin from 'firebase-admin';
import dotenv from 'dotenv';
import https from 'https';

dotenv.config();

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function log(message, color = 'reset') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${colors[color]}${message}${colors.reset}`);
}

// Predefined paths berdasarkan struktur database kamu
const PREDEFINED_PATHS = [
  'btcusd',
  'current_price',
  'change',
  'datetime',
  'datetime_iso',
  'price',
  'timestamp',
  'timezone',
  'ohlc_15m',
  'ohlc_1d',
  'ohlc_1h',
  'ohlc_1m',
  'ohlc_1s',    // Hati-hati: sangat besar!
  'ohlc_30m',
  'ohlc_4h',
  'ohlc_5m'
];

// Paths yang dikenal besar (perlu treatment khusus)
const LARGE_PATHS = ['ohlc_1s', 'ohlc_1m', 'ohlc_5m'];
const MEDIUM_PATHS = ['ohlc_15m', 'ohlc_30m', 'ohlc_1h', 'ohlc_4h', 'ohlc_1d', 'btcusd'];

let totalDeleted = 0;
let totalFailed = 0;
let startTime = Date.now();

async function initFirebase() {
  try {
    const serviceAccount = {
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    };

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_REALTIME_DB_URL,
      });
    }

    const db = admin.database();
    
    // Get access token untuk REST API calls
    const accessToken = await admin.app().options.credential.getAccessToken();
    
    log('✅ Firebase initialized successfully', 'green');
    
    return { 
      db, 
      token: accessToken.access_token, 
      dbUrl: process.env.FIREBASE_REALTIME_DB_URL 
    };
  } catch (error) {
    log(`❌ Firebase initialization failed: ${error.message}`, 'red');
    process.exit(1);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Menggunakan Firebase REST API dengan shallow=true
 * Hanya mengambil keys, tidak fetch values (jauh lebih cepat & ringan)
 */
async function getKeysShallow(dbUrl, path, authToken, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const encodedPath = path === '/' ? '' : encodeURIComponent(path).replace(/%2F/g, '/');
    const url = `${dbUrl.replace(/\/$/, '')}/${encodedPath}.json?shallow=true&auth=${authToken}`;
    
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 404) {
            resolve([]); // Path tidak exists
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          const json = JSON.parse(data);
          resolve(Object.keys(json || {}));
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    });
  });
}

async function checkPathExists(dbUrl, path, authToken) {
  try {
    const keys = await getKeysShallow(dbUrl, path, authToken, 10000); // 10s timeout untuk check
    return keys.length > 0;
  } catch (error) {
    return false;
  }
}

// FIXED: Get keys dengan fallback ke REST API shallow query
async function getKeysOnly(db, dbUrl, token, path) {
  try {
    // Coba pakai REST API dulu (lebih cepat untuk paths besar)
    const keys = await getKeysShallow(dbUrl, path, token);
    return keys;
  } catch (error) {
    // Fallback ke Admin SDK kalau REST gagal
    log(`   ⚠️  REST API failed for ${path}, falling back to Admin SDK...`, 'yellow');
    try {
      const snapshot = await db.ref(path).once('value');
      if (!snapshot.exists()) return [];
      
      const keys = [];
      snapshot.forEach((child) => {
        keys.push(child.key);
        return false;
      });
      return keys;
    } catch (sdkError) {
      log(`   ❌ Failed to get keys for ${path}: ${sdkError.message}`, 'red');
      return [];
    }
  }
}

// Estimate count dengan shallow query
async function estimateChildrenCount(dbUrl, token, path) {
  try {
    const keys = await getKeysShallow(dbUrl, path, token);
    return keys.length;
  } catch (error) {
    return 0;
  }
}

// Get optimal batch size berdasarkan tipe path
function getBatchSize(path) {
  if (LARGE_PATHS.some(p => path.includes(p))) return 10;  // OHLC 1s/1m: batch kecil
  if (MEDIUM_PATHS.some(p => path.includes(p))) return 25; // OHLC medium: batch medium
  return 50; // Paths kecil: batch besar
}

// Get optimal delay berdasarkan tipe path
function getDelay(path) {
  if (LARGE_PATHS.some(p => path.includes(p))) return 300;  // OHLC 1s/1m: delay besar
  if (MEDIUM_PATHS.some(p => path.includes(p))) return 150; // OHLC medium: delay medium
  return 50; // Paths kecil: delay kecil
}

async function deletePathRecursive(db, dbUrl, token, path, maxDepth = 10, currentDepth = 0) {
  const indent = '  '.repeat(currentDepth);
  const batchSize = getBatchSize(path);
  const delayMs = getDelay(path);
  
  try {
    // Try direct delete first (untuk leaf nodes)
    try {
      await db.ref(path).remove();
      totalDeleted++;
      log(`${indent}✅ Deleted (direct): ${path}`, 'green');
      return { success: true, method: 'direct', count: 1 };
    } catch (error) {
      // Kalau error karena size, lanjut ke recursive
      if (!error.message.includes('WRITE_TOO_BIG') && 
          !error.message.includes('too large') &&
          !error.message.includes('413')) {
        throw error;
      }
    }

    if (currentDepth >= maxDepth) {
      return await deleteInChunks(db, dbUrl, token, path, currentDepth);
    }

    // FIXED: Gunakan REST API shallow untuk get keys
    const children = await getKeysOnly(db, dbUrl, token, path);
    
    if (children.length === 0) {
      log(`${indent}ℹ️  ${path} is empty`, 'blue');
      return { success: true, method: 'empty', count: 0 };
    }

    log(`${indent}📊 Found ${children.length.toLocaleString()} children in ${path} (batch: ${batchSize}, delay: ${delayMs}ms)`, 'cyan');
    
    let deletedCount = 0;
    
    for (let i = 0; i < children.length; i += batchSize) {
      const batch = children.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(
        batch.map(async (childKey) => {
          const childPath = `${path}/${childKey}`;
          return await deletePathRecursive(db, dbUrl, token, childPath, maxDepth, currentDepth + 1);
        })
      );
      
      results.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value.success) {
          deletedCount += result.value.count || 1;
        } else {
          totalFailed++;
          log(`${indent}❌ Failed: ${batch[idx]}`, 'red');
        }
      });
      
      const progress = Math.min(i + batchSize, children.length);
      const percent = ((progress / children.length) * 100).toFixed(1);
      
      // Progress report untuk paths besar
      if (children.length > 1000 && (i % (batchSize * 10) === 0 || progress === children.length)) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = deletedCount / elapsed;
        const eta = ((children.length - progress) / rate) / 60; // dalam menit
        
        log(`${indent}⏳ ${path}: ${percent}% (${progress.toLocaleString()}/${children.length.toLocaleString()}) | ` +
            `ETA: ${eta.toFixed(1)}m | Rate: ${rate.toFixed(1)} nodes/s`, 'cyan');
      }
      
      await sleep(delayMs);
    }
    
    // Coba hapus parent setelah children hilang
    try {
      await db.ref(path).remove();
      totalDeleted++;
      log(`${indent}✅ Deleted parent: ${path}`, 'green');
      deletedCount++;
    } catch (error) {
      await sleep(1000);
      try {
        await db.ref(path).remove();
        totalDeleted++;
        log(`${indent}✅ Deleted parent (retry): ${path}`, 'green');
        deletedCount++;
      } catch (retryError) {
        totalFailed++;
        log(`${indent}❌ Failed to delete parent: ${path}`, 'red');
      }
    }
    
    return { success: true, method: 'recursive', count: deletedCount };
    
  } catch (error) {
    totalFailed++;
    log(`${indent}❌ Error: ${error.message}`, 'red');
    return { success: false, error: error.message, count: 0 };
  }
}

async function deleteInChunks(db, dbUrl, token, path, depth) {
  const indent = '  '.repeat(depth);
  const batchSize = getBatchSize(path);
  
  try {
    const keys = await getKeysOnly(db, dbUrl, token, path);
    if (keys.length === 0) return { success: true, method: 'empty', count: 0 };

    log(`${indent}🔪 Chunking ${keys.length.toLocaleString()} items at ${path}`, 'magenta');
    
    let deletedCount = 0;
    
    for (let i = 0; i < keys.length; i += batchSize) {
      const chunk = keys.slice(i, i + batchSize);
      
      for (const key of chunk) {
        try {
          await db.ref(`${path}/${key}`).remove();
          deletedCount++;
          totalDeleted++;
        } catch (error) {
          totalFailed++;
          log(`${indent}❌ Failed: ${path}/${key}`, 'red');
        }
        await sleep(50);
      }
      
      if (i % (batchSize * 5) === 0) {
        const progress = Math.min(i + batchSize, keys.length);
        log(`${indent}⏳ Progress: ${progress.toLocaleString()}/${keys.length.toLocaleString()}`, 'cyan');
      }
      
      await sleep(100);
    }
    
    // Delete parent
    try {
      await db.ref(path).remove();
      deletedCount++;
      totalDeleted++;
      log(`${indent}✅ Deleted: ${path}`, 'green');
    } catch (error) {
      log(`${indent}⚠️  Could not delete parent: ${error.message}`, 'yellow');
    }
    
    return { success: true, method: 'chunked', count: deletedCount };
    
  } catch (error) {
    totalFailed++;
    log(`${indent}❌ Chunk deletion error: ${error.message}`, 'red');
    return { success: false, error: error.message, count: 0 };
  }
}

async function deleteAllData(db, dbUrl, token) {
  try {
    log('\n' + '='.repeat(70), 'cyan');
    log('🚀 STARTING TARGETED DATABASE CLEANUP', 'bold');
    log('='.repeat(70), 'cyan');
    log('⚠️  This will DELETE ALL DATA in predefined paths', 'red');
    log('='.repeat(70), 'cyan');
    
    // Check which paths exist using shallow query (cepat & tidak memory intensive)
    log('\n📂 Checking which paths exist (using shallow query)...', 'cyan');
    
    const existingPaths = [];
    for (const key of PREDEFINED_PATHS) {
      process.stdout.write(`   Checking /${key}... `);
      const count = await estimateChildrenCount(dbUrl, token, `/${key}`);
      
      if (count > 0) {
        existingPaths.push({ key, count });
        console.log(`${colors.green}EXISTS (${count.toLocaleString()} children)${colors.reset}`);
      } else {
        console.log(`${colors.blue}EMPTY/NOT FOUND${colors.reset}`);
      }
    }
    
    if (existingPaths.length === 0) {
      log('\n✅ Database is already empty', 'green');
      return true;
    }

    log(`\n📊 Summary: ${existingPaths.length} paths to delete`, 'yellow');
    log('   Priority: Large paths (OHLC 1s/1m) will use small batches\n', 'yellow');
    
    let successCount = 0;
    
    for (let i = 0; i < existingPaths.length; i++) {
      const { key, count } = existingPaths[i];
      const path = `/${key}`;
      const pathNum = i + 1;
      
      log(`\n[${pathNum}/${existingPaths.length}] 🗑️  Processing: ${path} (~${count.toLocaleString()} items)`, 'cyan');
      log('-'.repeat(70), 'cyan');
      
      // Warning khusus untuk paths besar
      if (LARGE_PATHS.includes(key)) {
        log('   ⚠️  LARGE DATASET DETECTED - This will take time (15-30 mins estimated)', 'yellow');
        log('   💡 Tips: Jika stuck, restart script -akan melanjutkan dari yang belum terhapus', 'blue');
      }
      
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;
      
      while (attempts < maxAttempts && !success) {
        attempts++;
        
        if (attempts > 1) {
          log(`   🔄 Retry attempt ${attempts}/${maxAttempts}`, 'yellow');
          await sleep(3000);
        }
        
        try {
          const result = await deletePathRecursive(db, dbUrl, token, path);
          
          if (result.success) {
            log(`   ✅ Completed: ${path} (${result.count.toLocaleString()} nodes deleted)`, 'green');
            successCount++;
            success = true;
          } else {
            log(`   ⚠️  Partial deletion: ${result.error}`, 'yellow');
          }
        } catch (error) {
          log(`   ❌ Attempt ${attempts} failed: ${error.message}`, 'red');
          
          if (attempts >= maxAttempts) {
            log(`   ❌ Giving up on ${path} after ${maxAttempts} attempts`, 'red');
          }
        }
      }
      
      await sleep(1000);
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (totalDeleted / parseFloat(elapsed)).toFixed(1);
      log(`\n📊 Overall: ${pathNum}/${existingPaths.length} paths | ` +
          `✅ ${totalDeleted.toLocaleString()} deleted | ❌ ${totalFailed} failed | ` +
          `⏱️  ${elapsed}s | 📈 ${rate} nodes/s`, 'magenta');
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    log('\n' + '='.repeat(70), 'cyan');
    log('🎉 CLEANUP COMPLETED', 'bold');
    log('='.repeat(70), 'cyan');
    log(`✅ Successfully processed: ${successCount}/${existingPaths.length} paths`, 'green');
    log(`✅ Total nodes deleted: ${totalDeleted.toLocaleString()}`, 'green');
    
    if (totalFailed > 0) {
      log(`❌ Total failures: ${totalFailed}`, 'red');
      log(`⚠️  Some data might remain - re-run script to clean remaining data`, 'yellow');
    }
    
    log(`⏱️  Total time: ${totalElapsed}s`, 'blue');
    log(`📈 Average rate: ${(totalDeleted / parseFloat(totalElapsed)).toFixed(2)} nodes/s`, 'blue');
    log('='.repeat(70), 'cyan');
    
    // Verification dengan shallow query
    log('\n🔍 Verifying cleanup...', 'cyan');
    let remainingCount = 0;
    for (const key of PREDEFINED_PATHS) {
      const count = await estimateChildrenCount(dbUrl, token, `/${key}`);
      if (count > 0) {
        remainingCount++;
        log(`   ⚠️  /${key}: ${count.toLocaleString()} items remaining`, 'yellow');
      }
    }
    
    if (remainingCount === 0) {
      log('✅ All predefined paths are now empty!', 'green');
      return true;
    } else {
      log(`⚠️  ${remainingCount} paths still have data`, 'yellow');
      log('💡 Re-run script to clean remaining data', 'blue');
      return false;
    }

  } catch (error) {
    log(`\n❌ Fatal error: ${error.message}`, 'red');
    log(error.stack, 'red');
    return false;
  }
}

async function main() {
  try {
    log('\n' + '█'.repeat(70), 'cyan');
    log('█                                                                    █', 'cyan');
    log('█       REALTIME DATABASE AUTO CLEANUP - FIXED VERSION              █', 'cyan');
    log('█              (Targeted Paths + REST API Shallow Query)            █', 'cyan');
    log('█                                                                    █', 'cyan');
    log('█'.repeat(70), 'cyan');
    
    const { db, token, dbUrl } = await initFirebase();
    
    await sleep(1000);
    
    const success = await deleteAllData(db, dbUrl, token);
    
    const exitCode = success ? 0 : 1;
    
    log('\n👋 Cleanup process finished', success ? 'green' : 'yellow');
    log(`Exit code: ${exitCode}`, success ? 'green' : 'yellow');
    
    await sleep(2000);
    process.exit(exitCode);
    
  } catch (error) {
    log(`\n❌ Fatal error in main: ${error.message}`, 'red');
    log(error.stack, 'red');
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  log('\n⚠️  SIGTERM received - graceful shutdown...', 'yellow');
  log(`📊 Progress: ${totalDeleted.toLocaleString()} deleted, ${totalFailed} failed`, 'blue');
  await sleep(1000);
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('\n⚠️  SIGINT received - graceful shutdown...', 'yellow');
  log(`📊 Progress: ${totalDeleted.toLocaleString()} deleted, ${totalFailed} failed`, 'blue');
  await sleep(1000);
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log(`\n❌ Uncaught exception: ${error.message}`, 'red');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log(`\n❌ Unhandled rejection: ${reason}`, 'red');
  process.exit(1);
});

main();