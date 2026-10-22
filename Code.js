/**
 * ============================================================================
 * SHOWROOM BRAND CRM — Google Apps Script Backend (Web App API)
 * ============================================================================
 * Версия: 1.0 (Zero-Data-Loss Architecture)
 * 
 * Назначение:
 * Полноценный REST API бэкенд для Telegram Mini App (Showroom CRM).
 * Обеспечивает защищенное хранение данных брендов, пользователей ACL и
 * журнала аудита в Google Таблице с автоматической инициализацией структуры.
 * ============================================================================
 */

// Секретный ключ для защиты API (должен совпадать с ключом в настройках CRM)
// При необходимости вы можете изменить его на свой пароль.
var API_SECRET_KEY = "SHOWROOM_CRM_SECRET_2026";

// Имена листов в Google Таблице
var SHEET_BRANDS = "Brands";
var SHEET_ACL = "ACL_Users";
var SHEET_LOGS = "Audit_Logs";

// Заголовки столбцов (в строгом соответствии с архитектурными требованиями)
var BRAND_HEADERS = [
  "id",
  "name",
  "category",
  "contactName",
  "tgUsername",
  "phone",
  "stage",
  "railFormat",
  "monthlyFee",
  "commission",
  "paymentDay",
  "paidMonth",
  "lastContact",
  "notes",
  "updatedAt"
];

var ACL_HEADERS = [
  "id",
  "username",
  "phone",
  "name",
  "role",
  "immutable",
  "addedAt"
];

var LOG_HEADERS = [
  "id",
  "timestamp",
  "actorName",
  "actorUsername",
  "actorRole",
  "category",
  "action"
];

/**
 * Инициализация и форматирование всех листов таблицы.
 * Запустите эту функцию один раз вручную в редакторе, либо она выполнится
 * автоматически при первом обращении к API.
 */
function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateSheet(ss, SHEET_BRANDS, BRAND_HEADERS, "#0f172a");
  getOrCreateSheet(ss, SHEET_ACL, ACL_HEADERS, "#312e81");
  getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS, "#1e293b");
  return "Листы успешно инициализированы и отформатированы!";
}

/**
 * Вспомогательная функция создания или получения листа с форматированием шапки
 */
function getOrCreateSheet(ss, name, headers, headerBg) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    var range = sheet.getRange(1, 1, 1, headers.length);
    range.setBackground(headerBg || "#0f172a");
    range.setFontColor("#ffffff");
    range.setFontWeight("bold");
    range.setHorizontalAlignment("center");
    range.setVerticalAlignment("middle");
    range.setFontSize(10);
    sheet.setRowHeight(1, 36);
    sheet.setFrozenRows(1);
    
    for (var i = 1; i <= headers.length; i++) {
      sheet.autoResizeColumn(i);
    }
  }
  return sheet;
}

/**
 * Вспомогательный хелпер для формирования JSON-ответа с поддержкой CORS
 */
function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Проверка валидности API ключа
 */
function checkAuth(apiKey) {
  if (!API_SECRET_KEY || API_SECRET_KEY.trim() === "") return true;
  return apiKey === API_SECRET_KEY;
}

/**
 * Чтение данных с листа в виде массива объектов
 */
function readSheetData(sheet, headers) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  
  var numCols = headers.length;
  var values = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  var result = [];
  
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var obj = {};
    var hasContent = false;
    
    for (var c = 0; c < numCols; c++) {
      var val = row[c];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, Session.getScriptTimeZone() || "GMT+3", "yyyy-MM-dd");
      }
      obj[headers[c]] = (val !== null && val !== undefined) ? val : "";
      if (val !== "" && val !== null && val !== undefined) {
        hasContent = true;
      }
    }
    
    if (hasContent && obj.id) {
      if (obj.monthlyFee !== undefined && obj.monthlyFee !== "") {
        obj.monthlyFee = Number(obj.monthlyFee) || 0;
      }
      if (obj.paymentDay !== undefined && obj.paymentDay !== "") {
        obj.paymentDay = Number(obj.paymentDay) || 10;
      }
      if (obj.immutable !== undefined) {
        obj.immutable = String(obj.immutable).toLowerCase() === "true" || obj.immutable === true;
      }
      result.push(obj);
    }
  }
  return result;
}

/**
 * Пакетная запись массива объектов на указанный лист с очисткой старых строк
 */
