const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/AnalyticsEvent');

// In-memory buffer for high-availability / offline fallback
const memoryEvents = [];
const MAX_MEMORY_EVENTS = 5000;

// Listen for MongoDB reconnect to sync buffered events
if (mongoose.connection) {
  mongoose.connection.on('connected', async () => {
    if (memoryEvents.length > 0) {
      try {
        console.log(`Flushing ${memoryEvents.length} in-memory analytics events to MongoDB...`);
        const toFlush = memoryEvents.splice(0, memoryEvents.length);
        await AnalyticsEvent.insertMany(toFlush, { ordered: false });
        console.log('✓ Successfully flushed buffered events to MongoDB.');
      } catch (err) {
        console.error('Error syncing in-memory events to MongoDB:', err.message);
      }
    }
  });
}

// Helper to check if MongoDB is connected and ready
const isDbConnected = () => mongoose.connection.readyState === 1;

// Middleware to parse text/plain bodies that contain JSON (common with navigator.sendBeacon)
const parseBeaconBody = (req, res, next) => {
  if (req.body && typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch (e) {
      // Keep as string if not valid JSON
    }
  }
  next();
};

/**
 * POST /api/analytics/event
 * Ingests single tracking event (PAGE_VIEW, ADD_TO_CART, PURCHASE_SUCCESS, DWELL_TIME)
 */
