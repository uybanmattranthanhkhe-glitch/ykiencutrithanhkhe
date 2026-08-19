// api/index.js
// Proxy giữa frontend và Google Apps Script Web App.
// Nhiệm vụ: (1) giấu WEBAPP_URL thật, (2) xác thực mật khẩu admin
// cho các action nhạy cảm, (3) chuyển tiếp request/response.

// Cho phép function chạy tới 30s thay vì mặc định 10s (Hobby plan),
// tránh bị Vercel cắt ngang khi Apps Script xử lý hơi lâu (ví dụ đang
// tạo file/thư mục trên Drive lần đầu trong tháng).
export const config = {
  maxDuration: 30,
};

const ADMIN_ACTIONS = new Set([
  'delete', 'deleteAll', 'uploadBatchReply',
  'deleteBatchReply', 'setFormLock', 'markReceived',
  'reply', 'forwardReply', 'uploadReplyFile',
]);

export default async function handler(req, res) {
  const { method, query, body } = req;
  const WEBAPP_URL = process.env.WEBAPP_URL;
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

  if (!WEBAPP_URL) {
    return res.status(500).json({ success: false, error: 'Missing WEBAPP_URL environment variable' });
  }

  let data = (method === 'GET') ? { ...query } : { ...(body || {}) };
  const action = data.action;

  // ---- Xác thực mật khẩu admin ----
  if (action === 'verify') {
    const password = data.password || data.adminPassword;
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({ success: false, error: 'Admin password not configured' });
    }
    if (password === ADMIN_PASSWORD) {
      return res.status(200).json({ success: true });
    }
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

  // ---- Chặn action admin nếu thiếu/sai mật khẩu ----
  if (ADMIN_ACTIONS.has(action)) {
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({ success: false, error: 'Admin password not configured' });
    }
    const suppliedPassword = data.adminPassword || data.admin_password;
    if (!suppliedPassword || suppliedPassword !== ADMIN_PASSWORD) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    delete data.adminPassword;
    delete data.admin_password;
  }

  let targetUrl = WEBAPP_URL;
  // Timeout thủ công để trả lỗi rõ ràng thay vì để Vercel cắt ngang im lặng.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const fetchOptions = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };

    if (method === 'POST') {
      fetchOptions.body = JSON.stringify(data);
    } else if (method === 'GET') {
      const params = new URLSearchParams(data);
      targetUrl += '?' + params.toString();
    }

    const response = await fetch(targetUrl, fetchOptions);
    const text = await response.text();

    let responseData;
    try {
      responseData = JSON.parse(text);
    } catch (parseErr) {
      // Apps Script đôi khi trả về HTML lỗi (ví dụ web app chưa deploy
      // đúng quyền truy cập) thay vì JSON — trả lỗi dễ hiểu thay vì crash.
      return res.status(502).json({
        success: false,
        error: 'Phan hoi khong hop le tu Apps Script (co the do quyen truy cap Web App chua dung).',
      });
    }

    return res.status(response.status).json(responseData);
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ success: false, error: 'Apps Script phan hoi qua cham, vui long thu lai.' });
    }
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    clearTimeout(timeoutId);
  }
}
