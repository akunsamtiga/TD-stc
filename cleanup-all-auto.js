#!/usr/bin/env node

/**
 * =======================================================
 * REALTIME DATABASE AUTO CLEANUP - DELETE ALL DATA
 * =======================================================
 * 
 * CARA PAKAI:
 * 1. Pastikan .env sudah dikonfigurasi dengan benar
 * 2. Jalankan dengan PM2:
 *    pm2 start cleanup-all-auto.js --name "db-cleanup"
 * 
 * 3. Monitor progress:
 *    pm2 logs db-cleanup
 * 
 * 4. Stop jika perlu:
 *    pm2 stop db-cleanup
 * 
 * Script ini akan:
 * - Menghapus SEMUA data di Realtime Database
 * - Otomatis batch untuk data besar
 * - Recursive delete untuk path yang besar
 * - Auto-retry jika gagal
 * - Selesai otomatis setelah semua terhapus
 * 
 * =======================================================
 */

import admin from 'firebase-admin';
import dotenv from 'dotenv';

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
    log('✅ Firebase initialized successfully', 'green');
    return db;
  } catch (error) {
    log(`❌ Firebase initialization failed: ${error.message}`, 'red');
    process.exit(1);
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getChildrenCount(db, path) {
  try {
    const snapshot = await db.ref(path).once('value');
    const data = snapshot.val();
    
    if (!data || typeof data !== 'object') {
      return 0;
    }
    
    return Object.keys(data).length;
  } catch (error) {
    log(`⚠️  Error counting children at ${path}: ${error.message}`, 'yellow');
    return 0;
  }
}

async function deletePathRecursive(db, path, maxDepth = 10, currentDepth = 0) {
  const indent = '  '.repeat(currentDepth);
  
  try {
    // Try direct delete first
    try {
      await db.ref(path).remove();
      totalDeleted++;
      log(`${indent}✅ Deleted: ${path}`, 'green');
      return { success: true, method: 'direct', count: 1 };
    } catch (error) {
      // If error is not about size, throw it
      if (!error.message.includes('WRITE_TOO_BIG') && 
          !error.message.includes('too large') &&
          !error.message.includes('413')) {
        throw error;
      }
      
      log(`${indent}⚠️  ${path} too large, deleting children recursively...`, 'yellow');
    }

    // If we reach max depth, try to delete in smaller chunks
    if (currentDepth >= maxDepth) {
      log(`${indent}⚠️  Max depth reached at ${path}, attempting chunk deletion...`, 'yellow');
      return await deleteInChunks(db, path, currentDepth);
    }

    // Get children
    const snapshot = await db.ref(path).once('value');
    const data = snapshot.val();
    
    if (!data || typeof data !== 'object') {
      log(`${indent}ℹ️  ${path} is empty or not an object`, 'blue');
      return { success: true, method: 'empty', count: 0 };
    }

    const children = Object.keys(data);
    log(`${indent}📊 Found ${children.length} children in ${path}`, 'cyan');
    
    let deletedCount = 0;
    const batchSize = 25; // Smaller batch for safety
    
    for (let i = 0; i < children.length; i += batchSize) {
      const batch = children.slice(i, i + batchSize);
      
      const results = await Promise.allSettled(
        batch.map(async (childKey) => {
          const childPath = `${path}/${childKey}`;
          return await deletePathRecursive(db, childPath, maxDepth, currentDepth + 1);
        })
      );
      
      results.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value.success) {
          deletedCount += result.value.count || 1;
        } else {
          totalFailed++;
          log(`${indent}❌ Failed to delete child ${batch[idx]}: ${result.reason?.message || 'Unknown error'}`, 'red');
        }
      });
      
      const progress = Math.min(i + batchSize, children.length);
      log(`${indent}⏳ Progress: ${progress}/${children.length} children processed`, 'cyan');
      
      // Small delay between batches to avoid rate limits
      await sleep(150);
    }
    
    // Try to delete parent after all children are gone
    try {
      await db.ref(path).remove();
      totalDeleted++;
      log(`${indent}✅ Deleted parent: ${path}`, 'green');
      deletedCount++;
    } catch (error) {
      log(`${indent}⚠️  Could not delete parent ${path}: ${error.message}`, 'yellow');
      // Try one more time after a delay
      await sleep(500);
      try {
        await db.ref(path).remove();
        totalDeleted++;
        log(`${indent}✅ Deleted parent (retry): ${path}`, 'green');
        deletedCount++;
      } catch (retryError) {
        totalFailed++;
        log(`${indent}❌ Failed to delete parent after retry: ${path}`, 'red');
      }
    }
    
    return { success: true, method: 'recursive', count: deletedCount };
    
  } catch (error) {
    totalFailed++;
    log(`${indent}❌ Error deleting ${path}: ${error.message}`, 'red');
    return { success: false, error: error.message, count: 0 };
  }
}