function batchWriteSheet(sheet, headers, items) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  }
  
  if (!items || items.length === 0) return 0;
  
  var rows = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var row = [];
    for (var c = 0; c < headers.length; c++) {
      var key = headers[c];
      var val = item[key];
      if (key === "updatedAt" && !val) {
        val = new Date().toISOString();
      }
      row.push(val !== undefined && val !== null ? val : "");
    }
    rows.push(row);
  }
  
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    sheet.getRange(2, 1, rows.length, headers.length).setVerticalAlignment("middle").setFontSize(9);
  }
  return rows.length;
}

/**
 * Обработчик GET-запросов (чтение всех данных или healthcheck)
 */
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var params = e && e.parameter ? e.parameter : {};
    var apiKey = params.apiKey || "";
    
    if (!checkAuth(apiKey)) {
      return createJsonResponse({ success: false, error: "Unauthorized: Неверный API_SECRET_KEY" });
    }
    
    var sheetBrands = getOrCreateSheet(ss, SHEET_BRANDS, BRAND_HEADERS, "#0f172a");
    var sheetAcl = getOrCreateSheet(ss, SHEET_ACL, ACL_HEADERS, "#312e81");
    var sheetLogs = getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS, "#1e293b");
    
    var brands = readSheetData(sheetBrands, BRAND_HEADERS);
    var aclUsers = readSheetData(sheetAcl, ACL_HEADERS);
    var auditLogs = readSheetData(sheetLogs, LOG_HEADERS);
    
    return createJsonResponse({
      success: true,
      timestamp: new Date().toISOString(),
      brands: brands,
      aclUsers: aclUsers,
      auditLogs: auditLogs
    });
  } catch (err) {
    return createJsonResponse({
      success: false,
      error: err.toString()
    });
  }
}

