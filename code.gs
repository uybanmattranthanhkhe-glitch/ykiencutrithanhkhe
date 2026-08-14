// ============================================================
//  code.gs — Google Apps Script Backend
//  Ý kiến cử tri phường Thanh Khê
// ============================================================

// ---------- CẤU HÌNH ----------
const ROOT_FOLDER_NAME = 'Y-kien-cu-tri-Thanh-Khe';
const SHEET_NAME       = 'GopY';

// ============================================================
//  CẤU HÌNH EMAIL ADMIN - SỬA EMAIL TẠI ĐÂY
// ============================================================
const ADMIN_EMAILS = [
  'uybanmattranthanhkhe@gmail.com',   // 👈 Email nhận thông báo ý kiến mới
];

// Link truy cập trang quản trị (dùng trong email thông báo)
const ADMIN_PANEL_URL = 'https://ykiencutrithanhkhe.vercel.app/admin.html';

// ============================================================
//  KHOÁ FORM NHẬP Ý KIẾN — ĐIỀU KHIỂN TỪ TRANG QUẢN TRỊ
//  Lưu trong Script Properties để admin bật/tắt và đặt thời điểm
//  "Tạm khoá từ" mà không cần sửa code. Muốn mở lại: tắt công tắc.
// ============================================================
const FORM_LOCK_ENABLED_KEY = 'FORM_LOCK_ENABLED';
const FORM_LOCK_FROM_KEY    = 'FORM_LOCK_FROM';
const FORM_LOCK_MESSAGE_KEY = 'FORM_LOCK_MESSAGE';
const DEFAULT_LOCK_MESSAGE  = 'Việc lấy ý kiến qua form điện tử đợt này xin tạm dừng!';

