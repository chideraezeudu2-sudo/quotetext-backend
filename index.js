require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const smsRoutes = require('./routes/sms');
const voiceRoutes = require('./routes/voice');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Routes
app.post('/sms', smsRoutes);
app.post('/voice', voiceRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.send('QuoteText Backend is running');
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`QuoteText backend running on port ${PORT}`);
});

module.exports = app;