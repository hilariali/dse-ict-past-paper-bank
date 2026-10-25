function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        body = {};
      }
    }
    body = body || {};

    const accessKey = String(body.accessKey || '').trim();
    const expectedTeacherKey = (process.env.TEACHER_ACCESS_KEY || 'DSE_TEACHER_2025').trim();
    const expectedAdminKey = (process.env.ADMIN_ACCESS_KEY || 'DSE_ADMIN_2025').trim();

    if (!accessKey) {
      return json(res, 400, { ok: false, valid: false, error: 'Teacher or Admin access key is required' });
    }

    if (expectedAdminKey && accessKey === expectedAdminKey) {
      return json(res, 200, { ok: true, valid: true, role: 'admin' });
    } else if (expectedTeacherKey && accessKey === expectedTeacherKey) {
      return json(res, 200, { ok: true, valid: true, role: 'teacher' });
    } else {
      return json(res, 200, { ok: true, valid: false, error: 'Invalid access key. Please verify with your school administrator.' });
    }
  } catch (err) {
    return json(res, 500, { ok: false, error: 'Server error: ' + (err.message || String(err)) });
  }
};