async function deleteInChunks(db, path, depth) {
  const indent = '  '.repeat(depth);
  
  try {
    const snapshot = await db.ref(path).once('value');
    const data = snapshot.val();
    
    if (!data || typeof data !== 'object') {
      return { success: true, method: 'empty', count: 0 };
    }

    const keys = Object.keys(data);
    log(`${indent}🔪 Chunking ${keys.length} items at ${path}`, 'magenta');
    
    const chunkSize = 10;
    let deletedCount = 0;
    
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      
      for (const key of chunk) {
        try {
          await db.ref(`${path}/${key}`).remove();
          deletedCount++;
          totalDeleted++;
        } catch (error) {
          totalFailed++;
          log(`${indent}❌ Failed to delete ${path}/${key}: ${error.message}`, 'red');
        }
        
        await sleep(50);
      }
      
      log(`${indent}⏳ Chunk progress: ${Math.min(i + chunkSize, keys.length)}/${keys.length}`, 'cyan');
      await sleep(100);
    }
    
    // Delete parent
    try {
      await db.ref(path).remove();
      deletedCount++;
      totalDeleted++;
      log(`${indent}✅ Deleted chunked parent: ${path}`, 'green');
    } catch (error) {
      log(`${indent}⚠️  Could not delete chunked parent: ${error.message}`, 'yellow');
    }
    
    return { success: true, method: 'chunked', count: deletedCount };
    
  } catch (error) {
    totalFailed++;
    log(`${indent}❌ Chunk deletion error: ${error.message}`, 'red');
    return { success: false, error: error.message, count: 0 };
  }
}

