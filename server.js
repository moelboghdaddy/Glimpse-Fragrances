require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://mohamedelb...';

// Core Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));
// Add this right next to your other API endpoints in server.js
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, items, totalAmount, paymentMethod, payment_method } = req.body;

    const newOrder = new Order({
      customer,
      items,
      totalAmount,
      // Map whichever field key was sent from the frontend form
      paymentMethod: paymentMethod || payment_method || 'COD'
    });

    await newOrder.save();
    res.status(201).json(newOrder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.use(express.text({ type: ['text/plain', 'application/json'], limit: '2mb' }));

// Gracefully handle malformed JSON bodies
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'Invalid JSON payload format'
    });
  }
  next(err);
});

// Serve static files from public & root
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Analytics Router
const analyticsRouter = require('./routes/analytics');
app.use('/api/analytics', analyticsRouter);

// 1. Order Model Definition
const Order = mongoose.models.Order || mongoose.model('Order', new mongoose.Schema({
  orderNumber: { type: String },
  customer: {
    name: String,
    email: String,
    phone: String,
    altPhone: String,
    address: String
  },
  items: Array,
  paymentMethod: String,
  totalAmount: Number,
  createdAt: { type: Date, default: Date.now }
}));
// 2. Order Submission Endpoints (Supports both /api/orders and /api/orders/checkout)
const handleNewOrder = async (req, res) => {
  try {
    const payload = req.body;

    // Format incoming payload standard across forms
    const orderData = {
      orderNumber: payload.orderId || payload.orderNumber || ('GLM-' + Math.floor(1000 + Math.random() * 9000)),
      customer: {
        name: payload.customerName || payload.customer?.name || '',
        phone: payload.phone || payload.customer?.phone || '',
        altPhone: payload.altPhone || payload.phone2 || payload.customer?.altPhone || '', // Captures secondary phone
        email: payload.email || payload.customer?.email || 'N/A',
        address: payload.address || payload.customer?.address || ''
      },
      paymentMethod: payload.paymentMethod || 'cod',
      totalAmount: Number(payload.totalAmount) || 849,
      items: payload.items || []
    };

    const newOrder = new Order(orderData);
    await newOrder.save();

    console.log(`[Order Saved] Order #${newOrder.orderNumber} placed successfully.`);
    res.status(201).json({ success: true, orderId: newOrder._id, orderNumber: newOrder.orderNumber });
  } catch (err) {
    console.error('[Order Save Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/orders', handleNewOrder);
app.post('/api/orders/checkout', handleNewOrder);

// 3. Analytics Dashboard Stats API
app.get('/api/analytics/dashboard-stats', async (req, res) => {
  try {
    const totalPurchases = await Order.countDocuments();
    const revenueAgg = await Order.aggregate([
      { $group: { _id: null, total: { $sum: '$totalAmount' } } }
    ]);
    const totalRevenue = revenueAgg[0]?.total || 0;
    const avgOrderValue = totalPurchases > 0 ? Math.round(totalRevenue / totalPurchases) : 0;

    let formattedPageViews = [];
    let totalSessions = 0;
    let bouncedSessions = 0;
    let bounceRate = 0;

    // Check if Analytics model is registered
    if (mongoose.models.Analytics) {
      const Analytics = mongoose.model('Analytics');

      const pageViewsRaw = await Analytics.aggregate([
        { $group: { _id: "$path", views: { $sum: 1 }, visitors: { $addToSet: "$sessionId" } } }
      ]);

      formattedPageViews = pageViewsRaw.map(pv => {
        let cleanName = pv._id || 'Home';
        if (cleanName.includes('portofino')) cleanName = 'Portofino';
        else if (cleanName.includes('tropical-chill')) cleanName = 'Tropical Chill';
        else if (cleanName.includes('cold-fire')) cleanName = 'Cold Fire';
        else if (cleanName.includes('effective')) cleanName = 'Effective';
        else if (cleanName.includes('checkout')) cleanName = 'Checkout';
        else if (cleanName.includes('index') || cleanName === '/') cleanName = 'Home Page';

        return {
          path: cleanName,
          views: pv.views,
          uniqueVisitors: pv.visitors.length
        };
      });

      const sessionCounts = await Analytics.aggregate([
        { $group: { _id: "$sessionId", count: { $sum: 1 } } }
      ]);
      totalSessions = sessionCounts.length;
      bouncedSessions = sessionCounts.filter(s => s.count === 1).length;
      bounceRate = totalSessions > 0 ? Math.round((bouncedSessions / totalSessions) * 100) : 0;
    }

    res.json({
      totalOrders: totalPurchases,
      totalPurchases: totalPurchases,
      totalRevenue: totalRevenue,
      avgOrderValue: avgOrderValue,
      totalSessions: totalSessions,
      bouncedSessions: bouncedSessions,
      bounceRate: bounceRate,
      summary: {
        totalPurchases,
        totalRevenue,
        avgOrderValue,
        totalSessions,
        singlePageBounces: bouncedSessions,
        bounceRate: `${bounceRate}%`
      },
      pageViews: formattedPageViews
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Health check endpoint
app.get('/api/health', (req, res) => {
  const dbState = mongoose.connection.readyState;
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    database: states[dbState] || 'unknown',
    timestamp: new Date().toISOString()
  });
});

// Serve dashboard.html directly
app.get('/dashboard.html', (req, res) => {
  const publicPath = path.join(__dirname, 'public', 'dashboard.html');
  const rootPath = path.join(__dirname, 'dashboard.html');

  res.sendFile(publicPath, (err) => {
    if (err) res.sendFile(rootPath);
  });
});
// GET Route to fetch all orders for dashboard table
app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Fallback to index.html for root navigation
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) res.sendFile(path.join(__dirname, 'index.html'));
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled application error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

// MongoDB Connection Manager
let isConnecting = false;
let hasLoggedDisconnect = false;
async function connectToMongo() {
  if (isConnecting || mongoose.connection.readyState === 1) return;
  isConnecting = true;
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 3000
    });
    console.log(`✓ Connected to MongoDB`);
    hasLoggedDisconnect = false;
  } catch (err) {
    if (!hasLoggedDisconnect) {
      console.warn(`[MongoDB] Connection attempt failed (${err.message}). Retrying in background...`);
      hasLoggedDisconnect = true;
    }
  } finally {
    isConnecting = false;
  }
}

connectToMongo();

const reconnectTimer = setInterval(() => {
  if (mongoose.connection.readyState !== 1) {
    connectToMongo();
  }
}, 15000);

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`🚀 Glimpse Server running on port ${PORT}`);
  console.log(`🔗 Store Front:    http://localhost:${PORT}`);
  console.log(`📊 Dashboard:      http://localhost:${PORT}/dashboard.html`);
  console.log(`📈 Analytics API:  http://localhost:${PORT}/api/analytics/dashboard-stats`);
  console.log(`=========================================`);
});

// Graceful shutdown
const shutdown = async () => {
  console.log('\nShutting down server...');
  clearInterval(reconnectTimer);
  server.close(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
    }
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app;