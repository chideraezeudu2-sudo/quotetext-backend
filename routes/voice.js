const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { sendSMS } = require('../services/twilio');
const { extractMaterials, transcribeAudio } = require('../services/groq');
const https = require('https');
const http = require('http');

// Helper function to format materials list
function formatMaterialsList(materials) {
  return materials.map(m => `${m.quantity} ${m.unit} ${m.item_name}`).join(', ');
}

// Helper function to find business by phone
async function findBusinessByPhone(phone) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('owner_phone', phone)
    .single();
  
  if (error) return null;
  return data;
}

// Helper function to download audio from URL
function downloadAudio(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol.get(url, { timeout: 30000 }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadAudio(response.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

// ============================================
// ROUTE 1: POST /voice/inbound
// Handles initial call - plays disclosure and starts recording
// ============================================
router.post('/inbound', async (req, res) => {
  const twiml = new (require('twilio').twiml.VoiceResponse)();
  
  console.log('Received inbound call');
  
  // Base URL for callbacks
  const baseUrl = 'https://quotetext-backend.onrender.com';
  
  // Play disclosure message
  twiml.say({
    voice: 'alice',
    language: 'en-US'
  }, 'This call is being recorded for materials management purposes.');
  
  // Start recording with settings - use full URL for callback
  twiml.record({
    action: baseUrl + '/voice/recording',
    method: 'POST',
    maxLength: 3600,
    timeout: 60,
    finishOnKey: '#',
    recordingStatusCallback: baseUrl + '/voice/recording',
    recordingStatusCallbackMethod: 'POST'
  });
  
  console.log('Playing disclosure and starting recording');
  
  res.type('text/xml').send(twiml.toString());
});

// ============================================
// ROUTE 2: POST /voice/recording
// Handles callback after recording ends - transcribes and extracts materials
// ============================================
router.post('/recording', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl || req.body.RecordingURL;
  const from = req.body.From || req.body.from;
  const callSid = req.body.CallSid;
  
  console.log('Received recording callback from ' + from + ', Recording URL: ' + recordingUrl);
  
  // Ignore requests where From is undefined - this is Twilio's double callback issue
  if (!from || from === 'undefined' || from === null) {
    console.log('Ignoring callback with undefined From');
    res.status(200).send('OK');
    return;
  }
  
  if (!recordingUrl) {
    console.log('No recording URL provided');
    res.status(200).send('OK');
    return;
  }
  
  try {
    // Download the audio file
    console.log('Downloading audio from:', recordingUrl);
    const audioBuffer = await downloadAudio(recordingUrl);
    console.log('Audio downloaded, size:', audioBuffer.length, 'bytes');
    
    // Transcribe the audio using Groq Whisper
    console.log('Transcribing audio...');
    const transcript = await transcribeAudio(recordingUrl);
    console.log('Transcript:', transcript);
    
    if (!transcript || transcript.trim().length === 0) {
      console.error('Empty transcript received');
      res.status(200).send('OK');
      return;
    }
    
    // Find business by phone
    const business = await findBusinessByPhone(from);
    if (!business) {
      console.log('Business not found for phone:', from);
      res.status(200).send('OK');
      return;
    }
    
    console.log('Found business:', business.id);
    
    // Extract materials from transcript using Groq AI
    console.log('Extracting materials from transcript...');
    const extraction = await extractMaterials(transcript);
    
    if (!extraction.customer_name || !extraction.materials || extraction.materials.length === 0) {
      console.error('Invalid extraction result:', extraction);
      res.status(200).send('OK');
      return;
    }
    
    console.log('Extracted customer:', extraction.customer_name, 'materials:', extraction.materials.length);
    
    // Insert job into Supabase
    const { data: newJob, error: jobError } = await supabase
      .from('jobs')
      .insert({
        business_id: business.id,
        customer_name: extraction.customer_name,
        estimated_total: extraction.estimated_total,
        status: 'pending',
        created_at: new Date().toISOString()
      })
      .select()
      .single();
    
    if (jobError) {
      console.error('Error creating job:', jobError);
      throw jobError;
    }
    
    console.log('Created job:', newJob.id);
    
    // Insert materials
    const materialsToInsert = extraction.materials.map(m => ({
      job_id: newJob.id,
      item_name: m.item_name,
      quantity: m.quantity,
      unit: m.unit,
      estimated_price: m.estimated_price
    }));
    
    await supabase
      .from('materials')
      .insert(materialsToInsert);
    
    console.log('Inserted', materialsToInsert.length, 'materials');
    
    // Send SMS to owner with material list
    const materialsList = formatMaterialsList(extraction.materials);
    const message = extraction.customer_name + "'s job created from call. Materials: " + materialsList + ". Est total: $" + extraction.estimated_total + ". Reply APPROVE to confirm.";
    
    await sendSMS(from, message);
    console.log('SMS sent to', from + ':', message);
    
  } catch (error) {
    console.error('Error processing recording:', error.message);
  }
  
  res.status(200).send('OK');
});

module.exports = router;