async function deleteAllData(db) {
  try {
    log('\n' + '='.repeat(70), 'cyan');
    log('🚀 STARTING AUTOMATIC DATABASE CLEANUP', 'bold');
    log('='.repeat(70), 'cyan');
    log('⚠️  This will DELETE ALL DATA in Realtime Database', 'red');
    log('='.repeat(70), 'cyan');
    
    // Get all top-level paths
    log('\n📂 Fetching all top-level paths...', 'cyan');
    const snapshot = await db.ref('/').once('value');
    const data = snapshot.val();
    
    if (!data) {
      log('✅ Database is already empty', 'green');
      return true;
    }

    const paths = Object.keys(data).map(key => `/${key}`);
    
    log(`\n📊 Found ${paths.length} top-level paths:`, 'yellow');
    paths.forEach((path, idx) => {
      log(`   ${idx + 1}. ${path}`, 'blue');
    });
    
    // Show estimated data size
    log('\n📏 Estimating data size...', 'cyan');
    for (const path of paths) {
      const count = await getChildrenCount(db, path);
      log(`   ${path}: ~${count.toLocaleString()} direct children`, 'blue');
    }
    
    log('\n' + '='.repeat(70), 'cyan');
    log('🗑️  STARTING DELETION PROCESS', 'yellow');
    log('='.repeat(70), 'cyan');
    
    // Delete each path with retry mechanism
    let successCount = 0;
    
    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];
      const pathNum = i + 1;
      
      log(`\n[${ pathNum}/${paths.length}] 🗑️  Processing: ${path}`, 'cyan');
      log('-'.repeat(70), 'cyan');
      
      let attempts = 0;
      const maxAttempts = 3;
      let success = false;
      
      while (attempts < maxAttempts && !success) {
        attempts++;
        
        if (attempts > 1) {
          log(`   🔄 Retry attempt ${attempts}/${maxAttempts} for ${path}`, 'yellow');
          await sleep(2000); // Wait before retry
        }
        
        try {
          const result = await deletePathRecursive(db, path);
          
          if (result.success) {
            log(`   ✅ Successfully deleted ${path} (${result.method}, ${result.count} nodes)`, 'green');
            successCount++;
            success = true;
          } else {
            log(`   ⚠️  Partial deletion of ${path}: ${result.error}`, 'yellow');
          }
        } catch (error) {
          log(`   ❌ Attempt ${attempts} failed: ${error.message}`, 'red');
          
          if (attempts >= maxAttempts) {
            log(`   ❌ Giving up on ${path} after ${maxAttempts} attempts`, 'red');
          }
        }
      }
      
      // Small delay between paths
      await sleep(500);
      
      // Progress summary
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (totalDeleted / parseFloat(elapsed)).toFixed(1);
      log(`\n📊 Overall Progress: ${pathNum}/${paths.length} paths | ` +
          `✅ ${totalDeleted} deleted | ❌ ${totalFailed} failed | ` +
          `⏱️  ${elapsed}s | 📈 ${rate} nodes/s`, 'magenta');
    }

    // Final summary
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    log('\n' + '='.repeat(70), 'cyan');
    log('🎉 CLEANUP COMPLETED', 'bold');
    log('='.repeat(70), 'cyan');
    log(`✅ Successfully processed: ${successCount}/${paths.length} paths`, 'green');
    log(`✅ Total nodes deleted: ${totalDeleted}`, 'green');
    
    if (totalFailed > 0) {
      log(`❌ Total failures: ${totalFailed}`, 'red');
      log(`⚠️  Some data might remain - check manually or re-run`, 'yellow');
    }
    
    log(`⏱️  Total time: ${totalElapsed}s`, 'blue');
    log(`📈 Average rate: ${(totalDeleted / parseFloat(totalElapsed)).toFixed(2)} nodes/s`, 'blue');
    log('='.repeat(70), 'cyan');
    
    // Verify cleanup
    log('\n🔍 Verifying cleanup...', 'cyan');
    const verifySnapshot = await db.ref('/').once('value');
    const remainingData = verifySnapshot.val();
    
    if (!remainingData || Object.keys(remainingData).length === 0) {
      log('✅ Database is now completely empty!', 'green');
      return true;
    } else {
      const remaining = Object.keys(remainingData);
      log(`⚠️  ${remaining.length} paths still remain:`, 'yellow');
      remaining.forEach(path => log(`   - /${path}`, 'yellow'));
      log('💡 Consider re-running the script to clean remaining data', 'blue');
      return false;
    }

  } catch (error) {
    log(`\n❌ Fatal error during cleanup: ${error.message}`, 'red');
    log(error.stack, 'red');
    return false;
  }
}

async function main() {
  try {
    log('\n' + '█'.repeat(70), 'cyan');
    log('█                                                                    █', 'cyan');
    log('█       REALTIME DATABASE AUTO CLEANUP - DELETE ALL DATA            █', 'cyan');
    log('█                                                                    █', 'cyan');
    log('█'.repeat(70), 'cyan');
    
    const db = await initFirebase();
    
    // Small delay to ensure Firebase is ready
    await sleep(1000);
    
    const success = await deleteAllData(db);
    
    const exitCode = success ? 0 : 1;
    
    log('\n👋 Cleanup process finished', success ? 'green' : 'yellow');
    log(`Exit code: ${exitCode}`, success ? 'green' : 'yellow');
    
    // Give time for logs to flush
    await sleep(2000);
    
    process.exit(exitCode);
    
  } catch (error) {
    log(`\n❌ Fatal error in main: ${error.message}`, 'red');
    log(error.stack, 'red');
    
    await sleep(2000);
    process.exit(1);
  }
}

// Handle process signals
process.on('SIGTERM', async () => {
  log('\n⚠️  SIGTERM received - attempting graceful shutdown...', 'yellow');
  log(`📊 Progress before shutdown: ${totalDeleted} deleted, ${totalFailed} failed`, 'blue');
  await sleep(1000);
  process.exit(0);
});

process.on('SIGINT', async () => {
  log('\n⚠️  SIGINT received - attempting graceful shutdown...', 'yellow');
  log(`📊 Progress before shutdown: ${totalDeleted} deleted, ${totalFailed} failed`, 'blue');
  await sleep(1000);
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log(`\n❌ Uncaught exception: ${error.message}`, 'red');
  log(error.stack, 'red');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log(`\n❌ Unhandled rejection at ${promise}`, 'red');
  log(`Reason: ${reason}`, 'red');
  process.exit(1);
});

// Start the cleanup
main();