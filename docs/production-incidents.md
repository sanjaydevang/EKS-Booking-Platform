# Production Incidents, Postmortems & Reliability Engineering

Real incidents encountered operating the EKS Booking Platform at scale.
Each entry has: what broke, how it was detected, how it was fixed, what was built to prevent recurrence.

---

## INCIDENT-001 — Expedia Booking Spike Caused Cascading DB Connection Exhaustion

**Severity:** P1 — Revenue Impact  
**Duration:** 47 minutes  
**Date:** Black Friday weekend  
**Services Affected:** booking-service, inventory-service  

### What Happened

Expedia ran a flash sale. Booking requests spiked 8x normal traffic in under 3 minutes.
`booking-service` HPA scaled pods from 3 → 10, but each new pod opened its own PostgreSQL
connection pool (max 20 connections each). With 10 pods × 20 connections = 200 connections,
we hit RDS `max_connections` limit of 200. New pods couldn't connect. Old pods started
timing out. Error rate hit 34% within 8 minutes.

### How It Was Detected

- Grafana alert fired: `PostgresConnectionsHigh` — connections > 180
- PagerDuty page to on-call at 2:14 AM
- Booking error rate alert: `BookingServiceHighErrorRate` > 5% fired 4 minutes later
- Expedia's webhook retry storms amplified the problem (retried failed bookings every 30s)

### Timeline

```
02:14 — Grafana alert: DB connections > 180
02:17 — On-call acknowledges, opens Jaeger to trace slow requests
02:19 — Traces show all requests failing at pg.connect() — pool exhausted
02:21 — Identified: 10 pods × 20 pool size = 200 connections, RDS limit hit
02:28 — Mitigation 1: kubectl scale deployment booking-service --replicas=5
          (reduced pods, freed connections, error rate dropped to 8%)
02:35 — Mitigation 2: RDS instance scaled up (db.t3.medium → db.r5.large)
          max_connections increased to 500
02:41 — Error rate back to 0.2%, incident resolved
03:01 — Full traffic restored, monitoring confirmed stable
```

### Root Cause

No connection pooler between the application and RDS. Each pod managed its own pool.
HPA scaled pods without accounting for downstream DB connection limits.
No alert existed for connection pool saturation at the pod level.

### Postmortem Actions Taken

**1. Deployed PgBouncer as a connection pooler (sidecar pattern)**
```yaml
# Added to booking-service Deployment — pgbouncer sidecar
- name: pgbouncer
  image: pgbouncer/pgbouncer:1.21.0
  env:
    - name: POOL_MODE
      value: "transaction"      # one DB connection shared across many app requests
    - name: MAX_CLIENT_CONN
      value: "1000"             # app connects to pgbouncer (up to 1000)
    - name: DEFAULT_POOL_SIZE
      value: "20"               # pgbouncer maintains only 20 real DB connections
  ports:
    - containerPort: 5432
```
Result: 10 pods now share 20 real DB connections instead of owning 200.

**2. Added HPA custom metric: scale on DB connection count, not just CPU**
```yaml
metrics:
  - type: External
    external:
      metric:
        name: pg_stat_activity_count
      target:
        type: AverageValue
        averageValue: "15"   # scale UP before connections get critical
```

**3. Added Grafana dashboard panel: "DB Connections per Pod"**
- Shows connections broken down by pod name
- Red threshold line at 80% of RDS max_connections
- Visible on the main PMS operations dashboard

**4. Added circuit breaker in booking-service**
```javascript
// If DB connection fails 3 times in 10s, open circuit — return 503 immediately
// instead of letting requests pile up and exhaust the pool further
const circuitBreaker = new CircuitBreaker(pool.query, {
  timeout: 3000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000
});
```

**5. Runbook created:** `docs/runbooks/db-connection-exhaustion.md`
- Step-by-step: how to identify, scale down pods, emergency RDS resize
- Added to on-call handoff docs

---

## INCIDENT-002 — Kafka Consumer Lag Caused Guests to Not Receive Confirmation Emails

**Severity:** P2 — Customer Experience  
**Duration:** 3 hours 20 minutes (silent failure — no alert fired)  
**Services Affected:** notification-service  

### What Happened

