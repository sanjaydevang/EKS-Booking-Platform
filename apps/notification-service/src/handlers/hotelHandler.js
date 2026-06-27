const { logger } = require('../utils/logger');

async function handleHotelEvent(event) {
  switch (event.type) {
    case 'HOTEL_ACTIVATED':
      logger.info({ hotelId: event.hotelId }, '[NOTIFY] Hotel activated — welcome email to GM');
      break;
    case 'HOTEL_DEACTIVATED':
      logger.info({ hotelId: event.hotelId }, '[NOTIFY] Hotel deactivated — affected guests will be notified by booking-service');
      break;
    default:
      logger.debug({ type: event.type }, 'Unhandled hotel event');
  }
}

module.exports = { handleHotelEvent };
