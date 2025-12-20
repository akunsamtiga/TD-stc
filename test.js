import dotenv from 'dotenv';
dotenv.config();

console.log('🧪 Testing Configuration...\n');

const config = {
  initialPrice: process.env.INITIAL_PRICE || 40.022,
  assetName: process.env.ASSET_NAME || 'IDX_STC',
  timezone: process.env.TIMEZONE || 'Asia/Jakarta',
  firebaseURL: process.env.FIREBASE_DATABASE_URL
};

console.log('📋 Current Configuration:');
console.log('------------------------');
console.log(`Asset Name: ${config.assetName}`);
console.log(`Initial Price: ${config.initialPrice}`);
console.log(`Timezone: ${config.timezone}`);
console.log(`Firebase URL: ${config.firebaseURL}`);
console.log('------------------------\n');

// Test price generation
class PriceGenerator {
  constructor(initialPrice) {
    this.currentPrice = initialPrice;
    this.lastDirection = 1;
  }

  generatePrice() {
    const volatility = 0.00001 + Math.random() * 0.00007;
    let direction = Math.random() < 0.5 ? -1 : 1;
    
    if (Math.random() < 0.7) {
      direction = this.lastDirection;
    }
    
    this.lastDirection = direction;
    const priceChange = this.currentPrice * volatility * direction;
    this.currentPrice += priceChange;
    
    return this.currentPrice;
  }
}

console.log('🎲 Testing Price Generation (10 samples):');
console.log('------------------------');

const generator = new PriceGenerator(parseFloat(config.initialPrice));

for (let i = 0; i < 10; i++) {
  const price = generator.generatePrice();
  const change = ((price - config.initialPrice) / config.initialPrice * 100).toFixed(4);
  console.log(`${i + 1}. Price: ${price.toFixed(3)} (${change > 0 ? '+' : ''}${change}%)`);
}

console.log('------------------------\n');
console.log('✅ Configuration test completed!');
console.log('\n💡 To start the simulator, run: npm start');
