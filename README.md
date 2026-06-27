# EKS Hotel Booking Platform

A production-grade hotel booking platform built on AWS EKS. This is a **learning project** — every file has inline explanations of what, why, and how.

---

## 

| Topic | Where |
|-------|-------|
| Microservices (Node.js) | `apps/*/src/` |
| Docker multi-stage builds | `apps/*/Dockerfile` |
| K8s Deployment, Service, Ingress, HPA | `k8s/` |
| CI/CD with Jenkins + SonarQube + Trivy | `jenkins/Jenkinsfile` |
| Terraform: VPC, EKS, RDS, MSK, ECR | `terraform/` |
| Kafka messaging patterns | `apps/*/src/kafka/` |
| Prometheus + Grafana + Jaeger | `k8s/monitoring/` |
| OTA integration (Expedia/Booking.com) | booking flows below |

---

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │                  Internet                    │
                    └────────────────────┬────────────────────────┘
                                         │
                              ┌──────────▼──────────┐
                              │   Route 53 (DNS)     │
                              └──────────┬──────────┘
                                         │
                              ┌──────────▼──────────┐
                              │   AWS ALB (public)   │  ← one ALB via Ingress
                              └──┬──────────────┬───┘
                                 │              │
              ┌──────────────────▼──┐    ┌──────▼──────────────┐
              │  api.hotel.com      │    │  dashboard.hotel.com │
              │  (Ingress rules)    │    │  (PMS Dashboard)     │
              └──┬───────┬──────┬──┘    └─────────────────────┘
                 │       │      │
    ┌────────────▼┐ ┌────▼────┐ ┌▼──────────────┐
    │  booking-   │ │ hotel-  │ │  inventory-   │
    │  service    │ │ service │ │  service      │
    │  (3 pods)   │ │ (2 pods)│ │  (2 pods)     │
    └─────┬───────┘ └────┬────┘ └───────────────┘
          │              │
          │  Kafka Events│
          └──────┬───────┘
                 │
    ┌────────────▼─────────────────┐
    │     notification-service     │  (consumes events → sends emails)
    │     (2 pods, no HTTP port)   │
    └──────────────────────────────┘

Data stores (all in private subnets):
  PostgreSQL (RDS Multi-AZ)  — bookings_db, hotels_db
  Redis (ElastiCache)        — session cache, API response cache
  Kafka (MSK 3-broker)       — booking-events, hotel-events topics
```

---

## Services

### booking-service (port 3001)

Core booking engine. Expedia and other OTAs POST to this service.

| Endpoint | What it does |
|----------|-------------|
| `POST /api/v1/bookings` | Create booking (validates, checks inventory, publishes to Kafka) |
| `GET /api/v1/bookings` | List bookings with filters (status, source, hotel_id, dates) |
| `GET /api/v1/bookings/stats` | OTA dashboard stats (revenue by source, daily counts) |
| `PUT /api/v1/bookings/:id/checkin` | Guest checks in → publishes GUEST_CHECKED_IN event |
| `PUT /api/v1/bookings/:id/checkout` | Guest checks out → publishes GUEST_CHECKED_OUT event |
| `DELETE /api/v1/bookings/:id` | Cancel booking → publishes BOOKING_CANCELLED event |
| `GET /health/live` | Liveness probe (K8s restarts pod if this fails) |
| `GET /health/ready` | Readiness probe (K8s removes from load balancer if fails) |
| `GET /metrics` | Prometheus scrape endpoint |

### hotel-service (port 3002)

Hotel onboarding and lifecycle management. Hotel chains register here.

| Endpoint | What it does |
|----------|-------------|
| `POST /api/v1/hotels` | Onboard new hotel (status: pending) |
| `PUT /api/v1/hotels/:id/activate` | Approve hotel (status: active → can receive bookings) |
| `PUT /api/v1/hotels/:id/deactivate` | Take offline (cascades via Kafka → auto-cancels bookings) |
| `PUT /api/v1/hotels/:id/ota-sync` | Map hotel to Expedia/Booking.com IDs |

### notification-service (no HTTP port)

Pure Kafka consumer. No service, no ingress — just pods consuming events and sending emails.

### inventory-service (port 3003)

Room availability management. booking-service calls this before confirming a booking.

---

## Quick Start (Local)

```bash
# 1. Clone and setup
git clone <repo>
cd eks-booking-platform
./scripts/setup-local.sh

# 2. Create a test booking from Expedia
curl -X POST http://localhost:3001/api/v1/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "hotel_id": "<hotel-id-from-setup>",
    "room_id": "ROOM-101",
    "guest_name": "Jane Smith",
    "guest_email": "jane@example.com",
    "check_in": "2027-06-01",
    "check_out": "2027-06-05",
    "total_amount": 1200,
    "source": "expedia",
    "ota_ref": "EXP-2024-98765"
  }'

# 3. Check in
curl -X PUT http://localhost:3001/api/v1/bookings/<id>/checkin

