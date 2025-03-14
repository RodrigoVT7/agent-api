require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');

const app = express();
const PORT = 3000;

// Create OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `http://localhost:${PORT}/auth/google/callback`
);

// Define scopes
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events'
];

// Auth route
app.get('/auth', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent' // Important! Forces refresh token to be returned
  });
  
  console.log('Visit this URL to authorize the application:');
  console.log(authUrl);
  
  res.send(`Click <a href="${authUrl}">here</a> to authorize the application.`);
});

// Callback route
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    
    console.log('\n=== Authentication successful! ===\n');
    console.log('Access Token:', tokens.access_token);
    console.log('\nRefresh Token:', tokens.refresh_token);
    console.log('\nAdd this refresh token to your .env file as GOOGLE_REFRESH_TOKEN');
    
    res.send('Authentication successful! Check your console for the refresh token.');
  } catch (error) {
    console.error('Error retrieving tokens:', error);
    res.status(500).send('Error retrieving tokens');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Auth server running at http://localhost:${PORT}`);
  console.log(`Visit http://localhost:${PORT}/auth to start the authentication process`);
});