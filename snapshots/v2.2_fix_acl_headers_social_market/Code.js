/**
 * ============================================================================
 * SHOWROOM BRAND CRM — Google Apps Script Backend (Web App API)
 * ============================================================================
 * Версия: 2.0 (Zero-Deadlock Cloud Auth, Auto-Linking & Access Audit)
 * 
 * Назначение:
 * Полноценный REST API бэкенд для Telegram Mini App (Showroom CRM).
 * Обеспечивает:
 * 1. Предварительную проверку доступа (checkAccess) для новых сотрудников,
 *    решающую проблему пустого localStorage.
 * 2. Авторизацию по Telegram ID, @username и подтвержденному номеру телефона.
 * 3. Автоматическую самолинковку числового tgUserId при первом совпадении.
 * 4. Детальное логирование попыток авторизации и отказов в листе Audit_Logs.
 * 5. Защищенное хранение брендов, пользователей ACL и журнала аудита.
 * ============================================================================
 */

// Секретный ключ для защиты API (должен совпадать с ключом в настройках CRM)
var API_SECRET_KEY = "SHOWROOM_CRM_SECRET_2026";

// Имена листов в Google Таблице
var SHEET_BRANDS = "Brands";
var SHEET_ACL = "ACL_Users";
var SHEET_LOGS = "Audit_Logs";

// Заголовки столбцов
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
  "addedAt",
  "tgUserId"
];

var LOG_HEADERS = [
  "id",
  "timestamp",
  "actorName",
  "actorUsername",
  "actorRole",
  "category",
  "action",
  "tgUserId"
];

/**
 * Инициализация и форматирование всех листов таблицы.
 * Запустите эту функцию один раз вручную в редакторе Google Таблицы,
 * либо она выполнится автоматически при первом запросе к API.
 */
function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateSheet(ss, SHEET_BRANDS, BRAND_HEADERS, "#0f172a");
  getOrCreateSheet(ss, SHEET_ACL, ACL_HEADERS, "#312e81");
  getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS, "#1e293b");
  return "Листы успешно инициализированы и отформатированы!";
}

/**
 * Автоматическая нормализация и устранение сдвигов колонок на листе ACL_Users.
 * Гарантирует правильный маппинг полей username, phone, name, addedAt и tgUserId.
 */
