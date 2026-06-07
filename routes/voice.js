const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { sendSMS } = require('../services/twilio');
const { extractMaterials, transcribeAudio } = require('../services/groq');

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

router.post('/', async (req, res) => {
  const recordingUrl = req.body.RecordingUrl || req.body.RecordingURL;
  const from = req.body.From || req.body.from;

  console.log(`Received voice callback from ${from}, Recording URL: ${recordingUrl}`);

  if (!recordingUrl) {
    console.log('No recording URL provided');
    res.status(200).send('OK');
    return;
  }

  try {
    // Transcribe the audio
    const transcript = await transcribeAudio(recordingUrl);
    console.log(`Transcript: ${transcript}`);

    if (!transcript) {
      console.error('Empty transcript received');
      res.status(200).send('OK');
      return;
    }

    // Find business
    const business = await findBusinessByPhone(from);
    if (!business) {
      console.log(`Business not found for phone: ${from}`);
      res.status(200).send('OK');
      return;
    }

    // Extract materials from transcript
    const extraction = await extractMaterials(transcript);

    if (!extraction.customer_name || !extraction.materials || extraction.materials.length === 0) {
      console.error('Invalid extraction result from transcript');
      res.status(200).send('OK');
      return;
    }

    // Insert job
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

    // Send SMS to owner with material list
    const materialsList = formatMaterialsList(extraction.materials);
    const message = `${extraction.customer_name}'s job created from call. Materials: ${materialsList}. Est total: $${extraction.estimated_total}. Reply APPROVE to confirm.`;

    await sendSMS(from, message);
    console.log(`SMS sent to ${from}: ${message}`);

  } catch (error) {
    console.error('Error processing voice callback:', error.message);
  }

  res.status(200).send('OK');
});

module.exports = router;