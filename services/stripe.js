const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function createCheckoutSession() {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'QuoteText Setup Fee',
            description: 'Non-refundable setup fee'
          },
          unit_amount: 5000 // $50 in cents
        },
        quantity: 1
      },
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'QuoteText First Month',
            description: 'First month subscription'
          },
          unit_amount: 50000 // $500 in cents
        },
        quantity: 1
      }
    ],
    mode: 'payment',
    success_url: 'https://quotetext.io/success',
    cancel_url: 'https://quotetext.io/cancel'
  });

  return session.url;
}

module.exports = { stripe, createCheckoutSession };