function normalizeAclUsersSheet(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) return;
  
  // Устанавливаем канонические заголовки в строке 1
  sheet.getRange(1, 1, 1, ACL_HEADERS.length).setValues([ACL_HEADERS]);
  
  if (lastRow > 1) {
    var numCols = Math.max(sheet.getLastColumn(), ACL_HEADERS.length);
    var range = sheet.getRange(2, 1, lastRow - 1, numCols);
    var values = range.getValues();
    var hasUpdates = false;
    
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      // Canonical:
      // r[0]: id
      // r[1]: username
      // r[2]: phone
      // r[3]: name
      // r[4]: role
      // r[5]: immutable
      // r[6]: addedAt
      // r[7]: tgUserId
      
      var uClean = cleanUsername(r[1]) || cleanUsername(r[3]);
      var pClean = cleanPhone(r[2]) || cleanPhone(r[1]);
      var idClean = cleanTgId(r[7]) || cleanTgId(r[6]);
      
      if (r[6] instanceof Date) {
        r[6] = Utilities.formatDate(r[6], Session.getScriptTimeZone() || "GMT+3", "yyyy-MM-dd HH:mm:ss");
        hasUpdates = true;
      }
      
      // Авто-привязка ID и восстановление порядка для social_market_ru (5587182742)
      if (uClean === "social_market_ru" || pClean === "79055663356" || idClean === "5587182742") {
        r[1] = "social_market_ru";
        r[2] = "+7 905 566 3356";
        r[3] = "SM Account";
        r[4] = "admin";
        r[5] = false;
        if (!r[6] || r[6] === "5587182742") r[6] = "2026-10-22 00:00:00";
        r[7] = "5587182742";
        hasUpdates = true;
      }
      // Восстановление порядка для tvoyaddoma
      else if (uClean === "tvoyaddoma" || pClean === "79266011608") {
        r[1] = "tvoyaddoma";
        r[2] = "+7 926 601 1608";
        r[3] = "Владелец Шоурума";
        r[4] = "owner";
        r[5] = true;
        if (!r[6]) r[6] = "Системный корневой доступ";
        hasUpdates = true;
      }
      // Восстановление порядка для suchka_hey
      else if (uClean === "suchka_hey") {
        r[1] = "suchka_hey";
        r[3] = "Менеджер Света";
        r[4] = "user";
        r[5] = false;
        if (!r[6]) r[6] = "2026-10-22 00:00:00";
        hasUpdates = true;
      }
    }
    
    if (hasUpdates) {
      range.setValues(values);
    }
  }
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
  } else {
    // Проверяем актуальность колонок: если в существующей таблице не хватает колонок (например, tgUserId), добавляем их
    var currentLastCol = sheet.getLastColumn();
    if (currentLastCol > 0 && currentLastCol < headers.length) {
      var existingHeaders = sheet.getRange(1, 1, 1, currentLastCol).getValues()[0];
      for (var h = currentLastCol; h < headers.length; h++) {
        var missingHeader = headers[h];
        if (existingHeaders.indexOf(missingHeader) === -1) {
          sheet.getRange(1, h + 1).setValue(missingHeader)
            .setBackground(headerBg || "#0f172a")
            .setFontColor("#ffffff")
            .setFontWeight("bold")
            .setHorizontalAlignment("center");
        }
      }
    }
  }
  
  if (name === SHEET_ACL) {
    normalizeAclUsersSheet(sheet);
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
 * Нормализаторы данных
 */
function cleanUsername(u) {
  if (!u) return "";
  return String(u).trim().replace(/^@/, "").replace(/^https?:\/\/(t\.me\/)?/i, "").toLowerCase();
}

function cleanPhone(p) {
  if (!p) return "";
  return String(p).replace(/[^\d]/g, "");
}

function cleanTgId(id) {
  if (!id) return "";
  return String(id).trim();
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
        val = Utilities.formatDate(val, Session.getScriptTimeZone() || "GMT+3", "yyyy-MM-dd HH:mm:ss");
      }
      obj[headers[c]] = (val !== null && val !== undefined) ? val : "";
      if (val !== "" && val !== null && val !== undefined) {
        hasContent = true;
      }
    }
    
    if (hasContent && (obj.id || obj.name || obj.username)) {
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
 * Запись события авторизации в лист Audit_Logs
 */
function logAuthEntry(sheetLogs, name, username, role, tgUserId, status, details) {
  try {
    var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+3", "dd.MM.yyyy, HH:mm:ss");
    var id = "auth-" + new Date().getTime() + "-" + Math.random().toString(36).slice(2, 6);
    var actionText = "";
    
    if (status === "УСПЕШНО") {
      actionText = "Успешный вход: " + (name || "Сотрудник") + " (@" + (username || "—") + ", ID: " + (tgUserId || "—") + ", роль: " + role + ")";
    } else if (status === "ЗАПРОС") {
      actionText = "📩 Запрос доступа в CRM: " + (name || "Пользователь") + " (@" + (username || "—") + ", ID: " + (tgUserId || "—") + ") — " + details;
    } else {
      actionText = "⚠️ Попытка несанкционированного входа: " + (name || "Пользователь") + " (@" + (username || "—") + ", ID: " + (tgUserId || "—") + ") — " + details;
    }
    
    sheetLogs.appendRow([
      id,
      timestamp,
      name || "Пользователь",
      username || "—",
      role || "none",
      "АВТОРИЗАЦИЯ",
      actionText,
      tgUserId || ""
    ]);
  } catch (err) {
    console.error("Ошибка добавления лога авторизации: " + err.toString());
  }
}

/**
 * Центральный метод проверки доступа (Pre-Auth)
 * Ищет совпадение по tgUserId, @username или номеру телефона.
 * При первом совпадении автоматически привязывает числовой tgUserId к строке в ACL_Users.
 */
function handleCheckUserAccess(ss, params) {
  var sheetAcl = getOrCreateSheet(ss, SHEET_ACL, ACL_HEADERS, "#312e81");
  var sheetLogs = getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS, "#1e293b");
  
  var tgUserId = cleanTgId(params.tgUserId);
  var username = cleanUsername(params.username);
  var phone = cleanPhone(params.phone);
  var name = String(params.name || "").trim() || "Сотрудник";
  
  // 1. Проверка Неоспоримого Владельца (tvoyaddoma / 79266011608)
  var isOwner = (username === "tvoyaddoma") || (phone === "79266011608");
  if (isOwner) {
    var ownerObj = {
      id: "acl-owner",
      name: "Владелец",
      username: "tvoyaddoma",
      phone: "+7 926 601 1608",
      role: "owner",
      immutable: true,
      tgUserId: tgUserId || ""
    };
    logAuthEntry(sheetLogs, name, "tvoyaddoma", "owner", tgUserId, "УСПЕШНО", "Вход Неоспоримого Владельца");
    return {
      success: true,
      authorized: true,
      role: "owner",
      user: ownerObj,
      aclUsers: readSheetData(sheetAcl, ACL_HEADERS)
    };
  }
  
  // 2. Поиск в таблице ACL_Users
  var lastRow = sheetAcl.getLastRow();
  var matchedUser = null;
  var matchedRowIndex = 0;
  
  if (lastRow > 1) {
    var numCols = Math.max(sheetAcl.getLastColumn(), ACL_HEADERS.length);
    var values = sheetAcl.getRange(2, 1, lastRow - 1, numCols).getValues();
    for (var i = 0; i < values.length; i++) {
      var row = values[i];
      var u = {};
      for (var c = 0; c < ACL_HEADERS.length; c++) {
        var cellVal = row[c] !== null && row[c] !== undefined ? row[c] : "";
        if (cellVal instanceof Date) {
          cellVal = Utilities.formatDate(cellVal, Session.getScriptTimeZone() || "GMT+3", "yyyy-MM-dd HH:mm:ss");
        }
        u[ACL_HEADERS[c]] = String(cellVal).trim();
      }
      
      var rowTgId = cleanTgId(u.tgUserId) || cleanTgId(row[7]) || cleanTgId(row[6]);
      var rowUsernames = [
        cleanUsername(u.username),
        cleanUsername(u.name),
        cleanUsername(row[1]),
        cleanUsername(row[3])
      ].filter(Boolean);
      
      var rowPhones = [
        cleanPhone(u.phone),
        cleanPhone(u.username),
        cleanPhone(row[2]),
        cleanPhone(row[1])
      ].filter(Boolean);
      
      // Сверка по трем параметрам (приоритет: tgUserId, затем username, затем phone)
      var matchId = tgUserId && (rowTgId === tgUserId);
      var matchUser = username && rowUsernames.indexOf(username) !== -1;
      var matchPhone = phone && rowPhones.indexOf(phone) !== -1;
      
      // Специальная поддержка аккаунта social_market_ru
      var isSocialMarketSpecial = (username === "social_market_ru" || phone === "79055663356" || tgUserId === "5587182742") &&
        (rowUsernames.indexOf("social_market_ru") !== -1 || rowPhones.indexOf("79055663356") !== -1 || String(row[0]).indexOf("1792680157746") !== -1);
      
      if (matchId || matchUser || matchPhone || isSocialMarketSpecial) {
        matchedUser = u;
        matchedRowIndex = i + 2; // Строка на листе (с учетом заголовка)
        break;
      }
    }
  }
  
  // Резервное восстановление для подтвержденного аккаунта social_market_ru (если строки не было)
  if (!matchedUser && (username === "social_market_ru" || phone === "79055663356" || tgUserId === "5587182742")) {
    matchedUser = {
      id: "acl-1792680157746",
      username: "social_market_ru",
      phone: "+7 905 566 3356",
      name: "SM Account",
      role: "admin",
      immutable: false,
      addedAt: "2026-10-22 00:00:00",
      tgUserId: "5587182742"
    };
    var smRow = [];
    for (var sc = 0; sc < ACL_HEADERS.length; sc++) {
      smRow.push(matchedUser[ACL_HEADERS[sc]]);
    }
    sheetAcl.appendRow(smRow);
    matchedRowIndex = sheetAcl.getLastRow();
  }
  
  // 3. Если пользователь найден в списке ACL
  if (matchedUser) {
    var hasRowUpdates = false;
    
    // Специальная гарантия целостности для social_market_ru
    if (username === "social_market_ru" || matchedUser.username === "social_market_ru" || phone === "79055663356" || tgUserId === "5587182742") {
      matchedUser.username = "social_market_ru";
      matchedUser.phone = "+7 905 566 3356";
      matchedUser.name = "SM Account";
      matchedUser.role = "admin";
      matchedUser.tgUserId = "5587182742";
      matchedUser.immutable = false;
      hasRowUpdates = true;
    } else {
      // Самолинковка tgUserId
      if (tgUserId && (!matchedUser.tgUserId || cleanTgId(matchedUser.tgUserId) === "")) {
        matchedUser.tgUserId = tgUserId;
        hasRowUpdates = true;
      }
      // Если передан телефон и в строке он отсутствовал
      if (phone && (!matchedUser.phone || cleanPhone(matchedUser.phone) === "")) {
        matchedUser.phone = params.phone || ("+" + phone);
        hasRowUpdates = true;
      }
      // Если передан username и в строке он отсутствовал
      if (username && (!matchedUser.username || cleanUsername(matchedUser.username) === "")) {
        matchedUser.username = username;
        hasRowUpdates = true;
      }
      // Если имя пользователя дефолтное или пустое
      if (name && name !== "Сотрудник" && (!matchedUser.name || matchedUser.name === matchedUser.username)) {
        matchedUser.name = name;
        hasRowUpdates = true;
      }
    }
    
    if (hasRowUpdates && matchedRowIndex > 0) {
      var updatedRowValues = [];
      for (var uc = 0; uc < ACL_HEADERS.length; uc++) {
        var key = ACL_HEADERS[uc];
        updatedRowValues.push(matchedUser[key] !== undefined && matchedUser[key] !== null ? matchedUser[key] : "");
      }
      sheetAcl.getRange(matchedRowIndex, 1, 1, ACL_HEADERS.length).setValues([updatedRowValues]);
    }
    
    logAuthEntry(sheetLogs, name || matchedUser.name, matchedUser.username || username, matchedUser.role, tgUserId, "УСПЕШНО", "Успешная авторизация в CRM");
    
    return {
      success: true,
      authorized: true,
      role: matchedUser.role,
      user: matchedUser,
      aclUsers: readSheetData(sheetAcl, ACL_HEADERS)
    };
  }
  
  // 4. Пользователь НЕ найден в списке ACL
  var details = "Пользователь отсутствует в списке разрешенных участников ACL";
  if (phone) details += " (проверен тел: +" + phone + ")";
  logAuthEntry(sheetLogs, name, username, "none", tgUserId, "ОТКАЗ", details);
  
  return {
    success: true,
    authorized: false,
    reason: "not_in_acl",
    tgUserId: tgUserId,
    username: username,
    message: "Доступ не подтвержден. Пользователь не внесен в список разрешенного доступа CRM."
  };
}

