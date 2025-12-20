# IDX_STC Trading Simulator 🚀

Real-time trading price simulator with Firebase integration for binary options trading platform.

## ✨ Features

### Core Features
- 📊 **Real-time OHLC Generation** - Generates OHLC data every second
- 🔥 **Firebase Integration** - Real-time database sync
- 📈 **Realistic Price Movement** - Random walk with momentum
- 🌍 **Timezone Support** - Accurate time synchronization
- 🗑️ **Auto Cleanup** - Removes old data automatically
- 📝 **Comprehensive Logging** - File and console logging

### Technical Features
- **Node.js** - Fast and efficient
- **Firebase Admin SDK** - Real-time database
- **Winston Logger** - Professional logging
- **Dotenv** - Environment configuration
- **Precise Timing** - Synchronized to exact seconds

## 🚀 Quick Start

### 1. Run Setup Script

```bash
bash setupSimulator.sh
cd trading-simulator
```

### 2. Configure Firebase

Get your Firebase credentials:
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Go to Project Settings > Service Accounts
4. Click "Generate New Private Key"
5. Save as `firebase_credentials.json`

```bash
# Copy your Firebase credentials
cp /path/to/your/credentials.json firebase_credentials.json
```

### 3. Configure Environment

Edit `.env` file:

```bash
# Firebase
FIREBASE_DATABASE_URL=https://your-project.firebaseio.com/

# Simulator Settings
INITIAL_PRICE=40.022
ASSET_NAME=IDX_STC
TIMEZONE=Asia/Jakarta

# Volatility (adjust for price movement)
SECOND_VOLATILITY_MIN=0.00001
SECOND_VOLATILITY_MAX=0.00008
```

### 4. Install Dependencies

```bash
npm install
```

### 5. Test Configuration

```bash
npm test
```

### 6. Start Simulator

```bash
npm start
```

## 📊 How It Works

### Price Generation

1. **Initialize** with starting price (default: 40.022)
2. **Generate** OHLC data every second:
   - Open: Previous close
   - High/Low: From 4 price points
   - Close: Final price
   - Volume: Random (1,000-50,000)
3. **Save** to Firebase in real-time
4. **Update** current price and statistics

### Data Structure

```javascript
Firebase Database Structure:
├── idx_stc/
│   ├── ohlc/
│   │   ├── 1734567890/
│   │   │   ├── timestamp: 1734567890
│   │   │   ├── datetime: "2024-12-19 10:30:15"
│   │   │   ├── open: 40.022
│   │   │   ├── high: 40.025
│   │   │   ├── low: 40.020
│   │   │   ├── close: 40.023
│   │   │   └── volume: 25000
│   ├── current_price/
│   │   ├── price: 40.023
│   │   ├── timestamp: 1734567890
│   │   ├── datetime: "2024-12-19 10:30:15"
│   │   └── change: 0.02
│   └── stats/
│       ├── total_bars: 86400
│       ├── initial_price: 40.022
│       ├── current_price: 40.023
│       ├── highest_price: 40.500
│       └── lowest_price: 39.500
```

## ⚙️ Configuration

### Volatility Settings

Control price movement:

```bash
# Daily volatility (0.1% - 0.5%)
DAILY_VOLATILITY_MIN=0.001
DAILY_VOLATILITY_MAX=0.005

# Per-second volatility (smoother movement)
SECOND_VOLATILITY_MIN=0.00001  # 0.001%
SECOND_VOLATILITY_MAX=0.00008  # 0.008%
```

**Higher values** = More volatile prices  
**Lower values** = Smoother price movement

### Data Retention

```bash
# Keep data for 7 days
DATA_RETENTION_DAYS=7

# Cleanup every 1 hour
CLEANUP_INTERVAL_HOURS=1
```

### Logging

```bash
# Log level: error, warn, info, debug
LOG_LEVEL=info
```

## 📈 Price Movement Algorithm

