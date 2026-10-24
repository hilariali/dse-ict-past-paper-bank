function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

function readFirebaseConfigFromEnv() {
  const cfg = {
    apiKey: (process.env.FIREBASE_API_KEY || '').trim(),
    authDomain: (process.env.FIREBASE_AUTH_DOMAIN || '').trim(),
    projectId: (process.env.FIREBASE_PROJECT_ID || '').trim(),
    storageBucket: (process.env.FIREBASE_STORAGE_BUCKET || '').trim(),
    messagingSenderId: (process.env.FIREBASE_MESSAGING_SENDER_ID || '').trim(),
    appId: (process.env.FIREBASE_APP_ID || '').trim(),
    measurementId: (process.env.FIREBASE_MEASUREMENT_ID || '').trim(),
  };
  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const missing = required.filter((k) => !cfg[k]);
  if (missing.length) return { ok: false, missing, config: null };
  if (!cfg.storageBucket) delete cfg.storageBucket;
  if (!cfg.messagingSenderId) delete cfg.messagingSenderId;
  if (!cfg.measurementId) delete cfg.measurementId;
  return { ok: true, missing: [], config: cfg };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }
  const result = readFirebaseConfigFromEnv();
  if (!result.ok) {
    return json(res, 503, {
      ok: false,
      error: 'Firebase config endpoint is not configured',
      missing: result.missing,
    });
  }
  return json(res, 200, { ok: true, config: result.config });
};
