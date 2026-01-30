#!/usr/bin/env node

/**
 * =======================================================
 * REALTIME DATABASE CLEANUP - DELETE ALL ASSETS
 * SIMPLIFIED: No classification, delete everything
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
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${colors[color]}${message}${colors.reset}`);
}

// LIST ASET YANG AKAN DIHAPUS
const ASSETS = [
  'acnsj', 'bbbbbb', 'bbh', 'cccc', 'cvcv', 
  'dbl', 'djf', 'edr', 'eeee', 'ffffff', 
  'gwe', 'ioio', 'kbac', 'kkkkk', 'lkas'
];

let totalDeleted = 0;
let totalFailed = 0;
let startTime = Date.now();

async function initFirebase() {
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

  return admin.database();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fungsi recursive delete - sederhana, tidak ada klasifikasi
async function deleteRecursive(db, path, depth = 0) {
  const indent = '  '.repeat(depth);
  
  try {
    // Coba hapus langsung dulu
    await db.ref(path).remove();
    totalDeleted++;
    return { success: true, count: 1 };
  } catch (error) {
    // Kalau terlalu besar, hapus children dulu
    if (!error.message.includes('TOO_BIG') && !error.message.includes('large')) {
      totalFailed++;
      return { success: false, error: error.message };
    }
  }

  try {
    // Ambil keys saja (tidak load values)
    const snapshot = await db.ref(path).once('value');
    if (!snapshot.exists()) return { success: true, count: 0 };
    
    const keys = [];
    snapshot.forEach(child => {
      keys.push(child.key);
    });

    if (keys.length === 0) {
      await db.ref(path).remove();
      return { success: true, count: 1 };
    }

    // Log untuk level 0 dan 1 saja
    if (depth <= 1) {
      log(`${indent}📁 ${path}: ${keys.length} items`, 'cyan');
    }

    let count = 0;
    const batchSize = 20; // Consistent batch size untuk semua
    
    // Hapus dalam batch
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      
      await Promise.all(batch.map(key => 
        deleteRecursive(db, `${path}/${key}`, depth + 1)
          .then(r => { if (r.success) count += r.count; })
          .catch(() => totalFailed++)
      ));
      
      // Progress report untuk level 1
      if (depth === 1 && keys.length > 100) {
        const progress = Math.min(i + batchSize, keys.length);
        if (i % (batchSize * 5) === 0 || progress === keys.length) {
          const percent = Math.round((progress / keys.length) * 100);
          log(`${indent}   ${percent}% (${progress}/${keys.length})`, 'blue');
        }
      }
      
      await sleep(100); // Consistent delay
    }
    
    // Hapus parent setelah children habis
    try {
      await db.ref(path).remove();
      count++;
      totalDeleted++;
    } catch (e) {
      // Sudah terhapus atau tidak bisa dihapus
    }
    
    return { success: true, count };
  } catch (error) {
    totalFailed++;
    return { success: false, error: error.message };
  }
}

async function deleteAllData(db) {
  log('\n========================================', 'cyan');
  log('🚀 STARTING DATABASE CLEANUP', 'bold');
  log(`📊 Total assets: ${ASSETS.length}`, 'blue');
  log('========================================\n', 'cyan');
  
  for (let i = 0; i < ASSETS.length; i++) {
    const asset = ASSETS[i];
    log(`[${i + 1}/${ASSETS.length}] 🗑️  Deleting /${asset}...`, 'cyan');
    
    const result = await deleteRecursive(db, `/${asset}`);
    
    if (result.success) {
      log(`   ✅ /${asset} deleted (${result.count} nodes)`, 'green');
    } else {
      log(`   ❌ /${asset} failed: ${result.error}`, 'red');
    }
    
    totalDeleted += result.count || 0;
    
    // Progress overall
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    log(`   📊 Total: ${totalDeleted} deleted | ${elapsed}s elapsed\n`, 'blue');
    
    // Jeda antar asset
    if (i < ASSETS.length - 1) await sleep(1000);
  }
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  log('========================================', 'cyan');
  log('🎉 CLEANUP COMPLETED', 'green');
  log(`✅ Total deleted: ${totalDeleted} nodes`, 'green');
  log(`⏱️  Time: ${totalTime}s`, 'blue');
  if (totalFailed > 0) log(`⚠️  Failed: ${totalFailed}`, 'red');
  log('========================================', 'cyan');
}

async function main() {
  try {
    log('\n🗑️  FIREBASE DATABASE CLEANUP\n', 'cyan');
    
    const db = await initFirebase();
    log('✅ Firebase connected\n', 'green');
    
    await deleteAllData(db);
    
    process.exit(0);
  } catch (error) {
    log(`\n❌ Error: ${error.message}`, 'red');
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  log('\n⚠️  Stopped by user', 'yellow');
  process.exit(0);
});

main();