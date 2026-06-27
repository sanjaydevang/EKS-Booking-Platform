const { logger } = require('../utils/logger');

/**
 * Maps booking event types to notification templates and channels.
 * In production: replace sendEmail with SES/SendGrid SDK calls.
 */
async function handleBookingEvent(event) {
  switch (event.type) {
    case 'BOOKING_CREATED':
      await sendEmail({
        to: event.guestEmail,
        subject: `Booking Confirmed — ${event.hotelId}`,
        body: `Dear ${event.guestName}, your booking from ${event.checkIn} to ${event.checkOut} is confirmed. (Source: ${event.source}) Ref: ${event.bookingId}`
      });
      logger.info({ bookingId: event.bookingId, email: event.guestEmail }, 'Confirmation email sent');
      break;

    case 'GUEST_CHECKED_IN':
      await sendEmail({
        to: event.guestEmail,
        subject: 'Welcome! Check-in Complete',
        body: `Dear ${event.guestName}, you've successfully checked in. Enjoy your stay!`
      });
      break;

    case 'GUEST_CHECKED_OUT':
      await sendEmail({
        to: event.guestEmail,
        subject: 'Thank you for your stay!',
        body: `Dear guest, we hope you enjoyed your stay. Please leave a review!`
      });
      break;

    case 'BOOKING_CANCELLED':
      await sendEmail({
        to: event.guestEmail,
        subject: 'Booking Cancelled',
        body: `Your booking ${event.bookingId} has been cancelled.`
      });
      break;

    default:
      logger.warn({ type: event.type }, 'Unknown booking event type');
  }
}

async function sendEmail({ to, subject, body }) {
  // Production: use AWS SES
  // const ses = new AWS.SES();
  // await ses.sendEmail({ Source: 'noreply@hotel.com', Destination: { ToAddresses: [to] }, ... }).promise();
  logger.info({ to, subject }, '[EMAIL STUB] Would send email');
  // Simulate async send latency
  await new Promise(r => setTimeout(r, 50));
}

module.exports = { handleBookingEvent };
