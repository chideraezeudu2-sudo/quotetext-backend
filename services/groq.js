const Groq = require('groq-sdk');
const https = require('https');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || ''
});

async function extractMaterials(text) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: 'You are a materials assistant for trade businesses. When given a job description extract the customer name and generate a structured material list. Return only valid JSON with no markdown in this exact format: { customer_name: string, materials: [ { item_name: string, quantity: number, unit: string, estimated_price: number } ], estimated_total: number }. Use your knowledge of trade materials to fill in realistic quantities and prices. If no customer name is mentioned use Unknown.'
        },
        {
          role: 'user',
          content: text
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.5
    });

    const responseText = completion.choices[0]?.message?.content || '';
    
    // Clean the response - remove markdown code blocks if present
    let cleanedText = responseText.trim();
    if (cleanedText.startsWith('```json')) {
      cleanedText = cleanedText.slice(7);
    } else if (cleanedText.startsWith('```')) {
      cleanedText = cleanedText.slice(3);
    }
    if (cleanedText.endsWith('```')) {
      cleanedText = cleanedText.slice(0, -3);
    }
    cleanedText = cleanedText.trim();

    const result = JSON.parse(cleanedText);
    return result;
  } catch (error) {
    console.error('Error extracting materials:', error.message);
    throw error;
  }
}

function downloadAudio(url) {
  return new Promise((resolve, reject) => {
    // Build authentication header for Twilio
    const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    
    const headers = {};
    if (twilioAccountSid && twilioAuthToken) {
      const auth = Buffer.from(twilioAccountSid + ':' + twilioAuthToken).toString('base64');
      headers['Authorization'] = 'Basic ' + auth;
    }
    
    https.get(url, { headers, timeout: 30000 }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirect with auth
        https.get(response.headers.location, { headers, timeout: 30000 }, (redirectResponse) => {
          const chunks = [];
          redirectResponse.on('data', (chunk) => chunks.push(chunk));
          redirectResponse.on('end', () => resolve(Buffer.concat(chunks)));
          redirectResponse.on('error', reject);
        }).on('error', reject);
        return;
      }
      
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

async function transcribeAudio(audioUrl) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }
  try {
    console.log('Downloading audio from:', audioUrl);
    const audioBuffer = await downloadAudio(audioUrl);
    console.log('Audio downloaded, size:', audioBuffer.length, 'bytes');
    
    if (audioBuffer.length < 1000) {
      throw new Error('Audio file too small - likely empty or auth failed');
    }
    
    // Create proper File object for Groq SDK
    const file = new File([audioBuffer], 'recording.wav', { type: 'audio/wav' });
    
    const transcription = await groq.audio.transcriptions.create({
      file: file,
      model: 'whisper-large-v3',
      response_format: 'text'
    });

    return transcription.text;
  } catch (error) {
    console.error('Error transcribing audio:', error.message);
    throw error;
  }
}

module.exports = { extractMaterials, transcribeAudio };