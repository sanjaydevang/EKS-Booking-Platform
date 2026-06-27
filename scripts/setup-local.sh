#!/usr/bin/env bash
# ─── Local Development Setup ──────────────────────────────────────────────────
# Run this once to set up the full local stack.
# Prerequisites: Docker, Node.js 20, kubectl, helm, terraform

set -euo pipefail

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         EKS Booking Platform — Local Setup                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── 1. Install Node dependencies ──────────────────────────────────────────────
echo ""
echo "▶ Installing Node.js dependencies..."
for service in booking-service hotel-service inventory-service notification-service; do
  echo "  → $service"
  (cd "apps/$service" && npm install) &
done
wait
echo "✅ Dependencies installed"

# ── 2. Start infrastructure ───────────────────────────────────────────────────
echo ""
echo "▶ Starting local infrastructure (Postgres, Redis, Kafka)..."
docker-compose up -d postgres-bookings postgres-hotels redis kafka

echo "  Waiting for services to be healthy..."
sleep 15

docker-compose up -d kafka-setup
sleep 10

echo "✅ Infrastructure ready"

# ── 3. Start services ─────────────────────────────────────────────────────────
echo ""
echo "▶ Starting microservices..."
docker-compose up -d booking-service hotel-service inventory-service notification-service pms-dashboard
sleep 5
echo "✅ Services started"

# ── 4. Start observability ────────────────────────────────────────────────────
echo ""
echo "▶ Starting observability stack..."
docker-compose up -d prometheus grafana jaeger kafka-ui
echo "✅ Observability ready"

# ── 5. Seed data ─────────────────────────────────────────────────────────────
echo ""
echo "▶ Seeding test data..."
sleep 3

HOTEL_ID=$(curl -sf -X POST http://localhost:3002/api/v1/hotels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Grand Plaza Hotel",
    "address": { "street": "123 Main St", "city": "New York", "state": "NY", "country": "US", "zip": "10001" },
    "star_rating": 5,
    "contact_email": "gm@grandplaza.com",
    "contact_phone": "+1-555-0100",
    "amenities": ["pool", "spa", "gym", "restaurant"],
    "ota_mappings": { "expedia_id": "EXP-12345", "booking_com_id": "BKG-67890" }
  }' | jq -r '.id')

echo "  Created hotel: $HOTEL_ID"

# Activate the hotel
curl -sf -X PUT "http://localhost:3002/api/v1/hotels/$HOTEL_ID/activate" > /dev/null
echo "  Hotel activated"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                    🚀 STACK IS READY                        ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Booking API:    http://localhost:3001/api/v1/bookings       ║"
echo "║  Hotel API:      http://localhost:3002/api/v1/hotels         ║"
echo "║  PMS Dashboard:  http://localhost:3000                       ║"
echo "║  Grafana:        http://localhost:3030  (admin/admin)        ║"
echo "║  Jaeger:         http://localhost:16686                      ║"
echo "║  Kafka UI:       http://localhost:8080                       ║"
echo "║  Prometheus:     http://localhost:9090                       ║"
echo "║  SonarQube:      http://localhost:9000  (admin/admin)        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Test a booking:"
echo "  curl -X POST http://localhost:3001/api/v1/bookings \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{"
echo "      \"hotel_id\": \"$HOTEL_ID\","
echo "      \"room_id\": \"ROOM-001\","
echo "      \"guest_name\": \"John Doe\","
echo "      \"guest_email\": \"john@example.com\","
echo "      \"check_in\": \"2027-03-01\","
echo "      \"check_out\": \"2027-03-05\","
echo "      \"total_amount\": 800,"
echo "      \"source\": \"expedia\","
echo "      \"ota_ref\": \"EXP-REF-999\""
echo "    }'"