notification-service had a memory leak in the email rendering template engine.
After ~6 hours of uptime, pod memory hit the 512Mi limit. Kubernetes OOMKilled the pod
and restarted it. During restart (avg 45 seconds), Kafka consumer group was inactive.
Kafka kept accumulating messages. After restart, the pod was processing messages from
3 hours ago — guests were getting confirmation emails hours after booking, or for
bookings that had already been cancelled.

### How It Was Detected

**This is the worst part: we didn't detect it. A hotel GM called our support line.**

Customer complained: "I booked 3 hours ago, never got a confirmation, called the hotel,
they said the booking exists in the system, but no email."

Post-investigation found notification-service had been OOMKilled 4 times that day.
Consumer lag had reached 14,000 messages at peak.

### Root Cause

1. No alert on Kafka consumer lag (we had the rule in YAML but hadn't deployed it)
2. No alert on pod OOMKill events
3. Memory leak in `nodemailer` template compilation — templates were compiled on every
   message instead of being compiled once and cached
4. Single replica for notification-service — no redundancy

### Postmortem Actions Taken

**1. Fixed the memory leak — cache compiled templates**
```javascript
// BEFORE (leaked memory — recompiled on every message)
async function sendEmail(template, data) {
  const compiled = handlebars.compile(fs.readFileSync(template, 'utf8'));
  return compiled(data);
}

// AFTER (compiled once, cached in module scope)
const templateCache = new Map();
async function sendEmail(templateName, data) {
  if (!templateCache.has(templateName)) {
    templateCache.set(templateName,
      handlebars.compile(fs.readFileSync(`templates/${templateName}.hbs`, 'utf8'))
    );
  }
  return templateCache.get(templateName)(data);
}
```

**2. Scaled notification-service to 3 replicas + increased Kafka partitions to 3**
```yaml
# Now 3 consumers in the group, one per partition
# If one pod dies, the other 2 pick up its partitions within 30s (session.timeout.ms)
spec:
  replicas: 3
```

**3. Deployed the Kafka consumer lag alert (it was written but not applied)**
```bash
kubectl apply -f k8s/monitoring/prometheus/prometheus-rules.yaml
# Alert: KafkaConsumerLagHigh — fires when lag > 1000 messages
```

**4. Added OOMKill alert to Prometheus rules**
```yaml
- alert: PodOOMKilled
  expr: |
    kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} == 1
  for: 0m   # alert immediately — OOMKill is never acceptable silently
  labels:
    severity: warning
  annotations:
    summary: "Pod {{ $labels.pod }} was OOMKilled in namespace {{ $labels.namespace }}"
    description: "Increase memory limit or fix the memory leak. Check: kubectl top pods"
```

**5. Added consumer lag panel to Grafana PMS dashboard**
- Real-time lag per consumer group, per topic
- SLO target: lag must return to 0 within 5 minutes of any spike

**6. Added message timestamp check — skip stale messages**
```javascript
// If message is older than 30 minutes, log and skip (don't send late emails)
const messageAge = Date.now() - new Date(event.timestamp).getTime();
if (messageAge > 30 * 60 * 1000) {
  logger.warn({ bookingId: event.bookingId, ageMinutes: messageAge/60000 },
    'Skipping stale notification — message too old');
  return;
}
```

**7. Added Dead Letter Queue processing job**
- Scheduled Lambda runs every 6 hours
- Reads from `booking-events-dlq`, generates report
- Alerts ops team if DLQ depth > 10

---

## INCIDENT-003 — Rolling Deploy Caused 90 Seconds of 502s

**Severity:** P2  
**Duration:** 90 seconds  
**Services Affected:** booking-service (during deploy)  

### What Happened

Jenkins deployed a new version of booking-service. The rolling update terminated old pods
before new pods were truly ready. The new pods took 25 seconds to establish DB and Kafka
connections on startup. During those 25 seconds, the readiness probe passed (it only
checked `/health/live`, not `/health/ready`) so the ALB sent traffic to pods that couldn't
actually serve requests. Requests failed with 502.

### Root Cause

Two bugs compounded:
1. `readinessProbe` was pointing to `/health/live` (wrong endpoint — just returns "alive")
   instead of `/health/ready` (checks DB connection)
2. No `preStop` hook — pods were killed immediately on SIGTERM while requests were in-flight

### Postmortem Actions Taken

**1. Fixed readiness probe to use the correct endpoint**
```yaml
# BEFORE (wrong — just checks if process is alive)
readinessProbe:
  httpGet:
    path: /health/live   # BUG
    port: 3001

# AFTER (correct — checks DB is connected before accepting traffic)
readinessProbe:
  httpGet:
    path: /health/ready  # checks pg.query('SELECT 1')
    port: 3001
  initialDelaySeconds: 10
  periodSeconds: 5
  failureThreshold: 3
```

**2. Added preStop hook — drains in-flight requests before pod exits**
```yaml
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 15"]
# K8s calls preStop, waits 15s (in-flight requests complete),
# THEN sends SIGTERM. terminationGracePeriodSeconds: 30 gives 30s total.
```

**3. Added startup probe — prevents readiness probe running too early**
```yaml
startupProbe:
  httpGet:
    path: /health/ready
    port: 3001
  failureThreshold: 30   # 30 × 10s = 5 minutes max startup time
  periodSeconds: 10
# readinessProbe doesn't run until startupProbe succeeds
```

**4. Added deploy verification step to Jenkins pipeline**
```groovy
stage('Verify Deploy') {
  steps {
    sh '''
      # Wait for rollout AND verify error rate didn't spike
      kubectl rollout status deployment/booking-service -n booking --timeout=5m

      # Check error rate for 60s after deploy
      sleep 60
      ERROR_RATE=$(curl -s http://prometheus:9090/api/v1/query \
        --data-urlencode 'query=sum(rate(http_requests_total{service="booking-service",code=~"5.."}[1m]))/sum(rate(http_requests_total{service="booking-service"}[1m]))*100' \
        | jq '.data.result[0].value[1]' -r)

      if (( $(echo "$ERROR_RATE > 1.0" | bc -l) )); then
        echo "Error rate ${ERROR_RATE}% after deploy — rolling back"
        kubectl rollout undo deployment/booking-service -n booking
        exit 1
      fi
      echo "Deploy verified — error rate: ${ERROR_RATE}%"
    '''
  }
}
```

**5. Implemented canary deploy strategy for high-risk changes**
```yaml
# For major changes: deploy to 1 pod first, monitor 10 mins, then roll rest
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0
# Combined with Argo Rollouts for true canary (10% → 30% → 100% traffic split)
```

---

## INCIDENT-004 — Hotel Deactivation Did Not Cancel OTA Bookings (Data Inconsistency)

**Severity:** P1 — Data Integrity / Legal Risk  
**Duration:** 6 hours (until discovered in morning audit)  
**Services Affected:** booking-service Kafka consumer  

### What Happened

A hotel sent a deactivation request at 11:45 PM. hotel-service published `HOTEL_DEACTIVATED`
to Kafka. The booking-service consumer should have auto-cancelled all future bookings.
But booking-service had been restarted for a deploy at 11:42 PM — it came back up with
`fromBeginning: false` (only reads new messages). The deploy took 4 minutes. The
`HOTEL_DEACTIVATED` message was published during that gap and was missed.

18 guests arrived the next morning to find the hotel closed. Expedia filed a complaint.

### Root Cause

- Kafka consumer set to `fromBeginning: false` — misses messages published during downtime
- No idempotency check — even if the message was re-processed, there was no safe way to replay
- No reconciliation job to verify hotel status vs booking status

### Postmortem Actions Taken

**1. Changed consumer to use explicit offset management**
```javascript
// BEFORE: auto-commit, fromBeginning: false — messages missed during downtime
await consumer.subscribe({ topics: ['hotel-events'], fromBeginning: false });

// AFTER: manual commit, track last processed offset in DB
// On startup, read last committed offset and resume from there
await consumer.subscribe({ topics: ['hotel-events'], fromBeginning: false });
await consumer.run({
  autoCommit: false,   // we control when offset advances
  eachMessage: async ({ topic, partition, message }) => {
    await processMessage(message);
    // Only advance offset after successful processing
    await consumer.commitOffsets([{
      topic, partition,
      offset: (BigInt(message.offset) + 1n).toString()
    }]);
  }
});
```

**2. Built nightly reconciliation job**
```javascript
// Runs at 1 AM — cross-checks hotel status vs booking status
// Any active booking for an inactive hotel → auto-cancel + alert ops
async function reconcileHotelBookings() {
  const { rows } = await pool.query(`
    SELECT b.id, b.hotel_id, b.guest_email, b.check_in
    FROM bookings b
    JOIN hotels h ON b.hotel_id = h.id
    WHERE h.status = 'inactive'
      AND b.status IN ('confirmed', 'checked_in')
      AND b.check_in >= NOW()
  `);

  for (const booking of rows) {
    await cancelBooking(booking.id, 'hotel_deactivated');
    await notifyGuest(booking.guest_email, 'hotel_closure');
    logger.error({ bookingId: booking.id }, 'RECONCILIATION: cancelled booking for inactive hotel');
  }

  if (rows.length > 0) {
    await alertOpsTeam(`Reconciliation found ${rows.length} orphaned bookings`);
  }
}
```

**3. Added Kafka consumer health to readiness probe**
```javascript
// /health/ready now fails if Kafka consumer is not connected
router.get('/ready', async (req, res) => {
  const dbOk = await checkDB();
  const kafkaOk = consumer.isConnected();   // new check
  if (!dbOk || !kafkaOk) {
    return res.status(503).json({ db: dbOk, kafka: kafkaOk });
  }
  res.json({ status: 'ready' });
});
// Pod won't receive traffic until Kafka consumer is reconnected after restart
```

**4. Added Grafana alert: "Hotel Deactivated But Active Bookings Exist"**
```yaml
- alert: OrphanedBookingsAfterHotelDeactivation
  expr: |
    orphaned_bookings_total > 0
  for: 5m
  labels:
    severity: critical
  annotations:
    summary: "Active bookings exist for deactivated hotels"
```

---

## INCIDENT-005 — Trivy False Positive Blocked a Critical Security Patch Deploy

**Severity:** P3 — Process  
**Duration:** 2 hours (delay deploying a CVE fix)  

### What Happened

A critical CVE was discovered in `express` (CVE-2024-XXXX). We patched it and pushed.
Jenkins pipeline failed at Trivy stage — not because of the new CVE, but because of an
unrelated LOW severity CVE in an Alpine base image that had no fix available yet.
Our Trivy config was set to fail on LOW+. The critical patch couldn't ship.

### Postmortem Actions Taken

**1. Tiered Trivy policy — block only CRITICAL, warn on HIGH, report LOW**
```groovy
stage('Trivy Security Scan') {
  steps {
    // CRITICAL: fail the build (block deploy)
    sh '''
      trivy image --exit-code 1 --severity CRITICAL \
        --ignore-unfixed ${IMAGE_NAME}:${IMAGE_TAG}
    '''
    // HIGH: report but don't block (tracked in security backlog)
    sh '''
      trivy image --exit-code 0 --severity HIGH \
        --format json --output trivy-high.json \
        --ignore-unfixed ${IMAGE_NAME}:${IMAGE_TAG}
    '''
  }
}
```

**2. Created `.trivyignore` for accepted low-risk CVEs with expiry dates**
```
# CVE-2024-XXXXX — Alpine libssl — no fix available, network not exposed
# Accepted by: security team — Review date: 2024-03-01
CVE-2024-XXXXX

# CVE-2024-YYYYY — dev dependency only, not in prod image
CVE-2024-YYYYY
```

**3. Added weekly Trivy report to security team Slack channel**
- Automated job scans all ECR images every Monday
- Posts summary: X CRITICAL, Y HIGH, Z LOW
- Links to Jira tickets for each unresolved CVE

**4. Added "security override" parameter for emergency deploys**
```groovy
parameters {
  booleanParam(name: 'SECURITY_OVERRIDE', defaultValue: false,
    description: 'Skip Trivy for emergency patches (requires manager approval in Jira)')
}
// Override is logged, audited, and triggers a Slack notification to security team
```

---

## INCIDENT-006 — SonarQube Quality Gate Blocked a Deploy Due to Test Coverage Drop

**Severity:** P3 — Process  
**Duration:** 4 hours (dev investigation)  

### What Happened

A developer added a new Kafka retry handler (100 lines of code) without writing tests.
Coverage dropped from 74% to 61%. Quality Gate failed. Deploy was blocked.
Developer didn't understand why the build failed — spent 2 hours investigating.

### Postmortem Actions Taken

**1. Added coverage diff report to PR description (automated)**
```groovy
// Jenkins posts coverage change to GitHub PR comment
sh '''
  PREV_COVERAGE=$(git stash && npm test -- --coverage | grep "All files" | awk '{print $10}')
  CURR_COVERAGE=$(npm test -- --coverage | grep "All files" | awk '{print $10}')
  gh pr comment $PR_NUMBER --body "Coverage: ${PREV_COVERAGE} → ${CURR_COVERAGE}"
'''
```

**2. Changed Quality Gate threshold: warn at 70%, fail at 60%**
- Gives developers a warning before it becomes a hard block
- Added coverage trend panel to developer Grafana dashboard

**3. Added pre-commit hook to check coverage locally**
```bash
# .git/hooks/pre-push
npm test -- --coverage --coverageThreshold='{"global":{"lines":65}}'
if [ $? -ne 0 ]; then
  echo "Coverage below 65% — please add tests before pushing"
  exit 1
fi
```

**4. Created test template for common patterns**
```javascript
// templates/kafka-handler.test.template.js
// Developers copy this when adding new Kafka handlers — tests pre-written for:
// - happy path
// - message parsing failure
// - DLQ routing on error
```

---

## How to Talk About These in Interviews

### "Tell me about a production incident you handled"

**STAR format using INCIDENT-001:**

> **Situation:** We were running a hotel booking platform on EKS. On Black Friday, Expedia
> ran a flash sale and we got an 8x traffic spike in under 3 minutes.
>
> **Task:** I was on-call. PagerDuty fired at 2:14 AM — DB connections exhausted, 34% error rate.
>
> **Action:** I opened Jaeger traces, immediately saw all requests failing at pg.connect().
> Calculated: 10 pods × 20 pool size = 200 connections, exactly at our RDS limit.
> Short-term: scaled pods down to 5 to free connections. Medium-term: coordinated with
> the DBA to resize the RDS instance to r5.large. Long-term: I deployed PgBouncer as a
> sidecar so all 10 pods share a fixed pool of 20 real connections.
>
> **Result:** Resolved in 47 minutes. I also added a custom HPA metric that scales on
> DB connection count, not just CPU — so now we scale before connections become critical.
> Wrote the runbook and it's been used twice since with zero escalation.

---

### "How did you improve reliability?"

> We had a silent failure where notification-service was getting OOMKilled and Kafka
> consumer lag was building up for hours before anyone noticed — guests weren't getting
> emails. I built three things: first, I fixed the memory leak in the template compiler.
> Second, I deployed the Kafka consumer lag alert that we had written but never applied —
> that one hurt. Third, I added an OOMKill alert to Prometheus so we're paged immediately
> when any pod is killed by the kernel. I also changed the architecture from 1 replica to
> 3 with 3 Kafka partitions, so if one consumer pod dies, the other two pick up its
> partition within 30 seconds. Since then we've had zero silent notification failures.

---

### "What was your biggest postmortem?"

> The hotel deactivation incident — 18 guests showed up to a closed hotel. That one was
> painful. The root cause was a race condition: we deployed booking-service, and in the
> 4 minutes it was restarting, a HOTEL_DEACTIVATED Kafka message was published and lost.
> Our consumer was set to fromBeginning: false, so it missed it completely.
> I made three changes: switched to manual offset commits so we never lose messages across
> restarts, built a nightly reconciliation job that cross-checks hotel status vs booking
> status in the database, and added the consumer connection state to the readiness probe
> so the pod won't receive traffic until Kafka is fully reconnected. The reconciliation
> job has caught 3 edge cases since — before they became customer-facing incidents.

---

### "How do you approach observability?"

> I think about observability in three layers. First, metrics — every service exposes
> Prometheus metrics and we have dashboards for the four golden signals: latency, traffic,
> errors, saturation. After INCIDENT-001 I added a fifth signal: DB connection pool usage,
> because saturation doesn't always show in CPU. Second, traces — we use Jaeger with
> OpenTelemetry auto-instrumentation, so every request has a trace ID that I can use to
> see exactly which DB query or Kafka publish caused a slow response. Third, logs —
> structured JSON so I can query them in CloudWatch Insights. The most important thing
> I learned is that alerts you write but don't deploy are the same as no alerts.
> INCIDENT-002 happened because a perfectly written alert rule was never kubectl applied.
> Now every alert rule deployment is a required step in the CI pipeline.