router.post('/event', parseBeaconBody, async (req, res) => {
  try {
    const {
      eventType,
      sessionId,
      page,
      referrer,
      dwellTime,
      metadata
    } = req.body || {};

    if (!eventType || !sessionId || !page) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: eventType, sessionId, and page are required.'
      });
    }

    const validEvents = ['PAGE_VIEW', 'ADD_TO_CART', 'PURCHASE_SUCCESS', 'DWELL_TIME'];
    if (!validEvents.includes(eventType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid eventType. Allowed: ${validEvents.join(', ')}`
      });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    const eventDoc = {
      eventType,
      sessionId: String(sessionId),
      page: String(page),
      referrer: referrer ? String(referrer) : '',
      dwellTime: typeof dwellTime === 'number' ? Math.max(0, Math.round(dwellTime)) : 0,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      ip: clientIp,
      userAgent,
      timestamp: new Date()
    };

    if (isDbConnected()) {
      const saved = await AnalyticsEvent.create(eventDoc);
      return res.status(201).json({
        success: true,
        eventId: saved._id,
        storage: 'mongodb',
        timestamp: saved.timestamp
      });
    } else {
      // Record in memory store when MongoDB is disconnected
      if (memoryEvents.length >= MAX_MEMORY_EVENTS) {
        memoryEvents.shift(); // Remove oldest to prevent memory overflow
      }
      const memId = 'mem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      eventDoc._id = memId;
      memoryEvents.push(eventDoc);

      return res.status(201).json({
        success: true,
        eventId: memId,
        storage: 'memory_buffer',
        timestamp: eventDoc.timestamp
      });
    }
  } catch (error) {
    console.error('Error logging analytics event:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to record analytics event',
      details: error.message
    });
  }
});

/**
 * POST /api/analytics/events/batch
 * Ingests batch of events
 */
router.post('/events/batch', parseBeaconBody, async (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : req.body.events;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ success: false, error: 'Expected an array of events.' });
    }

    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    const prepared = events
      .filter(e => e && e.eventType && e.sessionId && e.page)
      .map(e => ({
        eventType: e.eventType,
        sessionId: String(e.sessionId),
        page: String(e.page),
        referrer: e.referrer ? String(e.referrer) : '',
        dwellTime: typeof e.dwellTime === 'number' ? Math.max(0, Math.round(e.dwellTime)) : 0,
        metadata: e.metadata && typeof e.metadata === 'object' ? e.metadata : {},
        ip: clientIp,
        userAgent,
        timestamp: new Date()
      }));

    if (prepared.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid events found in batch.' });
    }

    if (isDbConnected()) {
      const inserted = await AnalyticsEvent.insertMany(prepared);
      return res.status(201).json({
        success: true,
        count: inserted.length,
        storage: 'mongodb'
      });
    } else {
      prepared.forEach(item => {
        item._id = 'mem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        memoryEvents.push(item);
      });
      return res.status(201).json({
        success: true,
        count: prepared.length,
        storage: 'memory_buffer'
      });
    }
  } catch (error) {
    console.error('Error logging batch analytics events:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to record batch events',
      details: error.message
    });
  }
});

/**
 * Helper to compute dashboard aggregations in-memory when MongoDB is offline
 */
function computeMemoryStats(events) {
  const counts = { PAGE_VIEW: 0, ADD_TO_CART: 0, PURCHASE_SUCCESS: 0, DWELL_TIME: 0 };
  const pagesMap = {};
  const productsMap = {};
  const dwellMap = {};
  const sessionsMap = {};
  let totalRevenue = 0;
  let totalDwellSeconds = 0;
  let maxDwellSeconds = 0;
  let dwellCount = 0;

  events.forEach(e => {
    if (counts.hasOwnProperty(e.eventType)) counts[e.eventType]++;

    // Sessions map
    if (!sessionsMap[e.sessionId]) {
      sessionsMap[e.sessionId] = {
        pageViews: 0,
        addToCarts: 0,
        purchases: 0,
        dwellSeconds: 0
      };
    }
    const sess = sessionsMap[e.sessionId];

    if (e.eventType === 'PAGE_VIEW') {
      sess.pageViews++;
      if (!pagesMap[e.page]) pagesMap[e.page] = { views: 0, uniqueSessions: new Set() };
      pagesMap[e.page].views++;
      pagesMap[e.page].uniqueSessions.add(e.sessionId);
    }

    if (e.eventType === 'ADD_TO_CART') {
      sess.addToCarts++;
      const pId = e.metadata?.id || 'unknown';
      const pName = e.metadata?.name || 'Unnamed Item';
      if (!productsMap[pId]) productsMap[pId] = { productId: pId, productName: pName, addToCartCount: 0, totalQuantity: 0 };
      productsMap[pId].addToCartCount++;
      productsMap[pId].totalQuantity += (Number(e.metadata?.qty) || 1);
    }

    if (e.eventType === 'PURCHASE_SUCCESS') {
      sess.purchases++;
      const rev = Number(e.metadata?.total) || Number(e.metadata?.subtotal) || 0;
      totalRevenue += rev;
    }

    if (e.eventType === 'DWELL_TIME' && e.dwellTime > 0) {
      sess.dwellSeconds += e.dwellTime;
      totalDwellSeconds += e.dwellTime;
      dwellCount++;
      if (e.dwellTime > maxDwellSeconds) maxDwellSeconds = e.dwellTime;

      if (!dwellMap[e.page]) dwellMap[e.page] = { totalDwell: 0, exits: 0 };
      dwellMap[e.page].totalDwell += e.dwellTime;
      dwellMap[e.page].exits++;
    }
  });

  const totalSessions = Object.keys(sessionsMap).length;
  let bouncedSessions = 0;
  let sessionsWithCart = 0;
  let sessionsWithPurchase = 0;

  Object.values(sessionsMap).forEach(s => {
    if (s.pageViews <= 1 && s.addToCarts === 0 && s.purchases === 0) {
      bouncedSessions++;
    }
    if (s.addToCarts > 0) sessionsWithCart++;
    if (s.purchases > 0) sessionsWithPurchase++;
  });

  const bounceRate = totalSessions > 0 ? Number(((bouncedSessions / totalSessions) * 100).toFixed(2)) : 0;
  const cartRate = totalSessions > 0 ? Number(((sessionsWithCart / totalSessions) * 100).toFixed(2)) : 0;
  const purchaseRate = totalSessions > 0 ? Number(((sessionsWithPurchase / totalSessions) * 100).toFixed(2)) : 0;
  const cartToOrderRate = sessionsWithCart > 0 ? Number(((sessionsWithPurchase / sessionsWithCart) * 100).toFixed(2)) : 0;

  const pageBreakdown = Object.entries(pagesMap).map(([page, data]) => ({
    page,
    views: data.views,
    uniqueVisitors: data.uniqueSessions.size
  })).sort((a, b) => b.views - a.views);

  const dwellPageBreakdown = Object.entries(dwellMap).map(([page, data]) => ({
    page,
    avgDwellSeconds: data.exits > 0 ? Math.round((data.totalDwell / data.exits) * 10) / 10 : 0,
    totalDwellSeconds: data.totalDwell,
    exits: data.exits
  })).sort((a, b) => b.avgDwellSeconds - a.avgDwellSeconds);

  return {
    source: 'memory_buffer (MongoDB offline)',
    summary: {
      totalPageViews: counts.PAGE_VIEW,
      totalAddToCarts: counts.ADD_TO_CART,
      totalPurchases: counts.PURCHASE_SUCCESS,
      totalDwellEvents: counts.DWELL_TIME,
      totalRevenue: Math.round(totalRevenue),
      avgOrderValue: counts.PURCHASE_SUCCESS > 0 ? Math.round(totalRevenue / counts.PURCHASE_SUCCESS) : 0,
      currency: 'EGP'
    },
    bounceMetrics: {
      totalSessions,
      bouncedSessions,
      nonBouncedSessions: totalSessions - bouncedSessions,
      bounceRate: `${bounceRate}%`,
      bounceRatePercentage: bounceRate
    },
    dwellTimeMetrics: {
      avgDwellSeconds: dwellCount > 0 ? Math.round((totalDwellSeconds / dwellCount) * 10) / 10 : 0,
      maxDwellSeconds,
      totalTrackedMinutes: Math.round(totalDwellSeconds / 60),
      pageBreakdown: dwellPageBreakdown
    },
    funnel: {
      sessions: totalSessions,
      sessionsWithCart,
      sessionsWithPurchase,
      cartConversionRate: `${cartRate}%`,
      purchaseConversionRate: `${purchaseRate}%`,
      cartToPurchaseRate: `${cartToOrderRate}%`
    },
    breakdowns: {
      pages: pageBreakdown,
      productsAddedToCart: Object.values(productsMap).sort((a, b) => b.addToCartCount - a.addToCartCount)
    },
    recentEvents: events.slice(-15).reverse()
  };
}

/**
 * GET /api/analytics/dashboard-stats
 * Aggregation endpoint tracking page views, add-to-carts, completed purchases, and bounce metrics
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    if (!isDbConnected()) {
      const stats = computeMemoryStats(memoryEvents);
      return res.status(200).json({
        success: true,
        generatedAt: new Date().toISOString(),
        ...stats
      });
    }

    // 1. Total event counts by type
    const eventCounts = await AnalyticsEvent.aggregate([
      {
        $group: {
          _id: '$eventType',
          count: { $sum: 1 }
        }
      }
    ]);

    const countsMap = {
      PAGE_VIEW: 0,
      ADD_TO_CART: 0,
      PURCHASE_SUCCESS: 0,
      DWELL_TIME: 0
    };
    eventCounts.forEach(item => {
      if (countsMap.hasOwnProperty(item._id)) {
        countsMap[item._id] = item.count;
      }
    });

    // 2. Page views breakdown by page
    const pageViewsBreakdown = await AnalyticsEvent.aggregate([
      { $match: { eventType: 'PAGE_VIEW' } },
      {
        $group: {
          _id: '$page',
          views: { $sum: 1 },
          uniqueSessions: { $addToSet: '$sessionId' }
        }
      },
      {
        $project: {
          page: '$_id',
          views: 1,
          uniqueVisitors: { $size: '$uniqueSessions' },
          _id: 0
        }
      },
      { $sort: { views: -1 } }
    ]);

    // 3. Add to cart breakdown by product
    const addToCartBreakdown = await AnalyticsEvent.aggregate([
      { $match: { eventType: 'ADD_TO_CART' } },
      {
        $group: {
          _id: {
            id: { $ifNull: ['$metadata.id', 'unknown'] },
            name: { $ifNull: ['$metadata.name', 'Unnamed Item'] }
          },
          addToCartCount: { $sum: 1 },
          totalQuantity: {
            $sum: {
              $cond: [
                { $gt: ['$metadata.qty', 0] },
                '$metadata.qty',
                1
              ]
            }
          }
        }
      },
      {
        $project: {
          productId: '$_id.id',
          productName: '$_id.name',
          addToCartCount: 1,
          totalQuantity: 1,
          _id: 0
        }
      },
      { $sort: { addToCartCount: -1 } }
    ]);

    // 4. Completed purchases and revenue stats
    const purchaseStats = await AnalyticsEvent.aggregate([
      { $match: { eventType: 'PURCHASE_SUCCESS' } },
      {
        $group: {
          _id: null,
          totalPurchases: { $sum: 1 },
          totalRevenue: {
            $sum: {
              $cond: [
                { $gt: ['$metadata.total', 0] },
                '$metadata.total',
                { $ifNull: ['$metadata.subtotal', 0] }
              ]
            }
          },
          avgOrderValue: {
            $avg: {
              $cond: [
                { $gt: ['$metadata.total', 0] },
                '$metadata.total',
                { $ifNull: ['$metadata.subtotal', 0] }
              ]
            }
          }
        }
      }
    ]);

    const purchaseSummary = purchaseStats[0] || {
      totalPurchases: 0,
      totalRevenue: 0,
      avgOrderValue: 0
    };

    // 5. Dwell time metrics
    const dwellStats = await AnalyticsEvent.aggregate([
      { $match: { eventType: 'DWELL_TIME', dwellTime: { $gt: 0 } } },
      {
        $group: {
          _id: null,
          totalTrackedSeconds: { $sum: '$dwellTime' },
          avgDwellSeconds: { $avg: '$dwellTime' },
          maxDwellSeconds: { $max: '$dwellTime' },
          sampleCount: { $sum: 1 }
        }
      }
    ]);

    const dwellByPage = await AnalyticsEvent.aggregate([
      { $match: { eventType: 'DWELL_TIME', dwellTime: { $gt: 0 } } },
      {
        $group: {
          _id: '$page',
          avgDwellSeconds: { $avg: '$dwellTime' },
          totalDwellSeconds: { $sum: '$dwellTime' },
          exits: { $sum: 1 }
        }
      },
      {
        $project: {
          page: '$_id',
          avgDwellSeconds: { $round: ['$avgDwellSeconds', 1] },
          totalDwellSeconds: 1,
          exits: 1,
          _id: 0
        }
      },
      { $sort: { avgDwellSeconds: -1 } }
    ]);

    const dwellSummary = dwellStats[0] || {
      totalTrackedSeconds: 0,
      avgDwellSeconds: 0,
      maxDwellSeconds: 0,
      sampleCount: 0
    };

    // 6. Session & Bounce Rate Aggregation
    // A bounced session is defined as a session with exactly 1 page view
    // and 0 engagement/conversion actions (0 add_to_cart, 0 purchase_success).
    const sessionAgg = await AnalyticsEvent.aggregate([
      {
        $group: {
          _id: '$sessionId',
          pageViews: {
            $sum: { $cond: [{ $eq: ['$eventType', 'PAGE_VIEW'] }, 1, 0] }
          },
          addToCarts: {
            $sum: { $cond: [{ $eq: ['$eventType', 'ADD_TO_CART'] }, 1, 0] }
          },
          purchases: {
            $sum: { $cond: [{ $eq: ['$eventType', 'PURCHASE_SUCCESS'] }, 1, 0] }
          },
          dwellEvents: {
            $sum: { $cond: [{ $eq: ['$eventType', 'DWELL_TIME'] }, 1, 0] }
          },
          sessionDwellTime: {
            $sum: { $cond: [{ $eq: ['$eventType', 'DWELL_TIME'] }, '$dwellTime', 0] }
          },
          firstSeen: { $min: '$timestamp' },
          lastSeen: { $max: '$timestamp' }
        }
      },
      {
        $project: {
          sessionId: '$_id',
          pageViews: 1,
          addToCarts: 1,
          purchases: 1,
          sessionDwellTime: 1,
          isBounced: {
            $cond: [
              {
                $and: [
                  { $lte: ['$pageViews', 1] },
                  { $eq: ['$addToCarts', 0] },
                  { $eq: ['$purchases', 0] }
                ]
              },
              1,
              0
            ]
          }
        }
      },
      {
        $group: {
          _id: null,
          totalSessions: { $sum: 1 },
          bouncedSessions: { $sum: '$isBounced' },
          sessionsWithCart: {
            $sum: { $cond: [{ $gt: ['$addToCarts', 0] }, 1, 0] }
          },
          sessionsWithPurchase: {
            $sum: { $cond: [{ $gt: ['$purchases', 0] }, 1, 0] }
          },
          avgSessionDwellSeconds: { $avg: '$sessionDwellTime' }
        }
      }
    ]);

    const sessionData = sessionAgg[0] || {
      totalSessions: 0,
      bouncedSessions: 0,
      sessionsWithCart: 0,
      sessionsWithPurchase: 0,
      avgSessionDwellSeconds: 0
    };

    const totalSessions = sessionData.totalSessions;
    const bouncedSessions = sessionData.bouncedSessions;
    const bounceRate = totalSessions > 0
      ? Number(((bouncedSessions / totalSessions) * 100).toFixed(2))
      : 0;

    // Funnel conversion percentages
    const cartConversionRate = totalSessions > 0
      ? Number(((sessionData.sessionsWithCart / totalSessions) * 100).toFixed(2))
      : 0;

    const purchaseConversionRate = totalSessions > 0
      ? Number(((sessionData.sessionsWithPurchase / totalSessions) * 100).toFixed(2))
      : 0;

    const cartToPurchaseRate = sessionData.sessionsWithCart > 0
      ? Number(((sessionData.sessionsWithPurchase / sessionData.sessionsWithCart) * 100).toFixed(2))
      : 0;

    // 7. Recent 15 events for live inspection
    const recentEvents = await AnalyticsEvent.find({})
      .sort({ timestamp: -1 })
      .limit(15)
      .select('eventType sessionId page dwellTime metadata timestamp');

    return res.status(200).json({
      success: true,
      source: 'mongodb',
      generatedAt: new Date().toISOString(),
      summary: {
        totalPageViews: countsMap.PAGE_VIEW,
        totalAddToCarts: countsMap.ADD_TO_CART,
        totalPurchases: countsMap.PURCHASE_SUCCESS,
        totalDwellEvents: countsMap.DWELL_TIME,
        totalRevenue: Math.round(purchaseSummary.totalRevenue),
        avgOrderValue: Math.round(purchaseSummary.avgOrderValue),
        currency: 'EGP'
      },
      bounceMetrics: {
        totalSessions,
        bouncedSessions,
        nonBouncedSessions: totalSessions - bouncedSessions,
        bounceRate: `${bounceRate}%`,
        bounceRatePercentage: bounceRate
      },
      dwellTimeMetrics: {
        avgDwellSeconds: Math.round((dwellSummary.avgDwellSeconds || 0) * 10) / 10,
        maxDwellSeconds: dwellSummary.maxDwellSeconds || 0,
        totalTrackedMinutes: Math.round((dwellSummary.totalTrackedSeconds || 0) / 60),
        pageBreakdown: dwellByPage
      },
      funnel: {
        sessions: totalSessions,
        sessionsWithCart: sessionData.sessionsWithCart,
        sessionsWithPurchase: sessionData.sessionsWithPurchase,
        cartConversionRate: `${cartConversionRate}%`,
        purchaseConversionRate: `${purchaseConversionRate}%`,
        cartToPurchaseRate: `${cartToPurchaseRate}%`
      },
      breakdowns: {
        pages: pageViewsBreakdown,
        productsAddedToCart: addToCartBreakdown
      },
      recentEvents
    });
  } catch (error) {
    console.error('Error computing dashboard analytics:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to compute dashboard analytics',
      details: error.message
    });
  }
});

module.exports = router;
