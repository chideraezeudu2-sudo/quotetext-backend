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

// Debug: log all requests
app.use((req, res, next) => {
  console.log('Request:', req.method, req.path, 'Content-Type:', req.get('Content-Type'));
  next();
});

// Routes
app.post('/sms', smsRoutes);
app.post('/voice', voiceRoutes);

// Health check endpoint
app.get('/', (req, res) => {
  res.send('QuoteText Backend is running v' + Date.now());
});

// Debug test endpoint
app.post('/test', (req, res) => {
  res.send('Test route works v' + Date.now() + ': ' + JSON.stringify(req.body));
});

// Debug: log all requests
app.use((req, res, next) => {
  console.log('Request:', req.method, req.path, 'Content-Type:', req.get('Content-Type'));
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Catch-all for debugging
app.use((req, res) => {
  console.log('CATCH-ALL:', req.method, req.path);
  res.status(404).send('No route: ' + req.method + ' ' + req.path);
});

// Start server
app.listen(PORT, () => {
  console.log(`QuoteText backend running on port ${PORT}`);
});

module.exports = app;