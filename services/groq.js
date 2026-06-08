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
          content: `You are an expert materials estimator for trade businesses (landscaping, roofing, plumbing, electrical, masonry, etc.). 

When given a job description from a customer call, you must:
1. Identify the customer name (they may say "my name is X" or "this is X" or just refer to themselves as "I" - look for any name mentioned)
2. Create a structured material list with REAL trade materials - infer what they need from their vague descriptions
3. For vague descriptions like "gravel for my driveway" infer the type, quantity, and unit based on common industry standards
4. Include realistic estimated prices based on current material costs

EXAMPLES OF INFERENCES:
- "put some stone down" → 2" clean stone, 1 ton, $45-65/ton
- "gravel for my driveway" → 3/4" crushed stone, 3 tons, $35-50/ton
- "pavers for a walkway" → 4x8" concrete pavers, 200 sqft coverage, $3-5/sqft
- "need dirt" → screened topsoil, 3 yards, $30-45/cubic yard

Return ONLY valid JSON with no markdown:
{
  "customer_name": "string (use the name they gave, or 'Unknown')",
  "job_description": "string (plain English summary of what the customer wants done)",
  "materials": [
    {
      "item_name": "string (specific material name like '3/4\" Crushed Stone')",
      "quantity": number,
      "unit": "string (ton, yard, bag, pallet, each, sqft, linear ft)",
      "estimated_price": number
    }
  ],
  "estimated_total": number
}

Be thorough and specific. Use real material names and realistic quantities.`
        },
        {
          role: 'user',
          content: text
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3
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

// Classify the intent of an inbound SMS message
async function classifyIntent(message) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Classify this SMS message into one of these intents:
- NEW_JOB: They want to create a new job/materials list
- APPROVE: They want to approve a pending job
- LIST_JOBS: They want to see all their jobs
- SHOW_JOB: They want details on a specific job
- ORDER_JOB: They want to place an order
- DONE_JOB: They marked a job as complete/finished
- HELP: They need help with something
- CANCEL: They want to cancel something
- REFUND: They want a refund
- HUMAN: They want to talk to a human
- QUERY: They have a question about a job or customer
- ONBOARDING_RESPONSE: They're still in the onboarding/setup flow
- UNKNOWN: Can't determine intent

Also extract any customer name mentioned and any specific query content.

Return ONLY valid JSON with no markdown:
{ "intent": "string", "customer_name": "string or null", "query": "string or null" }`
        },
        {
          role: 'user',
          content: message
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1
    });

    const responseText = completion.choices[0]?.message?.content || '';
    
    // Clean the response
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
    console.error('Error classifying intent:', error.message);
    // Return UNKNOWN on error so the system doesn't break
    return { intent: 'UNKNOWN', customer_name: null, query: null };
  }
}

// Answer a query about a job based on the transcript
async function answerQuery(transcript, question) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error('GROQ_API_KEY not configured');
  }
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are answering a business owner's question about a customer job. You have the original call transcript and the owner's question.

Answer based ONLY on what the customer said in the transcript. Be specific and cite what the customer said when relevant.

Format your answer in plain, natural language that sounds like you're helping a contractor understand what their customer wanted.`
        },
        {
          role: 'user',
          content: `Original call transcript:\n${transcript}\n\nOwner's question: ${question}\n\nAnswer:`
        }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.5
    });

    return completion.choices[0]?.message?.content || "I couldn't find an answer based on the transcript.";
  } catch (error) {
    console.error('Error answering query:', error.message);
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
    
    // Create proper File object for Groq SDK with explicit type
    const file = new File([audioBuffer], 'recording.wav', { 
      type: 'audio/wav' 
    });
    
    console.log('Sending to Groq Whisper...');
    const transcription = await groq.audio.transcriptions.create({
      file: file,
      model: 'whisper-large-v3',
      response_format: 'verbose_json'
    });

    console.log('Groq response:', JSON.stringify(transcription));
    
    // Handle different response formats
    let transcriptText = '';
    if (transcription.text) {
      transcriptText = transcription.text;
    } else if (transcription.transcription && transcription.transcription.text) {
      transcriptText = transcription.transcription.text;
    } else if (typeof transcription === 'string') {
      transcriptText = transcription;
    } else {
      throw new Error('Unexpected transcription response format');
    }
    
    return transcriptText;
  } catch (error) {
    console.error('Error transcribing audio:', error.message);
    throw error;
  }
}

module.exports = { extractMaterials, transcribeAudio, classifyIntent, answerQuery };