```javascript
1. Random Walk:
   - Base: Current price
   - Volatility: 0.00001 - 0.00008 (0.001% - 0.008%)
   - Direction: Random with 70% momentum

2. Momentum Effect:
   - 70% chance to continue previous direction
   - Creates realistic trending behavior

3. Price Bounds:
   - Min: 50% of initial price
   - Max: 200% of initial price
   - Prevents extreme movements

4. OHLC Generation:
   - 4 price points per second
   - Realistic high/low calculation
   - Volume: 1,000 - 50,000 units
```

## 🔧 Development

### Project Structure

```
trading-simulator/
├── index.js                    # Main simulator
├── test.js                     # Configuration test
├── package.json               # Dependencies
├── .env                       # Configuration
├── firebase_credentials.json  # Firebase key
├── simulator.log             # Log file
└── README.md                 # Documentation
```

### Scripts

```bash
# Start simulator
npm start

# Start with auto-restart (development)
npm run dev

# Test configuration
npm test
```

### Monitoring

Watch the logs:

```bash
# Real-time log
tail -f simulator.log

# Last 50 lines
tail -n 50 simulator.log
```

## 🎯 Integration with Trading Frontend

### Frontend API Connection

Your trading frontend should connect to:

```javascript
// In frontend tradingService.ts
async getCurrentPrice(assetId: string) {
  // Option 1: Read from Firebase directly
  const snapshot = await firebase.database()
    .ref('/idx_stc/current_price')
    .once('value');
  return snapshot.val();

  // Option 2: Via backend API
  const response = await api.get(`/assets/${assetId}/price`);
  return response.data;
}
```

### Real-time Updates

Subscribe to price changes:

```javascript
// Frontend real-time subscription
const priceRef = firebase.database().ref('/idx_stc/current_price');

priceRef.on('value', (snapshot) => {
  const priceData = snapshot.val();
  setCurrentPrice(priceData.price);
  addPriceToHistory(priceData);
});
```

## 📊 Example Output

```
2024-12-19 10:30:15 - INFO - IDX_STC Simulator initialized
2024-12-19 10:30:15 - INFO - Initial Price: 40.022
2024-12-19 10:30:15 - INFO - Timezone: Asia/Jakarta
2024-12-19 10:30:15 - INFO - ✅ Firebase initialized successfully
2024-12-19 10:30:15 - INFO - 🚀 Starting IDX_STC simulator...
2024-12-19 10:30:15 - INFO - 📍 Timezone: Asia/Jakarta
2024-12-19 10:30:15 - INFO - ⏱️  Synchronizing with system clock...
2024-12-19 10:30:16 - INFO - ✅ Synchronized! Starting at 2024-12-19 10:30:16
2024-12-19 10:30:16 - INFO - Press Ctrl+C to stop

2024-12-19 10:30:16 - INFO - [2024-12-19 10:30:16] OHLC - O:40.022 H:40.025 L:40.020 C:40.023 V:25430
2024-12-19 10:30:17 - INFO - [2024-12-19 10:30:17] OHLC - O:40.023 H:40.026 L:40.022 C:40.024 V:18750
2024-12-19 10:30:18 - INFO - [2024-12-19 10:30:18] OHLC - O:40.024 H:40.027 L:40.023 C:40.025 V:32100
```

## 🐛 Troubleshooting

### Error: Firebase initialization failed

```bash
# Check credentials file exists
ls -la firebase_credentials.json

# Verify JSON format
cat firebase_credentials.json | python -m json.tool
```

### Error: EACCES permission denied

```bash
# Fix permissions
chmod 644 firebase_credentials.json
```

### Prices not updating

```bash
# Check Firebase rules
# Go to Firebase Console > Database > Rules
# Ensure write permissions are enabled for service account
```

### High CPU usage

```bash
# Increase processing interval (less precise)
# Or reduce logging level
LOG_LEVEL=warn
```

## 📝 License

MIT

## 🤝 Support

For issues or questions:
1. Check logs: `tail -f simulator.log`
2. Test config: `npm test`
3. Verify Firebase connection

---

**Trading Simulator v1.0** - Real-time Price Generation 🚀📊