// ============================================================
//  doGet — Xử lý GET
// ============================================================
function doGet(e) {
  const p = e.parameter;
  try {
    if (p.action === 'get') {
      const data = getAllRecords();
      return jsonResponse({ success: true, data: data });
    }
    if (p.action === 'getOne' && p.id) {
      const row = getRecordById(p.id);
      return jsonResponse({ success: true, data: row });
    }
    if (p.action === 'getReplyStatus') {
      const status = getBatchReplyStatus();
      return jsonResponse(Object.assign({ success: true }, status));
    }
    if (p.action === 'getFormLockStatus') {
      const cfg = getFormLockConfig();
      return jsonResponse(Object.assign({ success: true }, cfg));
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
  return jsonResponse({ success: false, error: 'Unknown action' });
}

// ============================================================
//  doPost — Xử lý POST
// ============================================================
function doPost(e) {
  try {
    let body = {};
    if (e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }

    const action = body.action || (e.parameter && e.parameter.action);

    if (action === 'add') return handleAdd(body);
    if (action === 'delete') return handleDelete(body);
    if (action === 'deleteAll') return handleDeleteAll();
    if (action === 'uploadFile') return handleUploadFile(body);

    // ---- MỚI: văn bản trả lời chung (tổng hợp theo đợt) ----
    if (action === 'uploadBatchReply') return handleUploadBatchReply(body);
    if (action === 'deleteBatchReply') return handleDeleteBatchReply();

    // ---- MỚI: khoá/mở form nhập ý kiến (điều khiển từ trang quản trị) ----
    if (action === 'setFormLock') return handleSetFormLock(body);

    return jsonResponse({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ============================================================
//  TÌM HOẶC TẠO FILE TXT THEO THÁNG
// ============================================================
function getOrCreateMonthTxt(folder, month, year) {
  const fileName = `Y-kien_Thang-${month}_${year}.txt`;
  
  let files = folder.getFilesByName(fileName);
  
  if (files.hasNext()) {
    return files.next();
  } else {
    const file = folder.createFile(fileName, '', 'text/plain');
    const header = `=================================================\n`;
    const title = `  Y KIEN CU TRI PHUONG THANH KHE - THANG ${month}/${year}\n`;
    const line  = `=================================================\n\n`;
    file.setContent(header + title + line);
    return file;
  }
}

// ============================================================
//  THÊM GÓP Ý VÀO FILE TXT
// ============================================================
function appendToMonthTxt(folder, month, year, hoTen, diaChi, noiDung, timestamp, id) {
  try {
    const txtFile = getOrCreateMonthTxt(folder, month, year);
    let content = txtFile.getBlob().getDataAsString();
    
    const timeStr = new Date(timestamp).toLocaleString('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh'
    });
    
    let entry = `Gop y #${id} - ${hoTen}`;
    if (diaChi) entry += ` (${diaChi})`;
    entry += ` - ${timeStr}\n`;
    entry += `${noiDung || '(Khong co noi dung)'}\n\n`;
    
    content += entry;
    txtFile.setContent(content);
    
    return txtFile.getUrl();
  } catch (e) {
    Logger.log('Loi append txt: ' + e.message);
    return '';
  }
}

// ============================================================
//  CẬP NHẬT FILE TXT KHI CÓ FILE ĐÍNH KÈM
// ============================================================
function updateTxtWithAttachment(txtUrl, fileName, fileUrl) {
  try {
    if (!txtUrl) return;
    
    const match = txtUrl.match(/\/d\/([^/]+)/);
    if (!match) return;
    
    const txtFile = DriveApp.getFileById(match[1]);
    let content = txtFile.getBlob().getDataAsString();
    
    content += `File dinh kem: ${fileName}\n`;
    content += `Link: ${fileUrl}\n\n`;
    
    txtFile.setContent(content);
    Logger.log('Da them file link vao TXT: ' + fileName);
  } catch (e) {
    Logger.log('Khong the cap nhat TXT: ' + e.message);
  }
}

// ============================================================
//  GHI PHẢN HỒI / HÌNH THỨC XỬ LÝ VÀO FILE TXT THEO THÁNG
// ============================================================
function appendReplyToMonthTxt(txtUrl, id, phanHoi, loaiXuLy, replyFileUrls) {
  try {
    if (!txtUrl) return;
    const match = txtUrl.match(/\/d\/([^/]+)/);
    if (!match) return;

    const txtFile = DriveApp.getFileById(match[1]);
    let content = txtFile.getBlob().getDataAsString();

    const label = loaiXuLy === 'forward' ? 'DA CHUYEN CO QUAN CHUC NANG'
      : (loaiXuLy === 'forward_replied' ? 'CO QUAN CHUC NANG DA CO VAN BAN TRA LOI' : 'TRA LOI CU DAN');
    const timeStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

    content += `>> [${label}] cho Gop y #${id} - ${timeStr}\n${phanHoi || '(Khong co noi dung)'}\n`;
    
    // Thêm file đính kèm phản hồi nếu có
    if (replyFileUrls) {
      const urls = String(replyFileUrls).split('\n').filter(Boolean);
      urls.forEach(url => {
        content += `   - File phan hoi: ${url}\n`;
      });
    }
    content += '\n';

    txtFile.setContent(content);
  } catch (e) {
    Logger.log('Loi ghi phan hoi vao TXT: ' + e.message);
  }
}

// ============================================================
//  HÀM GỬI EMAIL CHO NHIỀU ADMIN (CÓ PRIORITY HIGH + HEADER CHỐNG SPAM)
// ============================================================
function sendEmailToAdmins(hoTen, diaChi, noiDung, txtUrl, timestamp, attachUrl = '') {
  if (!ADMIN_EMAILS || ADMIN_EMAILS.length === 0) {
    Logger.log('Chua cau hinh email admin');
    return;
  }

  const validEmails = ADMIN_EMAILS.filter(email => 
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );

  if (validEmails.length === 0) {
    Logger.log('Khong co email admin hop le');
    return;
  }

  const timeStr = new Date(timestamp).toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh'
  });
  
  const subject = `[YKCT] Y kien moi tu ${hoTen} - Phuong Thanh Khe`;
  
  const plainText = `
Y KIEN MOI TU CU TRI
===================

Ho ten: ${hoTen}
Dia chi / SDT: ${diaChi || 'Khong co'}
Thoi gian: ${timeStr}
Noi dung: ${noiDung || 'Khong co noi dung'}

Xem tat ca y kien trong thang: ${txtUrl}
${attachUrl ? `Te p dinh kem: ${attachUrl}` : ''}

-------------------
UBMTTQ Viet Nam - Phuong Thanh Khe
Dang nhap quan tri: ${ADMIN_PANEL_URL}
  `;
  
  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { font-family: Arial, Helvetica, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
    .header { background: #1E90FF; padding: 20px 24px; color: #ffffff; }
    .header h1 { margin: 0; font-size: 20px; font-weight: bold; }
    .header p { margin: 4px 0 0; opacity: 0.85; font-size: 14px; }
    .content { padding: 20px 24px; }
    .label { font-weight: bold; color: #0D47A1; width: 120px; display: inline-block; }
    .field { margin-bottom: 12px; }
    .value { color: #1A237E; }
    .noidung-box { background: #f0f7ff; padding: 12px 16px; border-radius: 8px; border-left: 4px solid #1E90FF; margin: 4px 0 12px; white-space: pre-wrap; word-wrap: break-word; }
    .btn { display: block; background: #1E90FF; color: #ffffff; padding: 12px 20px; border-radius: 8px; text-decoration: none; text-align: center; font-weight: bold; margin: 8px 0; }
    .btn-secondary { display: block; background: #f5f5f5; color: #333333; padding: 10px 20px; border-radius: 8px; text-decoration: none; text-align: center; font-weight: 500; border: 1px solid #e0e0e0; margin: 8px 0; }
    .note { background: #fff8e1; padding: 12px 16px; border-radius: 8px; border-left: 4px solid #FFB703; font-size: 13px; color: #5D4037; margin: 12px 0; }
    .footer { background: #f5f5f5; padding: 12px 24px; text-align: center; font-size: 12px; color: #999999; border-top: 1px solid #e0e0e0; }
    .footer p { margin: 2px 0; }
  </style>
</head>
<body style="margin: 0; padding: 20px; background: #f5f9ff; font-family: Arial, Helvetica, sans-serif;">

<div class="container">
  
  <div class="header">
    <h1>Y kien moi tu cu tri</h1>
    <p>UBMTTQ Viet Nam - Phuong Thanh Khe</p>
  </div>
  
  <div class="content">
    
    <div class="field">
      <span class="label">Ho ten:</span>
      <span class="value">${hoTen}</span>
    </div>
    
    <div class="field">
      <span class="label">Dia chi / SDT:</span>
      <span class="value">${diaChi || 'Khong co'}</span>
    </div>
    
    <div class="field">
      <span class="label">Thoi gian:</span>
      <span class="value">${timeStr}</span>
    </div>
    
    <div class="field">
      <span class="label">Noi dung:</span>
      <div class="noidung-box">${(noiDung || 'Khong co noi dung').replace(/\n/g, '<br>')}</div>
    </div>
    
    ${attachUrl ? `
    <div class="field">
      <span class="label">Te p dinh kem:</span>
      <div><a href="${attachUrl}" style="color: #1E90FF;">Xem te p</a></div>
    </div>
    ` : ''}
    
    <a href="${txtUrl}" target="_blank" class="btn">Xem tat ca y kien trong thang</a>
    
    <a href="${ADMIN_PANEL_URL}" class="btn-secondary">Dang nhap quan tri</a>
    
    <div class="note">
      <strong>Luu y:</strong> File TXT se duoc cap nhat tu dong khi co gop y moi trong thang.
    </div>
  </div>
  
  <div class="footer">
    <p>UBMTTQ Viet Nam - Phuong Thanh Khe</p>
    <p>Email nay duoc gui tu dong, vui long khong tra loi.</p>
  </div>
  
</div>

</body>
</html>
  `;
  
  try {
    validEmails.forEach(email => {
      GmailApp.sendEmail(
        email,
        subject,
        plainText,
        {
          htmlBody: htmlBody,
          name: 'UBMTTQ Phuong Thanh Khe',
          replyTo: ADMIN_EMAILS[0],
          noReply: false
        }
      );
    });
    Logger.log('Da gui email thong bao den ' + validEmails.length + ' admin');
  } catch (e) {
    Logger.log('Loi gui email: ' + e.message);
    return;
  }

  // ------------------------------------------------------------
  // GHI CHU: KHONG duoc tu dong "don" mail trong Sent bang cach
  // tim va moveToTrash() nhu truoc day.
  //
  // Ly do: neu ADMIN_EMAILS trung voi chinh tai khoan Google dang
  // chay Apps Script (gui email cho chinh minh), Gmail se KHONG tao
  // 2 ban ghi rieng cho Sent va Inbox. Ca 2 chi la MOT thread/message
  // duy nhat, mang dong thoi 2 nhan SENT + INBOX. Neu goi
  // thread.moveToTrash() de "don Sent", no se xoa luon ca ban trong
  // Inbox vi thuc chat chi co MOT message - day chinh la nguyen nhan
  // thu bien mat khoi hop thu den va roi vao Thung rac.
  //
  // Apps Script (GmailApp) khong co cach nao go rieng nhan he thong
  // SENT/INBOX ra khoi 1 message, nen giai phap dung la KHONG can
  // thiep vao Sent nua - de Gmail xu ly tu nhien.
  // ------------------------------------------------------------
}

// ============================================================
//  GỬI EMAIL THÔNG BÁO PHẢN HỒI CHO CỬ TRI
// ============================================================
function sendReplyEmailToCitizen(hoTen, diaChi, noiDungGoc, phanHoi, loaiXuLy, replyFileUrls, timestampGoc) {
  // KHÔNG gửi email vì không có email cử tri - chỉ lưu vào hệ thống
  // Nếu có email cử tri, có thể mở rộng sau
  Logger.log('Phan hoi da duoc luu cho y kien cua ' + hoTen);
}

// ============================================================
//  XỬ LÝ THÊM PHẢN ÁNH MỚI
// ============================================================
function handleAdd(body) {
  const lockCfg = getFormLockConfig();
  if (lockCfg.locked) {
    return jsonResponse({ success: false, error: lockCfg.message || DEFAULT_LOCK_MESSAGE, locked: true });
  }

  const { hoTen, diaChi, noiDung, timestamp } = body;
  if (!hoTen) {
    return jsonResponse({ success: false, error: 'Thieu thong tin bat buoc' });
  }

  const now    = new Date();
  const year   = now.getFullYear().toString();
  const month  = String(now.getMonth() + 1).padStart(2, '0');
  const id     = 'GY_' + now.getTime();
  const ts     = timestamp || now.toISOString();

  const folder = getOrCreateFolder(year, month);

  const txtUrl = appendToMonthTxt(folder, month, year, hoTen, diaChi, noiDung, ts, id);
  const folderUrl = folder.getUrl();

  const sheet = getOrCreateSheet();
  sheet.appendRow([
    id, ts, hoTen, diaChi || '', noiDung || '',
    'new',
    txtUrl,
    '',
    folderUrl,
    '', // phanHoi
    '', // loaiXuLy
    '', // thoiGianPhanHoi
    ''  // replyFileUrls (cột 13 - mới)
  ]);

  sendEmailToAdmins(hoTen, diaChi, noiDung, txtUrl, ts);

  return jsonResponse({ success: true, id: id, txtUrl: txtUrl });
}

// ============================================================
//  XỬ LÝ UPLOAD FILE
// ============================================================
function handleUploadFile(body) {
  const { id, fileName, mimeType, base64Data } = body;
  if (!id || !fileName || !base64Data) {
    return jsonResponse({ success: false, error: 'Thieu thong tin file' });
  }

  try {
    const sheet = getOrCreateSheet();
    const data = sheet.getDataRange().getValues();

    let recordIndex = -1;
    let txtUrl    = '';
    let folderUrl = '';

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        recordIndex = i;
        txtUrl    = data[i][6] || '';
        folderUrl = data[i][8] || '';
        break;
      }
    }

    if (recordIndex === -1) {
      return jsonResponse({ success: false, error: 'Khong tim thay ID gop y' });
    }

    let folder;
    if (folderUrl) {
      try {
        const folderId = folderUrl.match(/folders\/([^/?]+)/);
        if (folderId) folder = DriveApp.getFolderById(folderId[1]);
      } catch(e) {}
    }

    if (!folder) {
      const now = new Date();
      const year = now.getFullYear().toString();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      folder = getOrCreateFolder(year, month);
      sheet.getRange(recordIndex + 1, 9).setValue(folder.getUrl());
    }

    const bytes = Utilities.base64Decode(base64Data);
    const blob  = Utilities.newBlob(bytes, mimeType, fileName);
    const file  = folder.createFile(blob);
    const fileUrl = file.getUrl();

    const existingAttach = data[recordIndex][7] || '';
    const newAttachUrl = existingAttach ? existingAttach + '\n' + fileUrl : fileUrl;
    sheet.getRange(recordIndex + 1, 8).setValue(newAttachUrl);

    if (txtUrl) {
      updateTxtWithAttachment(txtUrl, fileName, fileUrl);
    }

    return jsonResponse({ success: true, fileUrl: fileUrl });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ============================================================
//  XỬ LÝ UPLOAD FILE PHẢN HỒI (MỚI)
// ============================================================
function handleUploadReplyFile(body) {
  const { id, fileName, mimeType, base64Data } = body;
  if (!id || !fileName || !base64Data) {
    return jsonResponse({ success: false, error: 'Thieu thong tin file' });
  }

  try {
    const sheet = getOrCreateSheet();
    const data = sheet.getDataRange().getValues();

    let recordIndex = -1;
    let folderUrl = '';

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(id)) {
        recordIndex = i;
        folderUrl = data[i][8] || '';
        break;
      }
    }

    if (recordIndex === -1) {
      return jsonResponse({ success: false, error: 'Khong tim thay ID gop y' });
    }

    let folder;
    if (folderUrl) {
      try {
        const folderId = folderUrl.match(/folders\/([^/?]+)/);
        if (folderId) folder = DriveApp.getFolderById(folderId[1]);
      } catch(e) {}
    }

    if (!folder) {
      const now = new Date();
      const year = now.getFullYear().toString();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      folder = getOrCreateFolder(year, month);
      sheet.getRange(recordIndex + 1, 9).setValue(folder.getUrl());
    }

    // Tạo thư mục con "Phan hoi" để lưu file phản hồi
    let replyFolder;
    try {
      replyFolder = folder.getFoldersByName('Phan hoi').next();
    } catch(e) {
      replyFolder = folder.createFolder('Phan hoi');
    }

    const bytes = Utilities.base64Decode(base64Data);
    const blob  = Utilities.newBlob(bytes, mimeType, fileName);
    const file  = replyFolder.createFile(blob);
    const fileUrl = file.getUrl();

    // Lưu URL vào cột 13 (replyFileUrls)
    const existingReplyFiles = data[recordIndex][12] || '';
    const newReplyFileUrl = existingReplyFiles ? existingReplyFiles + '\n' + fileUrl : fileUrl;
    sheet.getRange(recordIndex + 1, 13).setValue(newReplyFileUrl);

    return jsonResponse({ success: true, fileUrl: fileUrl });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ============================================================
//  VĂN BẢN TRẢ LỜI CHUNG (TỔNG HỢP THEO ĐỢT) — MỚI
//  Thay cho việc trả lời từng ý kiến: cuối đợt, admin tải lên
//  MỘT tệp văn bản (.docx hoặc .pdf) tổng hợp trả lời, mọi cử tri
//  sẽ thấy tệp này ở mục "Kết quả trả lời".
// ============================================================
const BATCH_REPLY_URL_KEY  = 'BATCH_REPLY_FILE_URL';
const BATCH_REPLY_NAME_KEY = 'BATCH_REPLY_FILE_NAME';
const BATCH_REPLY_TIME_KEY = 'BATCH_REPLY_UPLOADED_AT';

function getBatchReplyStatus() {
  const props = PropertiesService.getScriptProperties();
  const fileUrl    = props.getProperty(BATCH_REPLY_URL_KEY)  || '';
  const fileName   = props.getProperty(BATCH_REPLY_NAME_KEY) || '';
  const uploadedAt = props.getProperty(BATCH_REPLY_TIME_KEY) || '';
  return { hasReply: !!fileUrl, fileUrl: fileUrl, fileName: fileName, uploadedAt: uploadedAt };
}

function handleUploadBatchReply(body) {
  const { fileName, mimeType, base64Data } = body;
  if (!fileName || !base64Data) {
    return jsonResponse({ success: false, error: 'Thieu thong tin file' });
  }
  try {
    const root = getOrCreateChildFolder(null, ROOT_FOLDER_NAME);
    const replyFolder = getOrCreateChildFolder(root, 'Van-ban-tra-loi');

    const bytes = Utilities.base64Decode(base64Data);
    const blob  = Utilities.newBlob(bytes, mimeType, fileName);
    const file  = replyFolder.createFile(blob);

    // Cho phép cử tri xem tệp qua link
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}

    const fileUrl = file.getUrl();
    const now = new Date().toISOString();

    const props = PropertiesService.getScriptProperties();
    props.setProperty(BATCH_REPLY_URL_KEY, fileUrl);
    props.setProperty(BATCH_REPLY_NAME_KEY, fileName);
    props.setProperty(BATCH_REPLY_TIME_KEY, now);

    return jsonResponse({ success: true, fileUrl: fileUrl, fileName: fileName, uploadedAt: now });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function handleDeleteBatchReply() {
  try {
    const props = PropertiesService.getScriptProperties();
    const fileUrl = props.getProperty(BATCH_REPLY_URL_KEY);
    if (fileUrl) {
      try {
        const m = fileUrl.match(/\/d\/([^/]+)/);
        if (m) DriveApp.getFileById(m[1]).setTrashed(true);
      } catch (e) {}
    }
    props.deleteProperty(BATCH_REPLY_URL_KEY);
    props.deleteProperty(BATCH_REPLY_NAME_KEY);
    props.deleteProperty(BATCH_REPLY_TIME_KEY);
    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ============================================================
//  KHOÁ FORM NHẬP Ý KIẾN (ĐIỀU KHIỂN TỪ TRANG QUẢN TRỊ) — MỚI
// ============================================================
function getFormLockConfig() {
  const props   = PropertiesService.getScriptProperties();
  const enabled  = props.getProperty(FORM_LOCK_ENABLED_KEY) === 'true';
  const lockFrom = props.getProperty(FORM_LOCK_FROM_KEY) || '';
  const message  = props.getProperty(FORM_LOCK_MESSAGE_KEY) || DEFAULT_LOCK_MESSAGE;

  let locked = false;
  if (enabled) {
    if (!lockFrom) {
      locked = true; // Bật nhưng chưa đặt thời điểm -> khoá ngay
    } else {
      const lockTime = new Date(lockFrom).getTime();
      locked = !isNaN(lockTime) && Date.now() >= lockTime;
    }
  }
  return { enabled: enabled, lockFrom: lockFrom, message: message, locked: locked };
}

function handleSetFormLock(body) {
  try {
    const props = PropertiesService.getScriptProperties();
    const enabled  = !!body.enabled;
    const lockFrom = body.lockFrom || '';       // ISO string, có thể rỗng
    const message  = (body.message || '').toString().trim();

    props.setProperty(FORM_LOCK_ENABLED_KEY, enabled ? 'true' : 'false');
    props.setProperty(FORM_LOCK_FROM_KEY, lockFrom);
    props.setProperty(FORM_LOCK_MESSAGE_KEY, message || DEFAULT_LOCK_MESSAGE);

    return jsonResponse(Object.assign({ success: true }, getFormLockConfig()));
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ============================================================
//  [KHÔNG CÒN DÙNG] Đánh dấu đã nhận / trả lời từng ý kiến
//  Giữ lại các hàm bên dưới để tương thích dữ liệu cũ, không còn
//  được gọi từ giao diện quản trị (đã chuyển sang trả lời theo đợt).
// ============================================================
function handleMarkReceived(body) {
  const { id } = body;
  if (!id) return jsonResponse({ success: false, error: 'Thieu ID' });

  const sheet = getOrCreateSheet();
  const data  = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.getRange(i + 1, 6).setValue('received');
      return jsonResponse({ success: true });
    }
  }
  return jsonResponse({ success: false, error: 'Khong tim thay ID' });
}

// ============================================================
//  XỬ LÝ TRẢ LỜI / CHUYỂN CƠ QUAN CHỨC NĂNG
// ============================================================
function handleReply(body) {
  const { id, phanHoi, loaiXuLy, replyFileUrls } = body;
  if (!id) return jsonResponse({ success: false, error: 'Thieu ID' });

  const loai = (loaiXuLy === 'forward') ? 'forward' : 'reply';
  if (!phanHoi) {
    return jsonResponse({ success: false, error: 'Thieu noi dung phan hoi' });
  }

  const sheet = getOrCreateSheet();
  const data  = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      const now = new Date();

      sheet.getRange(i + 1, 6).setValue('received');           // Trang thai
      sheet.getRange(i + 1, 10).setValue(phanHoi);              // Phan hoi
      sheet.getRange(i + 1, 11).setValue(loai);                 // Loai xu ly
      sheet.getRange(i + 1, 12).setValue(now.toISOString());    // Thoi gian phan hoi
      
      if (replyFileUrls) {
        const existing = data[i][12] || '';
        const newUrls = existing ? existing + '\n' + replyFileUrls : replyFileUrls;
        sheet.getRange(i + 1, 13).setValue(newUrls);
      }

      const txtUrl = data[i][6];
      appendReplyToMonthTxt(txtUrl, id, phanHoi, loai, replyFileUrls);

      return jsonResponse({ success: true });
    }
  }
  return jsonResponse({ success: false, error: 'Khong tim thay ID' });
}

// ============================================================
//  XỬ LÝ PHẢN HỒI CHO "CHUYỂN CƠ QUAN CHỨC NĂNG" (MỚI)
// ============================================================
function handleForwardReply(body) {
  const { id, phanHoi, replyFileUrls } = body;
  if (!id) return jsonResponse({ success: false, error: 'Thieu ID' });
  if (!phanHoi) {
    return jsonResponse({ success: false, error: 'Thieu noi dung phan hoi' });
  }

  const sheet = getOrCreateSheet();
  const data  = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      const now = new Date();

      // Đánh dấu loaiXuLy = 'forward_replied': đã chuyển VÀ đã có văn bản trả lời từ cơ quan
      sheet.getRange(i + 1, 6).setValue('received');
      sheet.getRange(i + 1, 10).setValue(phanHoi);              // Phan hoi (noi dung van ban tra loi)
      sheet.getRange(i + 1, 11).setValue('forward_replied');    // Loai xu ly
      sheet.getRange(i + 1, 12).setValue(now.toISOString());    // Thoi gian phan hoi
      
      if (replyFileUrls) {
        const existing = data[i][12] || '';
        const newUrls = existing ? existing + '\n' + replyFileUrls : replyFileUrls;
        sheet.getRange(i + 1, 13).setValue(newUrls);
      }

      const txtUrl = data[i][6];
      // Ghi vào TXT với label "CO QUAN CHUC NANG DA CO VAN BAN TRA LOI"
      appendReplyToMonthTxt(txtUrl, id, phanHoi, 'forward_replied', replyFileUrls);

      return jsonResponse({ success: true });
    }
  }
  return jsonResponse({ success: false, error: 'Khong tim thay ID' });
}

// ============================================================
//  HELPER: Xoá (đưa vào Thùng rác) các tệp đính kèm trên Drive
// ============================================================
function deleteAttachmentFiles(attachUrl) {
  if (!attachUrl) return;
  const urls = String(attachUrl).split('\n').map(u => u.trim()).filter(Boolean);
  urls.forEach(u => {
    try {
      const m = u.match(/\/d\/([^/]+)/);
      if (m) {
        DriveApp.getFileById(m[1]).setTrashed(true);
      }
    } catch (e) {
      Logger.log('Khong the xoa file dinh kem: ' + u + ' - ' + e.message);
    }
  });
}

// ============================================================
//  HELPER: Gỡ đoạn ghi của 1 ý kiến khỏi file TXT theo tháng
// ============================================================
function removeEntryFromMonthTxt(txtUrl, id) {
  try {
    if (!txtUrl) return;
    const match = txtUrl.match(/\/d\/([^/]+)/);
    if (!match) return;

    const txtFile = DriveApp.getFileById(match[1]);
    const content = txtFile.getBlob().getDataAsString();

    const marker = /\n(?=Gop y #)/;
    const parts = content.split(marker);
    const idPattern = new RegExp('^Gop y #' + String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?!\\d)');

    const kept = parts.filter((part, idx) => {
      if (idx === 0) return true;
      return !idPattern.test(part);
    });

    txtFile.setContent(kept.join('\n'));
  } catch (e) {
    Logger.log('Loi xoa doan ghi trong TXT: ' + e.message);
  }
}

// ============================================================
//  XỬ LÝ XOÁ
// ============================================================
function handleDelete(body) {
  const { id } = body;
  if (!id) return jsonResponse({ success: false, error: 'Thieu ID' });

  const sheet = getOrCreateSheet();
  const data  = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      const txtUrl    = data[i][6] || '';
      const attachUrl = data[i][7] || '';
      const replyFiles = data[i][12] || ''; // File phản hồi

      deleteAttachmentFiles(attachUrl);
      deleteAttachmentFiles(replyFiles);
      removeEntryFromMonthTxt(txtUrl, id);

      sheet.deleteRow(i + 1);
      return jsonResponse({ success: true });
    }
  }
  return jsonResponse({ success: false, error: 'Khong tim thay ID' });
}

// ============================================================
//  XOÁ TOÀN BỘ
// ============================================================
function handleDeleteAll() {
  const sheet = getOrCreateSheet();
  const data  = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const txtUrl    = data[i][6] || '';
    const attachUrl = data[i][7] || '';
    const replyFiles = data[i][12] || '';
    deleteAttachmentFiles(attachUrl);
    deleteAttachmentFiles(replyFiles);
    removeEntryFromMonthTxt(txtUrl, data[i][0]);
  }

  const last = sheet.getLastRow();
  if (last > 1) {
    sheet.deleteRows(2, last - 1);
  }
  return jsonResponse({ success: true });
}

// ============================================================
//  LẤY TOÀN BỘ DỮ LIỆU
// ============================================================
function getAllRecords() {
  const sheet = getOrCreateSheet();
  const data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  const headers = ['id', 'timestamp', 'hoTen', 'diaChi', 'noiDung', 'status', 'txtUrl', 'attachUrl', 'folderUrl', 'phanHoi', 'loaiXuLy', 'thoiGianPhanHoi', 'replyFileUrls'];
  return data.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      let v = row[i];
      if (v === null || v === undefined) {
        v = '';
      } else if (h !== 'timestamp' && typeof v !== 'string') {
        v = String(v);
      }
      obj[h] = v;
    });
    return obj;
  }).filter(r => r.id);
}

// ============================================================
//  LẤY MỘT BẢN GHI
// ============================================================
function getRecordById(id) {
  const all = getAllRecords();
  return all.find(r => String(r.id) === String(id)) || null;
}

// ============================================================
//  HELPER: Lấy hoặc tạo 1 thư mục con (có khoá chống trùng)
// ============================================================
function getOrCreateChildFolder(parent, name) {
  const find = () => parent ? parent.getFoldersByName(name) : DriveApp.getFoldersByName(name);

  let iter = find();
  if (iter.hasNext()) return iter.next();

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    iter = find();
    if (iter.hasNext()) return iter.next();
    return parent ? parent.createFolder(name) : DriveApp.createFolder(name);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
//  HELPER: Lấy hoặc tạo thư mục
// ============================================================
function getOrCreateFolder(year, month) {
  const root = getOrCreateChildFolder(null, ROOT_FOLDER_NAME);
  const yearFolder = getOrCreateChildFolder(root, year);
  const monthName = 'Thang ' + month;
  const monthFolder = getOrCreateChildFolder(yearFolder, monthName);
  return monthFolder;
}

// ============================================================
//  HELPER: Lấy hoặc tạo Sheet
// ============================================================
function getOrCreateSheet() {
  const root = getOrCreateChildFolder(null, ROOT_FOLDER_NAME);

  let fileIter = root.getFilesByName(SHEET_NAME);
  let ss;

  if (fileIter.hasNext()) {
    ss = SpreadsheetApp.open(fileIter.next());
  } else {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      fileIter = root.getFilesByName(SHEET_NAME);
      if (fileIter.hasNext()) {
        ss = SpreadsheetApp.open(fileIter.next());
      } else {
        ss = SpreadsheetApp.create(SHEET_NAME);
        const file = DriveApp.getFileById(ss.getId());
        root.addFile(file);
        DriveApp.getRootFolder().removeFile(file);

        const sheet = ss.getActiveSheet();
        sheet.setName('GopY');
        sheet.appendRow([
          'ID', 'Thoi gian', 'Ho va ten', 'Dia chi / SDT',
          'Noi dung', 'Trang thai', 'Link TXT', 'Link dinh kem', 'Link thu muc',
          'Phan hoi', 'Loai xu ly', 'Thoi gian phan hoi', 'File phan hoi'
        ]);
        const hdr = sheet.getRange(1, 1, 1, 13);
        hdr.setFontWeight('bold').setBackground('#006D77').setFontColor('#FFFFFF');
        sheet.setFrozenRows(1);
        sheet.setColumnWidths(1, 13, 150);
        sheet.setColumnWidth(5, 300);
      }
    } finally {
      lock.releaseLock();
    }
  }

  const finalSheet = ss.getSheetByName('GopY') || ss.getActiveSheet();
  ensureReplyColumns(finalSheet);
  return finalSheet;
}

// ============================================================
//  MIGRATION: Đảm bảo các sheet cũ cũng có đủ cột
// ============================================================
function ensureReplyColumns(sheet) {
  const requiredHeaders = [
    'ID', 'Thoi gian', 'Ho va ten', 'Dia chi / SDT',
    'Noi dung', 'Trang thai', 'Link TXT', 'Link dinh kem', 'Link thu muc',
    'Phan hoi', 'Loai xu ly', 'Thoi gian phan hoi', 'File phan hoi'
  ];
  const lastCol = sheet.getLastColumn();
  if (lastCol < requiredHeaders.length) {
    const missing = requiredHeaders.slice(lastCol);
    const range = sheet.getRange(1, lastCol + 1, 1, missing.length);
    range.setValues([missing]);
    range.setFontWeight('bold').setBackground('#006D77').setFontColor('#FFFFFF');
    sheet.setColumnWidths(lastCol + 1, missing.length, 150);
  }
}

// ============================================================
//  SETUP
// ============================================================
function setup() {
  getOrCreateSheet();
  Logger.log('Sheet va thu muc da duoc khoi tao thanh cong!');
  
  if (ADMIN_EMAILS && ADMIN_EMAILS.length > 0) {
    Logger.log('Da cau hinh ' + ADMIN_EMAILS.length + ' email admin:');
    ADMIN_EMAILS.forEach(email => Logger.log('   - ' + email));
  } else {
    Logger.log('Chua cau hinh email admin!');
  }
}

// ============================================================
//  HELPER: Trả về JSON
// ============================================================
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}