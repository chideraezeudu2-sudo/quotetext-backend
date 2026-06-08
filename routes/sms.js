const express = require('express');
const router = express.Router();
const { supabase } = require('../services/supabase');
const { sendSMS } = require('../services/twilio');
const { extractMaterials, classifyIntent, answerQuery } = require('../services/groq');
const twilio = require('twilio');

const MessagingResponse = twilio.twiml.MessagingResponse;

// Helper function to format materials list
function formatMaterialsList(materials) {
  return materials.map(m => m.quantity + ' ' + m.unit + ' ' + m.item_name).join(', ');
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
    .limit(1);
  
  if (error || !data || data.length === 0) return null;
  return data[0];
}

// Helper function to find job by customer name
async function findJobByCustomerName(businessId, customerName) {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('business_id', businessId)
    .ilike('customer_name', '%' + customerName + '%')
    .order('created_at', { ascending: false })
    .limit(1)
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

  console.log('Received SMS from ' + from + ': ' + body);

  // Log inbound message
  await logMessage(from, body, 'inbound');

  // Look up business
  let business = await findBusinessByPhone(from);

  // If no business, check intent to see if they want to start onboarding
  if (!business) {
    const intentResult = await classifyIntent(body);
    
    if (intentResult.intent === 'NEW_JOB' || intentResult.intent === 'ONBOARDING_RESPONSE') {
      // Create new business record
      const { data: newBusiness, error } = await supabase
        .from('businesses')
        .insert({
          owner_phone: from,
          onboarding_step: 'start',
          onboarding_complete: false,
          created_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (error || !newBusiness) {
        console.error('Failed to create business:', error);
        const reply = "Sorry, something went wrong. Please try again.";
        twiml.message(reply);
        res.type('text/xml').send(twiml.toString());
        return;
      }
      
      business = newBusiness;
      const reply = "Welcome to QuoteText! What trade are you in? (e.g. Landscaping, Roofing, Plumbing, Electrical)";
      twiml.message(reply);
      await logMessage(from, reply, 'outbound');
      res.type('text/xml').send(twiml.toString());
      return;
    }
    
    const reply = "Sorry, we don't recognize this number. Visit quotetext.io to sign up.";
    await logMessage(from, reply, 'outbound');
    twiml.message(reply);
    res.type('text/xml').send(twiml.toString());
    return;
  }

  let reply = '';

  // ONBOARDING FLOW - Check onboarding_step on every message if not complete
  if (!business.onboarding_complete) {
    const step = business.onboarding_step || 'start';
    
    if (step === 'start') {
      await supabase.from('businesses').update({ trade: body, onboarding_step: 'supplier' }).eq('id', business.id);
      reply = "What is your preferred supplier? (e.g. Home Depot, Lowe's, Ferguson, SiteOne, Menards)";

    } else if (step === 'supplier') {
      await supabase.from('businesses').update({ preferred_supplier: body, onboarding_step: 'store' }).eq('id', business.id);
      reply = "What is your go-to store location? (e.g. Store #1234, Downtown location)";

    } else if (step === 'store') {
      await supabase.from('businesses').update({ store_location: body, onboarding_step: 'delivery' }).eq('id', business.id);
      reply = "Last step - optional but powerful. Want QuoteText to capture materials from your customer calls? Reply YES to set it up or SKIP to skip.";

    } else if (step === 'delivery') {
      await supabase.from('businesses').update({ delivery_preference: body, onboarding_step: 'forwarding' }).eq('id', business.id);
      reply = "Last step - optional but powerful. Want QuoteText to capture materials from your customer calls? Reply YES to set it up or SKIP to skip.";

    } else if (step === 'forwarding') {
      const upperBody = body.toUpperCase();
      if (upperBody.includes('SKIP') || upperBody.includes('NO') || upperBody.includes('NAHH') || upperBody.includes('NAH')) {
        await supabase.from('businesses').update({ onboarding_step: 'complete', onboarding_complete: true, active: true }).eq('id', business.id);
        reply = "No problem. Just text us job descriptions anytime and we'll build your material list. You're all set. Text HELP anytime.";
      } else if (upperBody.includes('YES') || upperBody.includes('YEAH') || upperBody.includes('YEP') || upperBody.includes('YUP')) {
        await supabase.from('businesses').update({ onboarding_step: 'forwarding_wait' }).eq('id', business.id);
        reply = "To forward your calls: On your phone dial *72 then 2566374466 and press call. That's it. Text DONE when finished or HELP if it's not working.";
      } else {
        reply = "Want to capture materials from calls? Reply YES to set up call forwarding or SKIP to skip.";
      }

    } else if (step === 'forwarding_wait') {
      const upperBody = body.toUpperCase();
      if (upperBody.includes('DONE') || upperBody.includes('FINISHED') || upperBody.includes('SET IT UP') || upperBody.includes('DID IT')) {
        await supabase.from('businesses').update({ call_forwarding_enabled: true, onboarding_step: 'complete', onboarding_complete: true, active: true }).eq('id', business.id);
        reply = "Perfect. Your calls will now be automatically captured. You're all set. Text HELP anytime.";
      } else if (upperBody.includes('HELP')) {
        reply = "No worries. Forward calls by dialing *72 then your QuoteText number. Works on most carriers. If yours is different Google 'call forwarding' plus your carrier name. Or just skip it and text us jobs manually - reply SKIP.";
      } else if (upperBody.includes('SKIP') || upperBody.includes('NO')) {
        await supabase.from('businesses').update({ onboarding_step: 'complete', onboarding_complete: true, active: true }).eq('id', business.id);
        reply = "No problem. Just text us job descriptions anytime and we'll build your material list. You're all set. Text HELP anytime.";
      } else {
        reply = "Text DONE when you've set up call forwarding, or SKIP to skip.";
      }
    } else {
      // Default
      reply = "What trade are you in? (e.g. Landscaping, Roofing, Plumbing)";
    }

  } else {
    // ONBOARDING COMPLETE - Use intent classification for natural language
    const intentResult = await classifyIntent(body);
    console.log('Intent classified:', JSON.stringify(intentResult));
    
    const { intent, customer_name, query } = intentResult;
    const upperBody = body.toUpperCase();

    if (intent === 'APPROVE' || (upperBody.includes('YES') && upperBody.includes('APPROVE'))) {
      const job = await findMostRecentPendingJob(business.id);
      
      if (!job) {
        reply = "No pending jobs to approve. Text a job description to create one.";
      } else {
        await supabase.from('jobs').update({ status: 'approved' }).eq('id', job.id);
        const materials = await getJobMaterials(job.id);
        const materialsList = formatMaterialsList(materials);
        reply = 'Job for ' + job.customer_name + ' approved. Materials: ' + materialsList + '. Est total: $' + job.estimated_total + '. Walk in with this list or order online.';
      }

    } else if (intent === 'LIST_JOBS') {
      const jobs = await getActiveJobs(business.id);
      
      if (jobs.length === 0) {
        reply = "No active jobs. Text a job description to create one.";
      } else {
        const jobList = jobs.map((job, index) => (index + 1) + '. ' + job.customer_name + ' - ' + job.status).join('\n');
        reply = 'Active Jobs:\n' + jobList;
      }

    } else if (intent === 'SHOW_JOB' || intent === 'QUERY') {
      const name = customer_name || (query ? query.replace(/^(what|show|who|tell|details|about)\s+/i, '').trim() : null);
      
      if (name) {
        const job = await findJobByCustomerName(business.id, name);
        
        if (!job) {
          reply = 'No job found for "' + name + '". Text "show all jobs" to see active jobs.';
        } else if (intent === 'QUERY' && job.transcript) {
          const answer = await answerQuery(job.transcript, query || body);
          reply = answer;
        } else {
          const materials = await getJobMaterials(job.id);
          const materialsList = formatMaterialsList(materials);
          reply = job.customer_name + ' (' + job.status + '): ' + materialsList + '. Est: $' + job.estimated_total;
        }
      } else {
        reply = "Which job do you want to see? Text the customer name.";
      }

    } else if (intent === 'ORDER_JOB') {
      const name = customer_name || query;
      
      if (name) {
        const job = await findJobByCustomerName(business.id, name);
        
        if (!job) {
          reply = 'No job found for "' + name + '". Text "show all jobs" to see active jobs.';
        } else {
          await supabase.from('jobs').update({ status: 'ordered' }).eq('id', job.id);
          const materials = await getJobMaterials(job.id);
          const materialsList = formatMaterialsList(materials);
          reply = 'Order confirmed for ' + job.customer_name + '. Materials: ' + materialsList + '. Visit your preferred supplier to complete purchase.';
        }
      } else {
        reply = "Which job do you want to order? Text the customer name.";
      }

    } else if (intent === 'DONE_JOB') {
      const name = customer_name || query;
      
      if (name) {
        const job = await findJobByCustomerName(business.id, name);
        
        if (!job) {
          reply = 'No job found for "' + name + '". Text "show all jobs" to see active jobs.';
        } else {
          await supabase.from('jobs').update({ status: 'archived' }).eq('id', job.id);
          reply = job.customer_name + "'s job archived.";
        }
      } else {
        reply = "Which job is done? Text the customer name.";
      }

    } else if (intent === 'HELP') {
      reply = 'QuoteText Commands:\n- Text a job description to create a new job\n- Say "yes" or "approve" to approve the last job\n- Say "show me all jobs" or "list jobs" to see active jobs\n- "what did [customer] want" to query a job\n- "order [customer]" to order materials\n- "done [customer]" to archive a job\n- "help" for this list\nEmail: help@quotetext.io';

    } else if (intent === 'CANCEL') {
      reply = "To cancel your QuoteText subscription reply CONFIRM CANCEL. Your service will continue until end of current billing period.";

    } else if (intent === 'HUMAN') {
      await createSupportTicket(business.id, body);
      reply = "Support ticket created. We'll respond within 24 hours. Email help@quotetext.io for urgent issues.";

    } else {
      // Default: treat as new job description
      try {
        const extraction = await extractMaterials(body);
        
        if (!extraction.customer_name || !extraction.materials || extraction.materials.length === 0) {
          throw new Error('Invalid extraction result');
        }

        // Insert job with transcript
        const { data: newJob, error: jobError } = await supabase
          .from('jobs')
          .insert({
            business_id: business.id,
            customer_name: extraction.customer_name,
            job_description: extraction.job_description || body,
            transcript: body,
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

        await supabase.from('materials').insert(materialsToInsert);

        const materialsList = formatMaterialsList(extraction.materials);
        reply = extraction.customer_name + "'s job created. Materials: " + materialsList + ". Est total: $" + extraction.estimated_total + ". Reply yes to confirm.";

      } catch (error) {
        console.error('Error processing job description:', error);
        reply = "Sorry I couldn't understand that. Try describing the job in plain English, e.g. 'Andrew needs a 20ft stone walkway with gray stones and edging.'";
      }
    }
  }

  // Log outbound message
  await logMessage(from, reply, 'outbound');

  // Send TwiML response
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

module.exports = router;
