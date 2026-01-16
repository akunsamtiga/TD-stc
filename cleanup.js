#!/usr/bin/env node

import admin from 'firebase-admin';
import readline from 'readline';
import dotenv from 'dotenv';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

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
  console.log(`${colors[color]}${message}${colors.reset}`);
}

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

async function listAllPaths(db) {
  try {
    const snapshot = await db.ref('/').once('value');
    const data = snapshot.val();
    
    if (!data) {
      log('📭 No data found in Realtime Database', 'yellow');
      return [];
    }

    const paths = Object.keys(data);
    log('\n📂 Current paths in Realtime Database:', 'cyan');
    paths.forEach((path, index) => {
      log(`   ${index + 1}. /${path}`, 'blue');
    });
    
    return paths;
  } catch (error) {
    log(`❌ Error listing paths: ${error.message}`, 'red');
    return [];
  }
}

async function getPathSize(db, path) {
  try {
    const snapshot = await db.ref(path).once('value');
    const data = snapshot.val();
    
    if (!data) return { count: 0, size: 0 };
    
    const jsonString = JSON.stringify(data);
    const sizeInBytes = Buffer.byteLength(jsonString, 'utf8');
    const sizeInMB = (sizeInBytes / (1024 * 1024)).toFixed(2);
    
    const countNodes = (obj) => {
      if (typeof obj !== 'object' || obj === null) return 1;
      return Object.keys(obj).reduce((sum, key) => sum + countNodes(obj[key]), 1);
    };
    
    const count = countNodes(data);
    
    return { count, size: sizeInMB };
  } catch (error) {
    return { count: 0, size: 0 };
  }
}

async function deletePathRecursive(db, path, maxDepth = 5) {
  try {
    // Try direct delete first
    try {
      await db.ref(path).remove();
      return { success: true, method: 'direct' };
    } catch (error) {
      if (!error.message.includes('WRITE_TOO_BIG')) {
        throw error;
      }
    }

    // If too big, delete children recursively
    log(`   ⚠️  ${path} too large, deleting children...`, 'yellow');
    
    const snapshot = await db.ref(path).once('value');
    const data = snapshot.val();
    
    if (!data || typeof data !== 'object') {
      return { success: true, method: 'empty' };
    }

    const children = Object.keys(data);
    log(`   📊 Found ${children.length} children in ${path}`, 'blue');
    
    let deletedCount = 0;
    const batchSize = 50;
    
    for (let i = 0; i < children.length; i += batchSize) {
      const batch = children.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(async (childKey) => {
          const childPath = `${path}/${childKey}`;
          
          if (maxDepth > 0) {
            await deletePathRecursive(db, childPath, maxDepth - 1);
          } else {
            await db.ref(childPath).remove();
          }
          
          deletedCount++;
        })
      );
      
      log(`   ⏳ Progress: ${deletedCount}/${children.length} children deleted`, 'cyan');
      
      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    // Delete the parent after all children are gone
    await db.ref(path).remove();
    
    return { success: true, method: 'recursive', deletedCount };
    
  } catch (error) {
    log(`   ❌ Error deleting ${path}: ${error.message}`, 'red');
    return { success: false, error: error.message };
  }
}

async function deleteAll(db) {
  const confirm = await question(
    `${colors.red}${colors.bold}⚠️  DELETE ALL DATA? This cannot be undone! Type 'DELETE ALL' to confirm: ${colors.reset}`
  );
  
  if (confirm.trim() !== 'DELETE ALL') {
    log('❌ Deletion cancelled', 'yellow');
    return false;
  }

  try {
    log('\n📂 Fetching all paths to delete...', 'cyan');
    
    // 1. Get all top-level paths
    const snapshot = await db.ref('/').once('value');
    const data = snapshot.val();
    
    if (!data) {
      log('🔭 Database is already empty', 'yellow');
      return true;
    }

    const paths = Object.keys(data).map(key => `/${key}`);
    
    log(`\n🗑️  Found ${paths.length} paths to delete:`, 'yellow');
    paths.forEach(path => log(`   • ${path}`, 'blue'));
    
    // 2. Delete each path (with recursive support for large paths)
    log('\n⏳ Deleting paths (large paths will be deleted recursively)...', 'yellow');
    let successCount = 0;
    let failCount = 0;
    
    for (const path of paths) {
      try {
        log(`\n🗑️  Deleting ${path}...`, 'cyan');
        
        const result = await deletePathRecursive(db, path);
        
        if (result.success) {
          if (result.method === 'recursive') {
            log(`   ✅ Deleted ${path} recursively (${result.deletedCount} children)`, 'green');
          } else {
            log(`   ✅ Deleted ${path}`, 'green');
          }
          successCount++;
        } else {
          log(`   ❌ Failed to delete ${path}: ${result.error}`, 'red');
          failCount++;
        }
        
        // Small delay between paths
        await new Promise(resolve => setTimeout(resolve, 300));
        
      } catch (error) {
        log(`   ❌ Failed to delete ${path}: ${error.message}`, 'red');
        failCount++;
      }
    }

    // 3. Summary
    log('\n' + '━'.repeat(50), 'cyan');
    log(`✅ Successfully deleted ${successCount} paths`, 'green');
    if (failCount > 0) {
      log(`❌ Failed to delete ${failCount} paths`, 'red');
    }
    log('━'.repeat(50), 'cyan');
    
    return failCount === 0;

  } catch (error) {
    log(`\n❌ Error during deletion: ${error.message}`, 'red');
    return false;
  }
}

