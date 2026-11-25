const { createClerkBridge } = require('@clerk/electron');
const { storage } = require('@clerk/electron/storage');
const saved = require('./clerk.config.json');

// Only public configuration belongs in a distributed desktop application.
function configuration() {
  const publishableKey = process.env.KRU_CLERK_PUBLISHABLE_KEY || saved.publishableKey;
  if (!/^pk_(test|live)_[A-Za-z0-9=]+$/.test(publishableKey || ''))
    throw new Error('Configure a Clerk publishable key for Kru.');
  const frontendApiHost = Buffer.from(publishableKey.split('_')[2], 'base64')
    .toString('utf8')
    .replace(/\$$/, '');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(frontendApiHost))
    throw new Error('Invalid Clerk Frontend API host.');
  return { applicationId: saved.applicationId, publishableKey, frontendApiHost };
}

function contentSecurityPolicy() {
  const host = configuration().frontendApiHost;
  return [
    "default-src 'self'",
    `script-src 'self' https://${host} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    `connect-src 'self' https://${host} https://*.protect.clerk.com:* https://clerk-telemetry.com https://*.clerk-telemetry.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https://img.clerk.com",
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}

function createAccountBridge() {
  // Do not set userAgent: the SDK replaces app.userAgentFallback globally,
  // which also affects the separate native web browser and breaks site compatibility.
  return createClerkBridge({
    storage: storage({ unencryptedFallback: false }),
    renderer: { scheme: 'kru', host: 'app' },
    manageSingleInstanceLock: false,
  });
}

module.exports = { configuration, contentSecurityPolicy, createAccountBridge };