/**
 * Обработчик POST-запросов (миграция, синхронизация, аудит)
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // Ожидание лока до 15 секунд для предотвращения гонок данных
    lock.waitLock(15000);
    
    var raw = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    var payload;
    try {
      payload = JSON.parse(raw);
    } catch (parseErr) {
      return createJsonResponse({ success: false, error: "Невалидный JSON в теле запроса" });
    }
    
    var apiKey = payload.apiKey || (e && e.parameter ? e.parameter.apiKey : "");
    if (!checkAuth(apiKey)) {
      return createJsonResponse({ success: false, error: "Unauthorized: Неверный API_SECRET_KEY" });
    }
    
    var action = payload.action;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetBrands = getOrCreateSheet(ss, SHEET_BRANDS, BRAND_HEADERS, "#0f172a");
    var sheetAcl = getOrCreateSheet(ss, SHEET_ACL, ACL_HEADERS, "#312e81");
    var sheetLogs = getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS, "#1e293b");
    
    // МЕТОД 1: getAllData — отдает все 3 массива объектов за один запрос
    if (action === "getAllData") {
      var brands = readSheetData(sheetBrands, BRAND_HEADERS);
      var aclUsers = readSheetData(sheetAcl, ACL_HEADERS);
      var auditLogs = readSheetData(sheetLogs, LOG_HEADERS);
      return createJsonResponse({
        success: true,
        brands: brands,
        aclUsers: aclUsers,
        auditLogs: auditLogs
      });
    }
    
    // МЕТОД 2: initialMigration / saveAllData — пакетная вставка данных из localStorage
    if (action === "initialMigration" || action === "saveAllData") {
      var countBrands = 0;
      var countAcl = 0;
      var countLogs = 0;
      
      if (Array.isArray(payload.brands)) {
        countBrands = batchWriteSheet(sheetBrands, BRAND_HEADERS, payload.brands);
      }
      if (Array.isArray(payload.aclUsers)) {
        countAcl = batchWriteSheet(sheetAcl, ACL_HEADERS, payload.aclUsers);
      }
      if (Array.isArray(payload.auditLogs)) {
        countLogs = batchWriteSheet(sheetLogs, LOG_HEADERS, payload.auditLogs);
      }
      
      return createJsonResponse({
        success: true,
        action: action,
        message: "Данные успешно синхронизированы с Google Таблицей",
        counts: {
          brands: countBrands,
          aclUsers: countAcl,
          auditLogs: countLogs
        }
      });
    }
    
    // МЕТОД 3: syncBrands — создание, обновление, удаление или пакетное сохранение карточек
    if (action === "syncBrands") {
      if (Array.isArray(payload.brands)) {
        var bCount = batchWriteSheet(sheetBrands, BRAND_HEADERS, payload.brands);
        return createJsonResponse({ success: true, message: "Бренды обновлены пакетом", count: bCount });
      }
      
      var brand = payload.brand;
      var op = payload.operation || "update"; // 'create' | 'update' | 'delete'
      if (!brand || !brand.id) {
        return createJsonResponse({ success: false, error: "Требуется объект brand с полем id" });
      }
      
      var lastRow = sheetBrands.getLastRow();
      var foundRow = 0;
      if (lastRow > 1) {
        var idColumn = sheetBrands.getRange(2, 1, lastRow - 1, 1).getValues();
        for (var r = 0; r < idColumn.length; r++) {
          if (String(idColumn[r][0]) === String(brand.id)) {
            foundRow = r + 2;
            break;
          }
        }
      }
      
      if (op === "delete") {
        if (foundRow > 0) {
          sheetBrands.deleteRow(foundRow);
        }
        return createJsonResponse({ success: true, operation: "delete", id: brand.id });
      }
      
      var brandRow = [];
      for (var c = 0; c < BRAND_HEADERS.length; c++) {
        var k = BRAND_HEADERS[c];
        var v = brand[k];
        if (k === "updatedAt") {
          v = new Date().toISOString();
        }
        brandRow.push(v !== undefined && v !== null ? v : "");
      }
      
      if (foundRow > 0) {
        sheetBrands.getRange(foundRow, 1, 1, BRAND_HEADERS.length).setValues([brandRow]);
      } else {
        sheetBrands.appendRow(brandRow);
      }
      
      return createJsonResponse({ success: true, operation: op, id: brand.id });
    }
    
    // МЕТОД 4: syncUsers — добавление, свитч ролей, удаление пользователей
    if (action === "syncUsers") {
      if (Array.isArray(payload.aclUsers)) {
        var uCount = batchWriteSheet(sheetAcl, ACL_HEADERS, payload.aclUsers);
        return createJsonResponse({ success: true, message: "Пользователи обновлены пакетом", count: uCount });
      }
      
      var user = payload.user;
      var userOp = payload.operation || "update";
      if (!user || !user.id) {
        return createJsonResponse({ success: false, error: "Требуется объект user с полем id" });
      }
      
      var aclLastRow = sheetAcl.getLastRow();
      var targetRow = 0;
      if (aclLastRow > 1) {
        var ids = sheetAcl.getRange(2, 1, aclLastRow - 1, 1).getValues();
        for (var i = 0; i < ids.length; i++) {
          if (String(ids[i][0]) === String(user.id)) {
            targetRow = i + 2;
            break;
          }
        }
      }
      
      if (userOp === "delete") {
        if (targetRow > 0) {
          sheetAcl.deleteRow(targetRow);
        }
        return createJsonResponse({ success: true, operation: "delete", id: user.id });
      }
      
      var userRow = [];
      for (var uc = 0; uc < ACL_HEADERS.length; uc++) {
        var uk = ACL_HEADERS[uc];
        userRow.push(user[uk] !== undefined && user[uk] !== null ? user[uk] : "");
      }
      
      if (targetRow > 0) {
        sheetAcl.getRange(targetRow, 1, 1, ACL_HEADERS.length).setValues([userRow]);
      } else {
        sheetAcl.appendRow(userRow);
      }
      
      return createJsonResponse({ success: true, operation: userOp, id: user.id });
    }
    
    // МЕТОД 5: appendLog — добавление события в аудит
    if (action === "appendLog") {
      var log = payload.log;
      if (!log) {
        return createJsonResponse({ success: false, error: "Требуется объект log" });
      }
      var logRow = [];
      for (var lc = 0; lc < LOG_HEADERS.length; lc++) {
        var lk = LOG_HEADERS[lc];
        logRow.push(log[lk] !== undefined && log[lk] !== null ? log[lk] : "");
      }
      sheetLogs.appendRow(logRow);
      return createJsonResponse({ success: true, logId: log.id });
    }
    
    return createJsonResponse({ success: false, error: "Неизвестное действие (action): " + action });
  } catch (err) {
    return createJsonResponse({ success: false, error: err.toString() });
  } finally {
    lock.releaseLock();
  }
}