async function deleteSpecificPath(db, path) {
  const stats = await getPathSize(db, path);
  
  log(`\n📊 Path: ${path}`, 'cyan');
  log(`   Nodes: ${stats.count.toLocaleString()}`, 'blue');
  log(`   Size: ~${stats.size} MB`, 'blue');
  
  const confirm = await question(
    `${colors.yellow}Delete this path? (yes/no): ${colors.reset}`
  );
  
  if (confirm.toLowerCase() !== 'yes') {
    log('❌ Deletion cancelled', 'yellow');
    return false;
  }

  try {
    log(`\n🗑️  Deleting ${path}...`, 'yellow');
    await db.ref(path).remove();
    log(`✅ ${path} deleted successfully`, 'green');
    return true;
  } catch (error) {
    log(`❌ Error deleting ${path}: ${error.message}`, 'red');
    return false;
  }
}

async function deleteOHLCData(db) {
  try {
    log('\n🔍 Scanning for OHLC data...', 'cyan');
    
    const snapshot = await db.ref('/').once('value');
    const data = snapshot.val();
    
    if (!data) {
      log('📭 No data found', 'yellow');
      return false;
    }

    const ohlcPaths = [];
    
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null) {
        for (const subKey of Object.keys(value)) {
          if (subKey.startsWith('ohlc_')) {
            ohlcPaths.push(`/${key}/${subKey}`);
          }
        }
      }
    }

    if (ohlcPaths.length === 0) {
      log('📭 No OHLC data found', 'yellow');
      return false;
    }

    log(`\n📊 Found ${ohlcPaths.length} OHLC paths:`, 'cyan');
    ohlcPaths.forEach((path, index) => {
      log(`   ${index + 1}. ${path}`, 'blue');
    });

    const confirm = await question(
      `${colors.yellow}\nDelete all OHLC data? (yes/no): ${colors.reset}`
    );
    
    if (confirm.toLowerCase() !== 'yes') {
      log('❌ Deletion cancelled', 'yellow');
      return false;
    }

    log('\n🗑️  Deleting OHLC data...', 'yellow');
    
    for (const path of ohlcPaths) {
      try {
        await db.ref(path).remove();
        log(`   ✅ Deleted ${path}`, 'green');
      } catch (error) {
        log(`   ❌ Failed to delete ${path}: ${error.message}`, 'red');
      }
    }

    log(`\n✅ OHLC cleanup completed`, 'green');
    return true;

  } catch (error) {
    log(`❌ Error deleting OHLC data: ${error.message}`, 'red');
    return false;
  }
}

async function deleteOldData(db, daysOld) {
  try {
    log(`\n🔍 Scanning for data older than ${daysOld} days...`, 'cyan');
    
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - (daysOld * 86400);
    const snapshot = await db.ref('/').once('value');
    const data = snapshot.val();
    
    if (!data) {
      log('📭 No data found', 'yellow');
      return false;
    }

    const pathsToDelete = [];
    
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null) {
        for (const [subKey, subValue] of Object.entries(value)) {
          if (subKey.startsWith('ohlc_')) {
            if (typeof subValue === 'object' && subValue !== null) {
              const oldTimestamps = Object.keys(subValue).filter(ts => {
                const timestamp = parseInt(ts);
                return !isNaN(timestamp) && timestamp < cutoffTimestamp;
              });

              if (oldTimestamps.length > 0) {
                oldTimestamps.forEach(ts => {
                  pathsToDelete.push(`/${key}/${subKey}/${ts}`);
                });
              }
            }
          }
        }
      }
    }

    if (pathsToDelete.length === 0) {
      log(`📭 No data older than ${daysOld} days found`, 'yellow');
      return false;
    }

    log(`\n📊 Found ${pathsToDelete.length} old data nodes`, 'cyan');
    log(`   Sample paths:`, 'blue');
    pathsToDelete.slice(0, 5).forEach(path => {
      log(`   - ${path}`, 'blue');
    });
    if (pathsToDelete.length > 5) {
      log(`   ... and ${pathsToDelete.length - 5} more`, 'blue');
    }

    const confirm = await question(
      `${colors.yellow}\nDelete all old data? (yes/no): ${colors.reset}`
    );
    
    if (confirm.toLowerCase() !== 'yes') {
      log('❌ Deletion cancelled', 'yellow');
      return false;
    }

    log('\n🗑️  Deleting old data...', 'yellow');
    
    const batchSize = 50;
    for (let i = 0; i < pathsToDelete.length; i += batchSize) {
      const batch = pathsToDelete.slice(i, i + batchSize);
      
      const updates = {};
      batch.forEach(path => {
        updates[path] = null;
      });
      
      await db.ref('/').update(updates);
      log(`   ✅ Deleted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(pathsToDelete.length / batchSize)}`, 'green');
    }

    log(`\n✅ Deleted ${pathsToDelete.length} old data nodes`, 'green');
    return true;

  } catch (error) {
    log(`❌ Error deleting old data: ${error.message}`, 'red');
    return false;
  }
}

