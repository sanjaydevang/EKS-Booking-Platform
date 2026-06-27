const { NodeSDK } = require('@opentelemetry/sdk-node');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

const sdk = new NodeSDK({
  resource: new Resource({ [SemanticResourceAttributes.SERVICE_NAME]: 'notification-service' }),
  traceExporter: new JaegerExporter({ endpoint: process.env.JAEGER_ENDPOINT || 'http://jaeger:14268/api/traces' })
});
sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