# 4. View in Grafana: http://localhost:3030
# 5. View traces in Jaeger: http://localhost:16686
# 6. View Kafka messages: http://localhost:8080
```

---

## Kubernetes Concepts Explained

### How a request flows through K8s

```
Browser/Expedia API call
  → Route53 (DNS) → ALB (public load balancer)
  → Ingress Controller reads path rules
  → Routes to Service (ClusterIP)
  → Service selects Pods via label selector
  → Pod handles request
  → Response goes back the same way
```

### Service vs Ingress

- **Service**: stable IP for a group of pods. Types: ClusterIP (internal), LoadBalancer (one ALB per service = expensive).
- **Ingress**: ONE load balancer routes to MANY services based on path/host rules. This is what we use.

### Why 3 replicas?

```
Node failure:    3 pods on 3 nodes → 1 node dies → 2 pods still serve traffic
Rolling update:  maxUnavailable=0 → new pods come up, old pods shut down → zero downtime
HPA scale-up:    CPU > 70% → K8s adds pods automatically (up to 10)
```

### Liveness vs Readiness

```
/health/live  → "Is this pod alive?" → K8s RESTARTS if fails
/health/ready → "Is this pod ready for traffic?" → K8s REMOVES from LB if fails
               (pod keeps running, just gets no new requests — useful during DB reconnect)
```

### K8s DNS (service discovery)

```
booking-service → http://inventory-service:3003
                     ↑
                     CoreDNS resolves this to:
                     inventory-service.booking.svc.cluster.local
                     which is the Service's ClusterIP
                     which load-balances across all inventory-service pods
```

---

## CI/CD Pipeline (Jenkins)

```
Developer pushes to main
       │
       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Jenkins Pipeline                                 │
│                                                                     │
│  1. Checkout     — git clone                                        │
│  2. Install      — npm ci (reproducible)                            │
│  3. Lint         — ESLint                                           │
│  4. Unit Tests   — Jest + coverage report                           │
│  5. SonarQube    — code quality analysis                            │
│  6. Quality Gate — WAIT for SonarQube pass/fail                    │
│                    (fails pipeline if coverage < 70% or new bugs)   │
│  7. Build Docker — multi-stage build                                │
│  8. Trivy Scan   — scan image for CVEs                              │
│                    (fails pipeline if HIGH/CRITICAL found)          │
│  9. Push to ECR  — tagged with build number + git SHA              │
│  10. Deploy EKS  — kubectl set image → rolling update              │
│  11. Integration — tests against live service                       │
│  12. Smoke Test  — quick health check                               │
│                                                                     │
│  On failure → auto-rollback (prod only) + Slack alert              │
└─────────────────────────────────────────────────────────────────────┘
```

### SonarQube Quality Gates

SonarQube analyzes code BEFORE it becomes a Docker image. It fails the pipeline if:
- Code coverage drops below 70%
- Any new **bug** or **vulnerability** is found
- Code duplication exceeds 15%
- Any security hotspot is unreviewed

```bash
# Run locally before pushing:
npx sonar-scanner -Dsonar.projectKey=booking-service \
  -Dsonar.host.url=http://localhost:9000 \
  -Dsonar.login=admin
```

### Trivy Image Scanning

Trivy scans the built Docker image for:
- Alpine OS package CVEs
- node_modules dependency CVEs
- Secrets accidentally baked into image
- Dockerfile misconfigurations

```bash
# Run locally:
trivy image booking-service:latest --severity HIGH,CRITICAL
```

---

## Terraform — Infrastructure as Code

```bash
cd terraform/environments/prod

# Initialize (downloads providers, configures S3 backend)
terraform init

# Preview what will be created
terraform plan -var="db_password=your-secret"

# Apply (creates VPC, EKS, RDS, MSK, ECR in ~20 minutes)
terraform apply -var="db_password=your-secret"

# Get cluster credentials
aws eks update-kubeconfig --name booking-platform-prod --region us-east-1