async function showDatabaseStats(db) {
  try {
    log('\n📊 Database Statistics:', 'cyan');
    log('━'.repeat(50), 'cyan');
    
    const snapshot = await db.ref('/').once('value');
    const data = snapshot.val();
    
    if (!data) {
      log('📭 Database is empty', 'yellow');
      return;
    }

    const paths = Object.keys(data);
    
    for (const path of paths) {
      const stats = await getPathSize(db, `/${path}`);
      log(`\n/${path}:`, 'blue');
      log(`   Nodes: ${stats.count.toLocaleString()}`, 'green');
      log(`   Size: ~${stats.size} MB`, 'green');
      
      const pathData = data[path];
      if (typeof pathData === 'object' && pathData !== null) {
        const ohlcKeys = Object.keys(pathData).filter(k => k.startsWith('ohlc_'));
        if (ohlcKeys.length > 0) {
          log(`   OHLC timeframes: ${ohlcKeys.join(', ')}`, 'magenta');
        }
        if (pathData.current_price) {
          log(`   Has current_price: ✓`, 'green');
        }
      }
    }
    
    log('\n' + '━'.repeat(50), 'cyan');

  } catch (error) {
    log(`❌ Error getting stats: ${error.message}`, 'red');
  }
}

async function mainMenu() {
  const db = await initFirebase();

  log('\n' + '═'.repeat(60), 'cyan');
  log('🗑️  REALTIME DATABASE CLEANUP TOOL', 'bold');
  log('═'.repeat(60), 'cyan');

  while (true) {
    log('\n📋 Main Menu:', 'cyan');
    log('━'.repeat(60), 'cyan');
    log('1. 📊 Show database statistics', 'blue');
    log('2. 📂 List all paths', 'blue');
    log('3. 🗑️  Delete specific path', 'blue');
    log('4. 🗑️  Delete all OHLC data', 'blue');
    log('5. 🗑️  Delete old data (by age)', 'blue');
    log('6. ⚠️  Delete ALL data (DANGEROUS!)', 'red');
    log('0. 🚪 Exit', 'yellow');
    log('━'.repeat(60), 'cyan');

    const choice = await question(`${colors.green}Select option: ${colors.reset}`);

    switch (choice.trim()) {
      case '1':
        await showDatabaseStats(db);
        break;

      case '2':
        await listAllPaths(db);
        break;

      case '3': {
        const paths = await listAllPaths(db);
        if (paths.length === 0) break;
        
        const pathChoice = await question(`${colors.green}Enter path number or full path (e.g., /idx_stc): ${colors.reset}`);
        
        const pathIndex = parseInt(pathChoice) - 1;
        const selectedPath = !isNaN(pathIndex) && pathIndex >= 0 && pathIndex < paths.length
          ? `/${paths[pathIndex]}`
          : pathChoice.startsWith('/') ? pathChoice : `/${pathChoice}`;
        
        await deleteSpecificPath(db, selectedPath);
        break;
      }

      case '4':
        await deleteOHLCData(db);
        break;

      case '5': {
        const days = await question(`${colors.green}Delete data older than how many days? ${colors.reset}`);
        const daysNum = parseInt(days);
        
        if (isNaN(daysNum) || daysNum < 0) {
          log('❌ Invalid number of days', 'red');
          break;
        }
        
        await deleteOldData(db, daysNum);
        break;
      }

      case '6':
        await deleteAll(db);
        break;

      case '0':
        log('\n👋 Goodbye!', 'green');
        rl.close();
        process.exit(0);

      default:
        log('❌ Invalid option', 'red');
    }
  }
}

mainMenu().catch(error => {
  log(`❌ Fatal error: ${error.message}`, 'red');
  process.exit(1);
});