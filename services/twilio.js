const twilio = require('twilio');
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

const client = twilio(accountSid, authToken);

async function sendSMS(to, body) {
  try {
    const message = await client.messages.create({
      body: body,
      from: fromNumber,
      to: to
    });
    console.log(`SMS sent to ${to}: ${message.sid}`);
    return message;
  } catch (error) {
    console.error(`Failed to send SMS to ${to}:`, error.message);
    throw error;
  }
}

module.exports = { sendSMS };