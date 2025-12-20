#!/bin/bash

echo "🚀 Starting IDX_STC Trading Simulator..."
echo ""

# Check if firebase credentials exist
if [ ! -f "firebase_credentials.json" ]; then
    echo "❌ Error: firebase_credentials.json not found!"
    echo ""
    echo "Please follow these steps:"
    echo "1. Go to Firebase Console"
    echo "2. Select your project"
    echo "3. Go to Project Settings > Service Accounts"
    echo "4. Click 'Generate New Private Key'"
    echo "5. Save as 'firebase_credentials.json' in this directory"
    echo ""
    exit 1
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    echo ""
fi

# Start simulator
echo "✅ Starting simulator..."
echo "Press Ctrl+C to stop"
echo ""
npm start