# Verify nodes
kubectl get nodes
```

### Infrastructure Created

| Resource | Purpose |
|----------|---------|
| VPC (3 public + 3 private subnets) | Network isolation across 3 AZs |
| EKS cluster (3x m5.large nodes) | Kubernetes control plane + workers |
| RDS PostgreSQL Multi-AZ (2 instances) | bookings_db, hotels_db |
| MSK Kafka (3 brokers) | booking-events, hotel-events topics |
| ElastiCache Redis | API response cache |
| ECR (5 repositories) | Private Docker registry |
| ALB via Ingress | Single load balancer for all services |
| CloudWatch | Logs from all pods via Fluent Bit |

---

## Observability

### Prometheus + Grafana

Every service exposes `/metrics`. Prometheus scrapes every 15 seconds.
Grafana dashboards show:
- Request rate, error rate, latency (p50/p95/p99) per service
- Bookings by OTA source (Expedia, Booking.com, Direct)
- Kafka consumer lag (notification-service keeping up?)
- Pod count vs desired replicas
- PostgreSQL connection pool usage

```bash
# Access locally:
open http://localhost:3030  # Grafana (admin/admin)
open http://localhost:9090  # Prometheus
```

### Jaeger — Distributed Tracing

Every request gets a trace ID. You can see EXACTLY:
- Which service handled the request
- How long the DB query took
- Which Kafka message triggered a downstream action
- Where a slow request bottlenecked

```bash
open http://localhost:16686  # Jaeger UI
# Search: Service = booking-service, Operation = POST /api/v1/bookings
```

### Alerts

`k8s/monitoring/prometheus/prometheus-rules.yaml` defines:
- Error rate > 5% → Slack alert (critical)
- p95 latency > 2s → Slack alert (warning)
- Pod count below desired → Slack alert (critical)
- Kafka consumer lag > 1000 → Slack alert (warning)
- Expedia bookings stopped → Slack alert (warning)

---

## Hotel Onboarding Workflow

```bash
# Step 1: Hotel registers (status: pending)
curl -X POST http://localhost:3002/api/v1/hotels \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sunset Beach Resort",
    "address": { "street": "1 Ocean Drive", "city": "Miami", "state": "FL", "country": "US", "zip": "33139" },
    "star_rating": 4,
    "contact_email": "gm@sunsetbeach.com",
    "contact_phone": "+1-305-555-0100"
  }'

# Step 2: Admin reviews and activates (status: active → can receive bookings)
curl -X PUT http://localhost:3002/api/v1/hotels/<hotel-id>/activate

# Step 3: Map to OTA channels (Expedia, Booking.com)
curl -X PUT http://localhost:3002/api/v1/hotels/<hotel-id>/ota-sync \
  -H "Content-Type: application/json" \
  -d '{ "expedia_id": "EXP-99999", "booking_com_id": "BKG-88888" }'

# Step 4: Expedia sends bookings using your hotel_id as reference
# The booking arrives at booking-service with source: "expedia"

# Step 5: Deactivating cascades via Kafka → auto-cancels future bookings
curl -X PUT http://localhost:3002/api/v1/hotels/<hotel-id>/deactivate
```

---

## Kafka Messaging Flow

```
booking-service                  Kafka                  notification-service
      │                           │                              │
      │── BOOKING_CREATED ───────▶│── booking-events ──────────▶│── send confirmation email
      │                           │                              │
      │── GUEST_CHECKED_IN ──────▶│── booking-events ──────────▶│── send welcome message
      │                           │                              │
      │── BOOKING_CANCELLED ─────▶│── booking-events ──────────▶│── send cancellation email

hotel-service                    Kafka                  booking-service
      │                           │                              │
      │── HOTEL_DEACTIVATED ─────▶│── hotel-events ────────────▶│── cancel all future bookings
      │                           │                                    for this hotel
```

**Dead Letter Queue (DLQ)**: If notification-service fails to process a message 3 times, it goes to `booking-events-dlq` for manual review.

---

## Adding a New Service

1. Create `apps/my-service/` with `src/`, `Dockerfile`, `package.json`
2. Add `k8s/my-service/deployment.yaml` + `service.yaml`
3. Add path rule to `k8s/ingress/ingress.yaml`
4. Add ECR repo to `terraform/modules/ecr/main.tf` services list
5. Add Jenkinsfile or extend the shared one with `params.SERVICE = 'my-service'`
6. Add Prometheus scrape config to `docker/prometheus.yml`

---

## Directory Structure

```
eks-booking-platform/
├── apps/
│   ├── booking-service/    # Core booking API
│   ├── hotel-service/      # Hotel onboarding
│   ├── inventory-service/  # Room availability
│   ├── notification-service/ # Kafka consumer → email
│   └── pms-dashboard/      # React frontend
├── k8s/
│   ├── namespaces/         # booking, monitoring, kafka namespaces + quotas
│   ├── booking-service/    # Deployment + Service + HPA
│   ├── hotel-service/
│   ├── ingress/            # ALB Ingress rules
│   └── monitoring/
│       ├── prometheus/     # Alert rules (PrometheusRule CRD)
│       └── grafana/        # Dashboard JSON
├── terraform/
│   ├── modules/
│   │   ├── vpc/            # VPC, subnets, NAT, flow logs
│   │   ├── eks/            # Cluster, node group, IRSA, add-ons
│   │   ├── rds/            # PostgreSQL Multi-AZ
│   │   ├── msk/            # Kafka cluster
│   │   ├── ecr/            # Container registry
│   │   └── redis/          # ElastiCache
│   └── environments/
│       ├── dev/            # Smaller instances, no Multi-AZ
│       └── prod/           # Full HA, Multi-AZ, Cluster Autoscaler
├── jenkins/
│   └── Jenkinsfile         # Full CI/CD: test → sonar → trivy → deploy
├── docker-compose.yml      # Full local stack (identical to EKS)
├── docker/
│   └── prometheus.yml      # Prometheus scrape config for local
└── scripts/
    └── setup-local.sh      # One-command local setup
```
