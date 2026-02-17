const express = require('express');
const cors = require('cors');
const { processMessage } = require('./services/geminiService');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors({
  origin: true, // Allow all origins in development
  credentials: true
}));

app.use(express.json());

app.post('/api/chat', async (req, res) => {
  try {
    const { message, conversationHistory, pageContent } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const response = await processMessage(message, conversationHistory || [], pageContent);
    
    res.json(response);
  } catch (error) {
    console.error('Backend error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to process message'
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
