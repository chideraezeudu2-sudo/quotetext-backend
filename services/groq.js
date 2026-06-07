const Groq = require('groq-sdk');
const https = require('https');
const http = require('http');

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

async function extractMaterials(text) {
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
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, { timeout: 30000 }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirect
        protocol.get(response.headers.location, (redirectResponse) => {
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
  try {
    console.log('Downloading audio from:', audioUrl);
    const audioBuffer = await downloadAudio(audioUrl);
    
    // Create a file-like object for Groq
    const file = {
      buffer: () => Promise.resolve(audioBuffer),
      name: 'audio.wav',
      mimeType: 'audio/wav'
    };
    
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