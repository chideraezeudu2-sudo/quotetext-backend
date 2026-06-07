const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { sendSMS } = require('../services/twilio');
const { extractMaterials } = require('../services/groq');
const twilio = require('twilio');

const MessagingResponse = twilio.twiml.MessagingResponse;

// Helper function to format materials list
function formatMaterialsList(materials) {
  return materials.map(m => `${m.quantity} ${m.unit} ${m.item_name}`).join(', ');
}

// Helper function to log message to Supabase
async function logMessage(from, body, direction) {
  try {
    await supabase
      .from('messages')
      .insert({
        from_phone: from,
        body: body,
        direction: direction,
        created_at: new Date().toISOString()
      });
  } catch (error) {
    console.error('Error logging message:', error.message);
  }
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

// Helper function to find most recent pending job for a business
async function findMostRecentPendingJob(businessId) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('business_id', businessId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  if (error) return null;
  return data;
}

// Helper function to find job by customer name
async function findJobByCustomerName(businessId, customerName) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('business_id', businessId)
    .ilike('customer_name', customerName)
    .single();
  
  if (error) return null;
  return data;
}

// Helper function to get materials for a job
async function getJobMaterials(jobId) {
  const { data, error } = await supabase
    .from('materials')
    .select('*')
    .eq('job_id', jobId);
  
  if (error) return [];
  return data || [];
}

// Helper function to create support ticket
async function createSupportTicket(businessId, issue) {
  await supabase
    .from('support_tickets')
    .insert({
      business_id: businessId,
      issue: issue,
      created_at: new Date().toISOString()
    });
}

// Helper function to get all active jobs for a business
async function getActiveJobs(businessId) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('business_id', businessId)
    .neq('status', 'archived')
    .order('created_at', { ascending: false });
  
  if (error) return [];
  return data || [];
}

