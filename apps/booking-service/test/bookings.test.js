const request = require('supertest');

// Mock all external dependencies so unit tests don't need real DB/Kafka/Redis
jest.mock('../src/tracing', () => {});
jest.mock('../src/models/db', () => ({
  connectDB: jest.fn(),
  pool: {
    query: jest.fn()
  }
}));
jest.mock('../src/kafka/producer', () => ({
  initKafkaProducer: jest.fn(),
  publishEvent: jest.fn()
}));
jest.mock('../src/kafka/consumer', () => ({
  startKafkaConsumer: jest.fn()
}));
jest.mock('../src/utils/redis', () => ({
  connectRedis: jest.fn(),
  getCache: jest.fn().mockResolvedValue(null),
  setCache: jest.fn(),
  deleteCache: jest.fn()
}));

const { pool } = require('../src/models/db');
const app = require('../src/index');

describe('Booking Service', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /health/live', () => {
    it('returns 200 alive', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('alive');
    });
  });

  describe('POST /api/v1/bookings', () => {
    it('returns 400 for invalid payload', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .send({ guest_name: 'Test' });
      expect(res.status).toBe(400);
    });

    it('creates a booking with valid payload', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'mock-booking-id', status: 'confirmed', source: 'expedia' }] })
        .mockResolvedValueOnce({ rows: [] }); // event insert

      const res = await request(app)
        .post('/api/v1/bookings')
        .send({
          hotel_id: '550e8400-e29b-41d4-a716-446655440000',
          room_id: '550e8400-e29b-41d4-a716-446655440001',
          guest_name: 'John Doe',
          guest_email: 'john@example.com',
          check_in: '2027-01-15',
          check_out: '2027-01-20',
          total_amount: 500.00,
          source: 'expedia'
        });

      expect(res.status).toBe(201);
      expect(res.body.source).toBe('expedia');
    });
  });

  describe('PUT /api/v1/bookings/:id/checkin', () => {
    it('checks in a confirmed booking', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ id: 'mock-id', status: 'checked_in' }] })
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app).put('/api/v1/bookings/mock-id/checkin');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('checked_in');
    });

    it('returns 404 for non-existent booking', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });
      const res = await request(app).put('/api/v1/bookings/nonexistent/checkin');
      expect(res.status).toBe(404);
    });
  });
});
