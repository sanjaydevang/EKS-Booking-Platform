/**
 * OpenTelemetry Distributed Tracing Setup
 *
 * This initializes tracing BEFORE the app starts so every request
 * gets a trace ID. Traces flow to Jaeger (or any OTLP backend).
 *
 * In Kubernetes: each pod sends spans to the Jaeger collector Service.
 * You can view traces in the Jaeger UI to see exactly which service
 * a slow request hit and how long each DB query took.
 */
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');
const { ExpressInstrumentation } = require('@opentelemetry/instrumentation-express');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

const exporter = new JaegerExporter({
  endpoint: process.env.JAEGER_ENDPOINT || 'http://jaeger-collector:14268/api/traces'
});

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'booking-service',
    [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: process.env.NODE_ENV || 'development'
  }),
  traceExporter: exporter,
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation()
  ]
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown());
