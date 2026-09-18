const mongoose = require('mongoose');

const AnalyticsEventSchema = new mongoose.Schema({
  eventType: {
    type: String,
    required: true,
    enum: ['PAGE_VIEW', 'ADD_TO_CART', 'PURCHASE_SUCCESS', 'DWELL_TIME'],
    index: true
  },
  sessionId: {
    type: String,
    required: true,
    index: true
  },
  page: {
    type: String,
    required: true,
    index: true
  },
  referrer: {
    type: String,
    default: ''
  },
  dwellTime: {
    type: Number,
    default: 0 // Recorded in seconds
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  userAgent: {
    type: String,
    default: ''
  },
  ip: {
    type: String,
    default: ''
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true,
  bufferCommands: false // Fail fast if MongoDB is disconnected so fallback can handle it
});

// Compound indexes for high-performance aggregations
AnalyticsEventSchema.index({ eventType: 1, timestamp: -1 });
AnalyticsEventSchema.index({ sessionId: 1, eventType: 1 });
AnalyticsEventSchema.index({ page: 1, eventType: 1 });

module.exports = mongoose.model('AnalyticsEvent', AnalyticsEventSchema);