router.post('/', async (req, res) => {
  const twiml = new MessagingResponse();
  const from = req.body.From || req.body.from;
  const body = (req.body.Body || req.body.body || '').trim();
  const upperBody = body.toUpperCase();

  console.log(`Received SMS from ${from}: ${body}`);

  // Log inbound message
  await logMessage(from, body, 'inbound');

  // Look up business
  const business = await findBusinessByPhone(from);

  if (!business) {
    const reply = "Sorry, we don't recognize this number. Visit quotetext.io to sign up.";
    await logMessage(from, reply, 'outbound');
    twiml.message(reply);
    res.type('text/xml').send(twiml.toString());
    return;
  }

  let reply = '';

  // Command parser - check in order
  if (upperBody === 'YES') {
    // Onboarding flow
    if (!business.onboarding_complete) {
      // Check if this is the trade question response
      if (business.onboarding_trade) {
        // Complete onboarding
        await supabase
          .from('businesses')
          .update({ 
            onboarding_complete: true,
            trade: business.onboarding_trade,
            onboarding_trade: null
          })
          .eq('id', business.id);
        reply = `Welcome to QuoteText, ${business.trade || 'Tradesperson'}! Your subscription is active. Text a job description to get started.`;
      } else {
        // Start onboarding - ask for trade
        await supabase
          .from('businesses')
          .update({ onboarding_trade: body })
          .eq('id', business.id);
        reply = "Welcome to QuoteText. What trade are you in? (e.g. Landscaping, Roofing, Plumbing)";
      }
    } else {
      reply = "Your account is already set up. Text a job description to get started.";
    }

  } else if (upperBody === 'APPROVE') {
    // Approve most recent pending job
    const job = await findMostRecentPendingJob(business.id);
    
    if (!job) {
      reply = "No pending jobs to approve. Text a job description to create one.";
    } else {
      await supabase
        .from('jobs')
        .update({ status: 'approved' })
        .eq('id', job.id);
      
      const materials = await getJobMaterials(job.id);
      const materialsList = formatMaterialsList(materials);
      reply = `Job for ${job.customer_name} approved. Materials: ${materialsList}. Est total: $${job.estimated_total}. Walk in with this list or order online.`;
    }

  } else if (upperBody === 'LIST JOBS') {
    const jobs = await getActiveJobs(business.id);
    
    if (jobs.length === 0) {
      reply = "No active jobs. Text a job description to create one.";
    } else {
      const jobList = jobs.map((job, index) => `${index + 1}. ${job.customer_name} - ${job.status}`).join('\n');
      reply = `Active Jobs:\n${jobList}`;
    }

  } else if (upperBody.startsWith('SHOW ')) {
    const name = body.slice(5).trim();
    const job = await findJobByCustomerName(business.id, name);
    
    if (!job) {
      reply = `No job found for "${name}". Use LIST JOBS to see all jobs.`;
    } else {
      const materials = await getJobMaterials(job.id);
      const materialsList = formatMaterialsList(materials);
      reply = `${job.customer_name} (${job.status}): ${materialsList}. Est: $${job.estimated_total}`;
    }

  } else if (upperBody.startsWith('ORDER ')) {
    const name = body.slice(6).trim();
    const job = await findJobByCustomerName(business.id, name);
    
    if (!job) {
      reply = `No job found for "${name}". Use LIST JOBS to see all jobs.`;
    } else {
      await supabase
        .from('jobs')
        .update({ status: 'ordered' })
        .eq('id', job.id);
      
      const materials = await getJobMaterials(job.id);
      const materialsList = formatMaterialsList(materials);
      reply = `Order confirmed for ${job.customer_name}. Materials: ${materialsList}. Visit your preferred supplier to complete purchase.`;
    }

  } else if (upperBody.startsWith('DONE ')) {
    const name = body.slice(5).trim();
    const job = await findJobByCustomerName(business.id, name);
    
    if (!job) {
      reply = `No job found for "${name}". Use LIST JOBS to see all jobs.`;
    } else {
      await supabase
        .from('jobs')
        .update({ status: 'archived' })
        .eq('id', job.id);
      
      reply = `${job.customer_name}'s job archived.`;
    }

  } else if (upperBody === 'HELP') {
    reply = `QuoteText Commands:
- Text a job description to create a new job
- APPROVE — approve the last job
- LIST JOBS — see all active jobs
- SHOW [name] — see a specific job
- ORDER [name] — order materials for a job
- DONE [name] — archive a job
- CANCEL — cancel your subscription
- REFUND — request a refund
- HUMAN — talk to a human
Email: help@quotetext.io`;

  } else if (upperBody === 'CANCEL') {
    reply = "To cancel your QuoteText subscription reply CONFIRM CANCEL. Your service will continue until end of current billing period.";

  } else if (upperBody === 'CONFIRM CANCEL') {
    await supabase
      .from('businesses')
      .update({ active: false })
      .eq('id', business.id);
    reply = "Your subscription has been cancelled. Thank you for using QuoteText.";

  } else if (upperBody === 'REFUND') {
    reply = "To request your $500 refund reply CONFIRM REFUND. This is only available within 7 days of signup. The $50 setup fee is non-refundable.";

  } else if (upperBody === 'CONFIRM REFUND') {
    await createSupportTicket(business.id, 'REFUND REQUEST');
    reply = "Refund request received. $500 will be returned to your card within 5-7 business days.";

  } else if (upperBody === 'HUMAN') {
    await createSupportTicket(business.id, body);
    reply = "Support ticket created. We'll respond within 24 hours. Email help@quotetext.io for urgent issues.";

  } else {
    // New job description - try to extract materials
    try {
      const extraction = await extractMaterials(body);
      
      if (!extraction.customer_name || !extraction.materials || extraction.materials.length === 0) {
        throw new Error('Invalid extraction result');
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

      if (jobError) throw jobError;

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

      const materialsList = formatMaterialsList(extraction.materials);
      reply = `${extraction.customer_name}'s job created. Materials: ${materialsList}. Est total: $${extraction.estimated_total}. Reply APPROVE to confirm.`;

    } catch (error) {
      console.error('Error processing job description:', error);
      reply = "Sorry I couldn't understand that job description. Try again with more detail e.g. Andrew needs a 20ft stone walkway with gray stones and edging.";
    }
  }

  // Log outbound message
  await logMessage(from, reply, 'outbound');

  // Send TwiML response
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;