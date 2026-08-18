// api/proxy.js
export default async function handler(req, res) {
  const { method, query, body } = req;
  const WEBAPP_URL = process.env.WEBAPP_URL;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

  if (!WEBAPP_URL) {
    return res.status(500).json({ success: false, error: 'Missing WEBAPP_URL environment variable' });
  }

  let data = (method === 'GET') ? { ...query } : { ...body };
  const action = data.action;

  // Xác thực mật khẩu admin
  if (action === 'verify') {
    const password = data.password || data.adminPassword;
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({ success: false, error: 'Admin password not configured' });
    }
    if (password === ADMIN_PASSWORD) {
      return res.status(200).json({ success: true });
    } else {
      return res.status(401).json({ success: false, error: 'Invalid password' });
    }
  }

  // Danh sách action cần admin (uploadFile không cần admin)
  const adminActions = [
    'delete', 'deleteAll', 'uploadBatchReply',
    'deleteBatchReply', 'setFormLock', 'markReceived',
    'reply', 'forwardReply', 'uploadReplyFile'
  ];

  if (adminActions.includes(action)) {
    const suppliedPassword = data.adminPassword || data.admin_password;
    if (!suppliedPassword || suppliedPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    delete data.adminPassword;
    delete data.admin_password;
  }

  let targetUrl = WEBAPP_URL;

  try {
    const fetchOptions = {
      method: method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (method === 'POST') {
      fetchOptions.body = JSON.stringify(data);
    } else if (method === 'GET') {
      const params = new URLSearchParams(data);
      targetUrl += '?' + params.toString();
    }

    const response = await fetch(targetUrl, fetchOptions);
    const responseData = await response.json();
    return res.status(response.status).json(responseData);
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}