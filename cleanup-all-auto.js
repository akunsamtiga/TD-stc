#!/usr/bin/env node

/**
 * =======================================================
 * REALTIME DATABASE AUTO CLEANUP - DELETE ALL DATA
 * FIXED: Dynamic scanning with shallow query + pagination
 * FIXED: ES Module compatible (no require())
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

// Paths yang dikenal berpotensi besar
const LARGE_PATHS = ['ohlc_1s', 'ohlc_1m', 'ohlc_5m', 'ticks', 'trades'];
const MEDIUM_PATHS = ['ohlc_15m', 'ohlc_30m', 'ohlc_1h', 'ohlc_4h', 'ohlc_1d'];

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

function restApiRequest(dbUrl, path, authToken, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const queryParams = new URLSearchParams({ ...params, auth: authToken });
    const pathEncoded = path === '/' ? '' : path;
    const fullUrl = `${dbUrl.replace(/\/$/, '')}/${pathEncoded}.json?${queryParams.toString()}`;
    
    const req = https.get(fullUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 404) {
            resolve(null);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });
    
    req.on('error', (err) => reject(new Error(`Request failed: ${err.message}`)));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    });
  });
}

async function scanRootShallow(dbUrl, token) {
  try {
    log('🔍 Scanning root with shallow query...', 'cyan');
    const result = await restApiRequest(dbUrl, '/', token, { shallow: 'true' }, 30000);
    
    if (!result || typeof result !== 'object') {
      return [];
    }
    
    const keys = Object.keys(result);
    log(`✅ Found ${keys.length} top-level paths via shallow scan`, 'green');
    return keys;
  } catch (error) {
    log(`⚠️  Shallow scan failed: ${error.message}`, 'yellow');
    return null;
  }
}

async function scanRootPaginated(db, batchSize = 100) {
  try {
    log('🔍 Scanning root with pagination (fallback)...', 'cyan');
    const allKeys = new Set();
    let lastKey = null;
    let iteration = 0;
    const maxIterations = 1000;
    
    while (iteration < maxIterations) {
      iteration++;
      let query = db.ref('/').orderByKey();
      
      if (lastKey) {
        query = query.startAfter(lastKey);
      }
      
      query = query.limitToFirst(batchSize);
      
      const snapshot = await query.once('value');
      
      if (!snapshot.exists()) break;
      
      let foundInBatch = 0;
      snapshot.forEach((child) => {
        allKeys.add(child.key);
        lastKey = child.key;
        foundInBatch++;
      });
      
      if (foundInBatch === 0) break;
      
      if (iteration % 10 === 0) {
        process.stdout.write(`\r   Scanned ${allKeys.size} keys so far...`);
      }
      
      if (foundInBatch === batchSize) {
        await sleep(100);
      } else {
        break;
      }
    }
    
    console.log();
    log(`✅ Found ${allKeys.size} top-level paths via pagination`, 'green');
    return Array.from(allKeys);
  } catch (error) {
    log(`❌ Paginated scan failed: ${error.message}`, 'red');
    return [];
  }
}

async function estimatePathSize(dbUrl, token, path) {
  try {
    const keys = await restApiRequest(dbUrl, path, token, { shallow: 'true' }, 15000);
    if (keys && typeof keys === 'object') {
      return Object.keys(keys).length;
    }
    return 0;
  } catch (error) {
    return -1;
  }
}

async function getPathKeys(db, dbUrl, token, path) {
  try {
    const result = await restApiRequest(dbUrl, path, token, { shallow: 'true' }, 30000);
    if (result && typeof result === 'object') {
      return Object.keys(result);
    }
    return [];
  } catch (error) {
    const keys = [];
    try {
      const snapshot = await db.ref(path).limitToFirst(10000).once('value');
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

function getBatchSize(path) {
  const pathLower = path.toLowerCase();
  if (LARGE_PATHS.some(p => pathLower.includes(p))) return 5;
  if (MEDIUM_PATHS.some(p => pathLower.includes(p))) return 15;
  return 50;
}

function getDelay(path) {
  const pathLower = path.toLowerCase();
  if (LARGE_PATHS.some(p => pathLower.includes(p))) return 500;
  if (MEDIUM_PATHS.some(p => pathLower.includes(p))) return 200;
  return 100;
}

async function deletePathRecursive(db, dbUrl, token, path, maxDepth = 15, currentDepth = 0) {
  const indent = '  '.repeat(currentDepth);
  const batchSize = getBatchSize(path);
  const delayMs = getDelay(path);
  
  try {
    try {
      await db.ref(path).remove();
      totalDeleted++;
      if (currentDepth <= 2) {
        log(`${indent}✅ Deleted: ${path}`, 'green');
      }
      return { success: true, method: 'direct', count: 1 };
    } catch (error) {
      if (!error.message.includes('WRITE_TOO_BIG') && 
          !error.message.includes('too large') &&
          !error.message.includes('413')) {
        if (currentDepth <= 2) {
          log(`${indent}⚠️  Direct delete failed: ${error.message}`, 'yellow');
        }
      }
    }

    if (currentDepth >= maxDepth) {
      return await deleteInChunks(db, dbUrl, token, path, currentDepth);
    }

    const children = await getPathKeys(db, dbUrl, token, path);
    
    if (children.length === 0) {
      return { success: true, method: 'empty', count: 0 };
    }

    if (currentDepth <= 2) {
      log(`${indent}📊 ${path}: ${children.length.toLocaleString()} children`, 'cyan');
    }

    let deletedCount = 0;
    let lastProgress = 0;
    
    for (let i = 0; i < children.length; i += batchSize) {
      const batch = children.slice(i, i + batchSize);
      
      for (const childKey of batch) {
        const childPath = `${path}/${childKey}`;
        try {
          const result = await deletePathRecursive(db, dbUrl, token, childPath, maxDepth, currentDepth + 1);
          if (result.success) {
            deletedCount += result.count || 1;
          }
        } catch (err) {
          totalFailed++;
          if (currentDepth <= 3) {
            log(`${indent}   ❌ Failed: ${childKey}`, 'red');
          }
        }
      }
      
      if (currentDepth <= 2 && children.length > 100) {
        const progress = Math.min(i + batchSize, children.length);
        if (progress - lastProgress >= 100 || progress === children.length) {
          const percent = ((progress / children.length) * 100).toFixed(1);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          log(`${indent}⏳ ${path}: ${percent}% (${progress.toLocaleString()}/${children.length.toLocaleString()}) | ${elapsed}s elapsed`, 'cyan');
          lastProgress = progress;
        }
      }
      
      await sleep(delayMs);
    }
    
    try {
      await db.ref(path).remove();
      deletedCount++;
      totalDeleted++;
    } catch (error) {
      await sleep(500);
      try {
        await db.ref(path).remove();
        totalDeleted++;
      } catch (e) {
        // Ignore
      }
    }
    
    return { success: true, method: 'recursive', count: deletedCount };
    
  } catch (error) {
    totalFailed++;
    if (currentDepth <= 2) {
      log(`${indent}❌ Error at ${path}: ${error.message}`, 'red');
    }
    return { success: false, error: error.message, count: 0 };
  }
}

async function deleteInChunks(db, dbUrl, token, path, depth) {
  const indent = '  '.repeat(depth);
  
  try {
    const keys = await getPathKeys(db, dbUrl, token, path);
    if (keys.length === 0) return { success: true, method: 'empty', count: 0 };

    log(`${indent}🔪 Chunking ${keys.length.toLocaleString()} items at ${path}`, 'magenta');
    
    let deletedCount = 0;
    const chunkSize = 10;
    
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      
      await Promise.all(chunk.map(async (key) => {
        try {
          await db.ref(`${path}/${key}`).remove();
          deletedCount++;
          totalDeleted++;
        } catch (error) {
          totalFailed++;
        }
      }));
      
      if (i % 100 === 0) {
        const progress = Math.min(i + chunkSize, keys.length);
        log(`${indent}   Progress: ${progress.toLocaleString()}/${keys.length.toLocaleString()}`, 'cyan');
      }
      
      await sleep(200);
    }
    
    try {
      await db.ref(path).remove();
      totalDeleted++;
    } catch (error) {
      // Ignore
    }
    
    return { success: true, method: 'chunked', count: deletedCount };
    
  } catch (error) {
    totalFailed++;
    return { success: false, error: error.message, count: 0 };
  }
}

async function deleteAllData(db, dbUrl, token) {
  try {
    log('\n' + '='.repeat(70), 'cyan');
    log('🚀 STARTING DYNAMIC DATABASE CLEANUP', 'bold');
    log('🔍 Mode: Auto-scan all top-level paths', 'blue');
    log('='.repeat(70), 'cyan');
    
    let topLevelKeys = await scanRootShallow(dbUrl, token);
    
    if (!topLevelKeys || topLevelKeys.length === 0) {
      log('⚠️  Trying fallback scan method...', 'yellow');
      topLevelKeys = await scanRootPaginated(db, 100);
    }
    
    if (topLevelKeys.length === 0) {
      log('✅ Database appears to be empty', 'green');
      return true;
    }

    log(`\n📋 Discovered ${topLevelKeys.length} top-level paths:`, 'yellow');
    
    const sortedKeys = topLevelKeys.sort((a, b) => {
      const aIsLarge = LARGE_PATHS.some(p => a.toLowerCase().includes(p));
      const bIsLarge = LARGE_PATHS.some(p => b.toLowerCase().includes(p));
      if (aIsLarge && !bIsLarge) return 1;
      if (!aIsLarge && bIsLarge) return -1;
      return a.localeCompare(b);
    });
    
    sortedKeys.forEach((key, idx) => {
      const isLarge = LARGE_PATHS.some(p => key.toLowerCase().includes(p));
      const isMedium = MEDIUM_PATHS.some(p => key.toLowerCase().includes(p));
      let marker = '';
      if (isLarge) marker = ' [LARGE - Slow]';
      else if (isMedium) marker = ' [Medium]';
      else marker = ' [Small - Fast]';
      
      log(`   ${idx + 1}. /${key}${marker}`, isLarge ? 'red' : (isMedium ? 'yellow' : 'blue'));
    });
    
    log(`\n⚠️  WARNING: Found ${topLevelKeys.length} paths to delete`, 'red');
    log('⏱️  Estimated time: Small paths (seconds), OHLC 1s (15-30 mins)\n', 'yellow');
    
    await sleep(2000);
    
    let successCount = 0;
    
    for (let i = 0; i < sortedKeys.length; i++) {
      const key = sortedKeys[i];
      const path = `/${key}`;
      const pathNum = i + 1;
      
      const isLarge = LARGE_PATHS.some(p => key.toLowerCase().includes(p));
      const warningColor = isLarge ? 'red' : 'cyan';
      
      log(`\n[${pathNum}/${sortedKeys.length}] 🗑️  Processing: ${path}`, warningColor);
      if (isLarge) {
        log('   ⚠️  LARGE DATASET - Using ultra-conservative settings', 'yellow');
      }
      log('-'.repeat(70), 'cyan');
      
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;
      
      while (attempts < maxAttempts && !success) {
        attempts++;
        
        if (attempts > 1) {
          log(`   🔄 Retry attempt ${attempts}/${maxAttempts}...`, 'yellow');
          await sleep(5000);
        }
        
        try {
          const result = await deletePathRecursive(db, dbUrl, token, path);
          
          if (result.success) {
            log(`   ✅ Completed: ${path} (${result.count.toLocaleString()} nodes)`, 'green');
            successCount++;
            success = true;
          } else {
            log(`   ⚠️  Partial success for ${path}`, 'yellow');
          }
        } catch (error) {
          log(`   ❌ Attempt ${attempts} failed: ${error.message}`, 'red');
          if (attempts >= maxAttempts) {
            log(`   ❌ Failed to delete ${path} after ${maxAttempts} attempts`, 'red');
          }
        }
      }
      
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = totalDeleted > 0 ? (totalDeleted / parseFloat(elapsed)).toFixed(1) : '0';
      log(`\n📊 Progress: ${pathNum}/${sortedKeys.length} paths | ` +
          `✅ ${totalDeleted.toLocaleString()} deleted | ❌ ${totalFailed} failed | ` +
          `⏱️  ${elapsed}s | 📈 ${rate} nodes/s`, 'magenta');
      
      if (i < sortedKeys.length - 1) {
        await sleep(2000);
      }
    }

    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    log('\n' + '='.repeat(70), 'cyan');
    log('🎉 CLEANUP COMPLETED', 'bold');
    log('='.repeat(70), 'cyan');
    log(`✅ Successfully processed: ${successCount}/${sortedKeys.length} paths`, 'green');
    log(`✅ Total nodes deleted: ${totalDeleted.toLocaleString()}`, 'green');
    
    if (totalFailed > 0) {
      log(`❌ Total failures: ${totalFailed}`, 'red');
    }
    
    log(`⏱️  Total time: ${totalElapsed}s (${(totalElapsed/60).toFixed(1)} minutes)`, 'blue');
    log(`📈 Average rate: ${(totalDeleted / parseFloat(totalElapsed)).toFixed(2)} nodes/s`, 'blue');
    
    log('\n🔍 Verifying cleanup...', 'cyan');
    const remainingKeys = await scanRootShallow(dbUrl, token);
    if (!remainingKeys || remainingKeys.length === 0) {
      log('✅ Database is now empty!', 'green');
      return true;
    } else {
      log(`⚠️  ${remainingKeys.length} paths still remain:`, 'yellow');
      remainingKeys.forEach(key => log(`   - /${key}`, 'yellow'));
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
    log('█       REALTIME DATABASE AUTO CLEANUP - DYNAMIC SCANNING           █', 'cyan');
    log('█              (Auto-discovery + Memory Optimized)                  █', 'cyan');
    log('█                                                                    █', 'cyan');
    log('█'.repeat(70), 'cyan');
    
    const { db, token, dbUrl } = await initFirebase();
    
    log('\n⚙️  Configuration:', 'blue');
    log(`   Database: ${dbUrl}`, 'blue');
    
    await sleep(1000);
    
    const success = await deleteAllData(db, dbUrl, token);
    
    const exitCode = success ? 0 : 1;
    
    log('\n👋 Process finished', success ? 'green' : 'yellow');
    process.exit(exitCode);
    
  } catch (error) {
    log(`\n❌ Fatal error: ${error.message}`, 'red');
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  log('\n⚠️  SIGTERM received - graceful shutdown...', 'yellow');
  log(`📊 Final stats: ${totalDeleted.toLocaleString()} deleted, ${totalFailed} failed`, 'blue');
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('\n⚠️  SIGINT received (Ctrl+C) - stopping...', 'yellow');
  log(`📊 Progress: ${totalDeleted.toLocaleString()} nodes deleted`, 'blue');
  log('💡 You can resume by running the script again', 'blue');
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