/**
 * Обработчик GET-запросов (чтение всех данных или healthcheck / checkAccess)
 */
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var params = e && e.parameter ? e.parameter : {};
    var apiKey = params.apiKey || "";
    
    if (!checkAuth(apiKey)) {
      return createJsonResponse({ success: false, error: "Unauthorized: Неверный API_SECRET_KEY" });
    }
    
    var action = params.action;
    
    // Поддержка быстрой проверки доступа через GET (для моментального отклика)
    if (action === "checkAccess" || action === "checkUserAccess") {
      var authResult = handleCheckUserAccess(ss, params);
      return createJsonResponse(authResult);
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
 * Обработчик POST-запросов (миграция, синхронизация, авторизация, аудит)
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
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
    
    // МЕТОД 0: checkAccess / checkUserAccess — проверка прав и самолинковка tgUserId
    if (action === "checkAccess" || action === "checkUserAccess") {
      var authResult = handleCheckUserAccess(ss, payload);
      return createJsonResponse(authResult);
    }
    
    // МЕТОД 0.1: requestAccess — запрос доступа от неавторизованного сотрудника
    if (action === "requestAccess") {
      var reqName = payload.name || "Пользователь";
      var reqUser = payload.username || "—";
      var reqId = cleanTgId(payload.tgUserId);
      var reqPhone = payload.phone || "—";
      
      logAuthEntry(sheetLogs, reqName, reqUser, "none", reqId, "ЗАПРОС", "Запрос на добавление в CRM (тел: " + reqPhone + ")");
      return createJsonResponse({
        success: true,
        message: "Запрос доступа успешно зафиксирован в журнале аудита"
      });
    }
    
    // МЕТОД 1: getAllData — отдает все 3 массива объектов
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
    
    // МЕТОД 3: syncBrands — создание, обновление, удаление карточек
    if (action === "syncBrands") {
      if (Array.isArray(payload.brands)) {
        var bCount = batchWriteSheet(sheetBrands, BRAND_HEADERS, payload.brands);
        return createJsonResponse({ success: true, message: "Бренды обновлены пакетом", count: bCount });
      }
      
      var brand = payload.brand;
      var op = payload.operation || "update";
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
