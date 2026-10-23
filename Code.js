/**
 * ============================================================================
 * SHOWROOM BRAND CRM — Google Apps Script Backend (Web App API)
 * ============================================================================
 * Версия: 3.0 (3-Tier Inventory, POS Operations, Live Polling & CommerceML v2.08)
 * 
 * Назначение:
 * Полноценный бэкенд торгового и складского учета для Showroom Brand CRM.
 * Обеспечивает:
 * 1. 3-уровневый складской учет:
 *    - Nomenclature: мастер-каталог артикулов, штрихкодов, категорий, цен.
 *    - Stock: актуальные остатки по местам (Рейл 1, Полка 2, Корнер, Склад).
 *    - Stock_Operations: журнал всех движений (Поставки, Продажи, Возвраты, Списания).
 * 2. Атомарное проведение кассовых операций (продажа/возврат с авто-пересчетом остатков).
 * 3. Приемка поставок из Excel/CSV с авто-добавлением в номенклатуру и склад.
 * 4. Фоновая синхронизация каждые 5 минут и расчет версионного хэша для live-поллера.
 * 5. Разграничение доступа: продавцы видят всё, бренды — только свой ассортимент и продажи.
 * 6. Генератор CommerceML v1 / v2.08 XML для автосинхронизации с Tilda, МойСклад и 1С.
 * ============================================================================
 */

// Секретный ключ для защиты API (должен совпадать с ключом в настройках CRM)
var API_SECRET_KEY = "SHOWROOM_CRM_SECRET_2026";

// Имена листов в Google Таблице
var SHEET_BRANDS = "Brands";
var SHEET_ACL = "ACL_Users";
var SHEET_LOGS = "Audit_Logs";
var SHEET_NOMENCLATURE = "Nomenclature";
var SHEET_STOCK = "Stock";
var SHEET_OPERATIONS = "Stock_Operations";

// Заголовки столбцов: Бренды и рейлы
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
  "updatedAt",
  "assignedPlaces",
  "currentStockCount",
  "maxStockCapacity",
  "lastDeliveryDate"
];

// Заголовки столбцов: Пользователи и доступ
var ACL_HEADERS = [
  "id",
  "username",
  "phone",
  "name",
  "role",
  "immutable",
  "addedAt",
  "tgUserId",
  "brandId"
];

// Заголовки столбцов: Журнал аудита доступа
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

// Заголовки столбцов: Каталог номенклатуры
var NOMENCLATURE_HEADERS = [
  "sku",
  "barcode",
  "brandId",
  "brandName",
  "name",
  "category",
  "color",
  "size",
  "price",
  "costPrice",
  "description",
  "photoUrl",
  "createdAt",
  "updatedAt"
];

// Заголовки столбцов: Текущие остатки на складе/шоуруме
var STOCK_HEADERS = [
  "sku",
  "barcode",
  "brandId",
  "place",
  "quantity",
  "reserved",
  "available",
  "updatedAt"
];

// Заголовки столбцов: Журнал движений и кассовых операций
var OPERATIONS_HEADERS = [
  "id",
  "timestamp",
  "type",
  "sku",
  "barcode",
  "brandId",
  "brandName",
  "quantity",
  "price",
  "totalAmount",
  "place",
  "authorName",
  "authorTgId",
  "receiptId",
  "notes"
];

/**
 * Инициализация и форматирование всех 6 листов таблицы.
 * Запустите эту функцию один раз вручную в редакторе Google Таблицы,
 * либо она выполнится автоматически при первом запросе к API.
 */
function initSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getOrCreateSheet(ss, SHEET_BRANDS, BRAND_HEADERS, "#0f172a");
  getOrCreateSheet(ss, SHEET_ACL, ACL_HEADERS, "#312e81");
  getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS, "#1e293b");
  getOrCreateSheet(ss, SHEET_NOMENCLATURE, NOMENCLATURE_HEADERS, "#1e3a8a");
  getOrCreateSheet(ss, SHEET_STOCK, STOCK_HEADERS, "#065f46");
  getOrCreateSheet(ss, SHEET_OPERATIONS, OPERATIONS_HEADERS, "#701a75");
  
  // Настраиваем триггер фоновой проверки каждые 5 минут
  setupInventorySyncTrigger();
  
  return "Все 6 листов успешно инициализированы и настроен фоновый триггер 5 мин!";
}

/**
 * Настройка фонового триггера (каждые 5 минут)
 */
function setupInventorySyncTrigger() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === "checkStockChangesAndNotify") {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
    ScriptApp.newTrigger("checkStockChangesAndNotify")
      .timeBased()
      .everyMinutes(5)
      .create();
  } catch (e) {
    // Игнорируем в контекстах без разрешения на ScriptApp
  }
}

/**
 * Фоновый опрос (раз в 5 минут):
 * Проверяет наличие изменений в таблице, обновляет системную версию
 * и синхронизирует суммарные остатки брендов в листе Brands.
 */
function checkStockChangesAndNotify() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheetStock = ss.getSheetByName(SHEET_STOCK);
    var sheetOps = ss.getSheetByName(SHEET_OPERATIONS);
    var sheetBrands = ss.getSheetByName(SHEET_BRANDS);
    
    if (!sheetStock || !sheetOps) return;
    
    var lastStockRow = sheetStock.getLastRow();
    var lastOpsRow = sheetOps.getLastRow();
    var lastOpTime = "";
    if (lastOpsRow > 1) {
      lastOpTime = String(sheetOps.getRange(lastOpsRow, 2).getValue());
    }
    
    var stateString = "s:" + lastStockRow + "|o:" + lastOpsRow + "|t:" + lastOpTime;
    var props = PropertiesService.getScriptProperties();
    var prevHash = props.getProperty("STOCK_STATE_HASH") || "";
    var newHash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, stateString));
    
    if (newHash !== prevHash) {
      props.setProperty("STOCK_STATE_HASH", newHash);
      props.setProperty("STOCK_STATE_UPDATED_AT", new Date().toISOString());
      
      // Авто-пересчет остатков по брендам
      if (sheetBrands && lastStockRow > 1) {
        var stockData = readSheetData(sheetStock, STOCK_HEADERS);
        var brandTotals = {};
        for (var i = 0; i < stockData.length; i++) {
          var bId = String(stockData[i].brandId || "").trim();
          var qty = Number(stockData[i].quantity) || 0;
          if (bId) {
            brandTotals[bId] = (brandTotals[bId] || 0) + qty;
          }
        }
        
        var brandsLastRow = sheetBrands.getLastRow();
        if (brandsLastRow > 1) {
          var brandIds = sheetBrands.getRange(2, 1, brandsLastRow - 1, 1).getValues();
          var stockColIdx = BRAND_HEADERS.indexOf("currentStockCount") + 1;
          if (stockColIdx > 0) {
            var stockCounts = [];
            for (var b = 0; b < brandIds.length; b++) {
              var currId = String(brandIds[b][0]).trim();
              stockCounts.push([brandTotals[currId] || 0]);
            }
            sheetBrands.getRange(2, stockColIdx, stockCounts.length, 1).setValues(stockCounts);
          }
        }
      }
    }
  } catch (err) {
    // Тихо игнорируем ошибку выполнения фонового триггера
  }
}

/**
 * Автоматическая нормализация и устранение сдвигов колонок на листе ACL_Users.
 */
function normalizeAclUsersSheet(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) return;
  
  sheet.getRange(1, 1, 1, ACL_HEADERS.length).setValues([ACL_HEADERS]);
  
  if (lastRow > 1) {
    var numCols = Math.max(sheet.getLastColumn(), ACL_HEADERS.length);
    var range = sheet.getRange(2, 1, lastRow - 1, numCols);
    var values = range.getValues();
    var hasUpdates = false;
    
    for (var i = 0; i < values.length; i++) {
      var r = values[i];
      var uClean = cleanUsername(r[1]) || cleanUsername(r[3]);
      var pClean = cleanPhone(r[2]) || cleanPhone(r[1]);
      var idClean = cleanTgId(r[7]) || cleanTgId(r[6]);
      
      if (r[6] instanceof Date) {
        r[6] = Utilities.formatDate(r[6], Session.getScriptTimeZone() || "GMT+3", "yyyy-MM-dd HH:mm:ss");
        hasUpdates = true;
      }
      
      // Авто-привязка ID для social_market_ru
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
        r[2] = "+7 903 543 6563";
        r[3] = "Анастасия";
        r[4] = "admin";
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
    // Добавляем недостающие колонки в существующий лист
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

function escapeXml(unsafe) {
  if (unsafe === null || unsafe === undefined) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
    
    if (hasContent && (obj.id || obj.name || obj.username || obj.sku)) {
      // Преобразование числовых полей
      if (obj.monthlyFee !== undefined && obj.monthlyFee !== "") obj.monthlyFee = Number(obj.monthlyFee) || 0;
      if (obj.paymentDay !== undefined && obj.paymentDay !== "") obj.paymentDay = Number(obj.paymentDay) || 1;
      if (obj.currentStockCount !== undefined && obj.currentStockCount !== "") obj.currentStockCount = Number(obj.currentStockCount) || 0;
      if (obj.maxStockCapacity !== undefined && obj.maxStockCapacity !== "") obj.maxStockCapacity = Number(obj.maxStockCapacity) || 0;
      if (obj.price !== undefined && obj.price !== "") obj.price = Number(obj.price) || 0;
      if (obj.costPrice !== undefined && obj.costPrice !== "") obj.costPrice = Number(obj.costPrice) || 0;
      if (obj.quantity !== undefined && obj.quantity !== "") obj.quantity = Number(obj.quantity) || 0;
      if (obj.reserved !== undefined && obj.reserved !== "") obj.reserved = Number(obj.reserved) || 0;
      if (obj.available !== undefined && obj.available !== "") obj.available = Number(obj.available) || 0;
      if (obj.totalAmount !== undefined && obj.totalAmount !== "") obj.totalAmount = Number(obj.totalAmount) || 0;
      
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
    // Игнорируем
  }
}

/**
 * Проверка прав доступа и авто-линковка сотрудника / бренда
 */
function handleCheckUserAccess(ss, params) {
  var sheetAcl = getOrCreateSheet(ss, SHEET_ACL, ACL_HEADERS, "#312e81");
  var sheetLogs = getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS, "#1e293b");
  
  var tgUserId = cleanTgId(params.tgUserId || params.id);
  var username = cleanUsername(params.username);
  var phone = cleanPhone(params.phone);
  var name = params.name || params.first_name || "";
  if (params.last_name) name += " " + params.last_name;
  name = name.trim();
  
  var lastRow = sheetAcl.getLastRow();
  var aclRows = [];
  if (lastRow > 1) {
    aclRows = sheetAcl.getRange(2, 1, lastRow - 1, ACL_HEADERS.length).getValues();
  }
  
  var matchedUser = null;
  var matchedRowIndex = 0;
  
  // 1. Поиск по числовому tgUserId
  if (tgUserId) {
    for (var i = 0; i < aclRows.length; i++) {
      var rowId = cleanTgId(aclRows[i][7]);
      if (rowId && rowId === tgUserId) {
        matchedUser = {};
        for (var c = 0; c < ACL_HEADERS.length; c++) {
          matchedUser[ACL_HEADERS[c]] = aclRows[i][c];
        }
        matchedRowIndex = i + 2;
        break;
      }
    }
  }
  
  // 2. Поиск по @username
  if (!matchedUser && username) {
    for (var j = 0; j < aclRows.length; j++) {
      var rowUser = cleanUsername(aclRows[j][1]);
      if (rowUser && rowUser === username) {
        matchedUser = {};
        for (var c2 = 0; c2 < ACL_HEADERS.length; c2++) {
          matchedUser[ACL_HEADERS[c2]] = aclRows[j][c2];
        }
        matchedRowIndex = j + 2;
        break;
      }
    }
  }
  
  // 3. Поиск по номеру телефона
  if (!matchedUser && phone) {
    for (var k = 0; k < aclRows.length; k++) {
      var rowPhone = cleanPhone(aclRows[k][2]);
      if (rowPhone && (rowPhone === phone || rowPhone.slice(-10) === phone.slice(-10))) {
        matchedUser = {};
        for (var c3 = 0; c3 < ACL_HEADERS.length; c3++) {
          matchedUser[ACL_HEADERS[c3]] = aclRows[k][c3];
        }
        matchedRowIndex = k + 2;
        break;
      }
    }
  }
  
  // Экстренная гарантия владельца @tvoyaddoma
  if (!matchedUser && (username === "tvoyaddoma" || phone === "79266011608")) {
    matchedUser = {
      id: "u-owner-root",
      username: "tvoyaddoma",
      phone: "+7 926 601 1608",
      name: "Владелец Шоурума",
      role: "owner",
      immutable: true,
      addedAt: "Системный корневой доступ",
      tgUserId: tgUserId || "",
      brandId: ""
    };
    var newRow = [];
    for (var oc = 0; oc < ACL_HEADERS.length; oc++) {
      newRow.push(matchedUser[ACL_HEADERS[oc]] || "");
    }
    sheetAcl.appendRow(newRow);
    matchedRowIndex = sheetAcl.getLastRow();
  }
  
  // Экстренная гарантия админа @social_market_ru
  if (!matchedUser && (username === "social_market_ru" || phone === "79055663356" || tgUserId === "5587182742")) {
    matchedUser = {
      id: "u-sm-admin",
      username: "social_market_ru",
      phone: "+7 905 566 3356",
      name: "SM Account",
      role: "admin",
      immutable: false,
      addedAt: "2026-10-22 00:00:00",
      tgUserId: "5587182742",
      brandId: ""
    };
    var smRow = [];
    for (var sc = 0; sc < ACL_HEADERS.length; sc++) {
      smRow.push(matchedUser[ACL_HEADERS[sc]] || "");
    }
    sheetAcl.appendRow(smRow);
    matchedRowIndex = sheetAcl.getLastRow();
  }
  
  // Пользователь авторизован
  if (matchedUser) {
    var hasRowUpdates = false;
    
    if (username === "social_market_ru" || matchedUser.username === "social_market_ru" || phone === "79055663356" || tgUserId === "5587182742") {
      matchedUser.username = "social_market_ru";
      matchedUser.phone = "+7 905 566 3356";
      matchedUser.name = "SM Account";
      matchedUser.role = "admin";
      matchedUser.tgUserId = "5587182742";
      matchedUser.immutable = false;
      hasRowUpdates = true;
    } else {
      if (tgUserId && (!matchedUser.tgUserId || cleanTgId(matchedUser.tgUserId) === "")) {
        matchedUser.tgUserId = tgUserId;
        hasRowUpdates = true;
      }
      if (phone && (!matchedUser.phone || cleanPhone(matchedUser.phone) === "")) {
        matchedUser.phone = params.phone || ("+" + phone);
        hasRowUpdates = true;
      }
      if (username && (!matchedUser.username || cleanUsername(matchedUser.username) === "")) {
        matchedUser.username = username;
        hasRowUpdates = true;
      }
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
    
    // Роль 'user' канонически отображается как 'seller' (продавец)
    var effectiveRole = matchedUser.role;
    if (effectiveRole === "user") effectiveRole = "seller";
    
    return {
      success: true,
      authorized: true,
      role: effectiveRole,
      brandId: matchedUser.brandId || "",
      user: matchedUser,
      aclUsers: readSheetData(sheetAcl, ACL_HEADERS)
    };
  }
  
  // Отказ доступа
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
 * Вспомогательный пересчет общего остатка бренда
 */
function updateBrandStockCount(sheetBrands, sheetStock, brandId, lastDeliveryDate) {
  try {
    var bLastRow = sheetBrands.getLastRow();
    if (bLastRow <= 1) return;
    
    var sLastRow = sheetStock.getLastRow();
    var totalQty = 0;
    if (sLastRow > 1) {
      var sData = sheetStock.getRange(2, 1, sLastRow - 1, STOCK_HEADERS.length).getValues();
      for (var i = 0; i < sData.length; i++) {
        if (String(sData[i][2]).trim() === String(brandId).trim()) {
          totalQty += (Number(sData[i][4]) || 0);
        }
      }
    }
    
    var bIds = sheetBrands.getRange(2, 1, bLastRow - 1, 1).getValues();
    var stockCol = BRAND_HEADERS.indexOf("currentStockCount") + 1;
    var delivCol = BRAND_HEADERS.indexOf("lastDeliveryDate") + 1;
    
    for (var b = 0; b < bIds.length; b++) {
      if (String(bIds[b][0]).trim() === String(brandId).trim()) {
        var rowIdx = b + 2;
        if (stockCol > 0) {
          sheetBrands.getRange(rowIdx, stockCol).setValue(totalQty);
        }
        if (delivCol > 0 && lastDeliveryDate) {
          sheetBrands.getRange(rowIdx, delivCol).setValue(lastDeliveryDate);
        }
        break;
      }
    }
  } catch (e) {
    // Тихо игнорируем
  }
}

/**
 * ============================================================================
 * COMMERCEML v2.08 XML GENERATORS (для Tilda, МойСклад, 1С)
 * ============================================================================
 */

function generateCommerceMLCatalog(nomenclature, stock) {
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+3", "yyyy-MM-dd'T'HH:mm:ss");
  
  var categories = {};
  for (var i = 0; i < nomenclature.length; i++) {
    var cat = nomenclature[i].category || "Одежда";
    categories[cat] = true;
  }
  
  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<КоммерческаяИнформация ВерсияСхемы="2.08" ДатаФормирования="' + now + '">\n';
  xml += '  <Классификатор>\n';
  xml += '    <Ид>SHOWROOM-CLASSIFIER</Ид>\n';
  xml += '    <Наименование>Классификатор товаров шоурума</Наименование>\n';
  xml += '    <Группы>\n';
  for (var catName in categories) {
    var catId = "cat_" + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, catName)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    xml += '      <Группа>\n';
    xml += '        <Ид>' + escapeXml(catId) + '</Ид>\n';
    xml += '        <Наименование>' + escapeXml(catName) + '</Наименование>\n';
    xml += '      </Группа>\n';
  }
  xml += '    </Группы>\n';
  xml += '  </Классификатор>\n';
  
  xml += '  <Каталог СодержитТолькоИзменения="false">\n';
  xml += '    <Ид>SHOWROOM-CATALOG</Ид>\n';
  xml += '    <ИдКлассификатора>SHOWROOM-CLASSIFIER</ИдКлассификатора>\n';
  xml += '    <Наименование>Каталог товаров шоурума</Наименование>\n';
  xml += '    <Товары>\n';
  
  for (var t = 0; t < nomenclature.length; t++) {
    var item = nomenclature[t];
    var sku = item.sku || ("ITEM-" + (t + 1));
    var name = item.name || sku;
    var catName = item.category || "Одежда";
    var catId = "cat_" + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, catName)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    
    xml += '      <Товар>\n';
    xml += '        <Ид>' + escapeXml(sku) + '</Ид>\n';
    xml += '        <Артикул>' + escapeXml(sku) + '</Артикул>\n';
    if (item.barcode) {
      xml += '        <Штрихкод>' + escapeXml(item.barcode) + '</Штрихкод>\n';
    }
    xml += '        <Наименование>' + escapeXml(name) + '</Наименование>\n';
    xml += '        <БазоваяЕдиница Код="796" НаименованиеПолное="Штука">шт</БазоваяЕдиница>\n';
    xml += '        <Группы>\n';
    xml += '          <Ид>' + escapeXml(catId) + '</Ид>\n';
    xml += '        </Группы>\n';
    if (item.description) {
      xml += '        <Описание>' + escapeXml(item.description) + '</Описание>\n';
    }
    if (item.photoUrl) {
      xml += '        <Картинка>' + escapeXml(item.photoUrl) + '</Картинка>\n';
    }
    xml += '        <ЗначенияСвойств>\n';
    if (item.brandName) {
      xml += '          <ЗначенияСвойства>\n';
      xml += '            <Наименование>Бренд</Наименование>\n';
      xml += '            <Значение>' + escapeXml(item.brandName) + '</Значение>\n';
      xml += '          </ЗначенияСвойства>\n';
    }
    if (item.color) {
      xml += '          <ЗначенияСвойства>\n';
      xml += '            <Наименование>Цвет</Наименование>\n';
      xml += '            <Значение>' + escapeXml(item.color) + '</Значение>\n';
      xml += '          </ЗначенияСвойства>\n';
    }
    if (item.size) {
      xml += '          <ЗначенияСвойства>\n';
      xml += '            <Наименование>Размер</Наименование>\n';
      xml += '            <Значение>' + escapeXml(item.size) + '</Значение>\n';
      xml += '          </ЗначенияСвойства>\n';
    }
    xml += '        </ЗначенияСвойств>\n';
    xml += '      </Товар>\n';
  }
  
  xml += '    </Товары>\n';
  xml += '  </Каталог>\n';
  xml += '</КоммерческаяИнформация>';
  return xml;
}

function generateCommerceMLOffers(nomenclature, stock) {
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+3", "yyyy-MM-dd'T'HH:mm:ss");
  
  var stockTotals = {};
  for (var s = 0; s < stock.length; s++) {
    var sSku = String(stock[s].sku || "").trim();
    var avail = Number(stock[s].available);
    if (isNaN(avail)) avail = Number(stock[s].quantity) || 0;
    if (sSku) {
      stockTotals[sSku] = (stockTotals[sSku] || 0) + avail;
    }
  }
  
  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<КоммерческаяИнформация ВерсияСхемы="2.08" ДатаФормирования="' + now + '">\n';
  xml += '  <ПакетПредложений СодержитТолькоИзменения="false">\n';
  xml += '    <Ид>SHOWROOM-OFFERS</Ид>\n';
  xml += '    <Наименование>Пакет предложений шоурума</Наименование>\n';
  xml += '    <ИдКаталога>SHOWROOM-CATALOG</ИдКаталога>\n';
  xml += '    <ИдКлассификатора>SHOWROOM-CLASSIFIER</ИдКлассификатора>\n';
  xml += '    <ТипыЦен>\n';
  xml += '      <ТипЦены>\n';
  xml += '        <Ид>BASE-PRICE</Ид>\n';
  xml += '        <Наименование>Розничная цена</Наименование>\n';
  xml += '        <Валюта>RUB</Валюта>\n';
  xml += '      </ТипЦены>\n';
  xml += '    </ТипыЦен>\n';
  xml += '    <Предложения>\n';
  
  for (var i = 0; i < nomenclature.length; i++) {
    var item = nomenclature[i];
    var sku = item.sku || ("ITEM-" + (i + 1));
    var name = item.name || sku;
    var price = Number(item.price) || 0;
    var qty = stockTotals[sku] !== undefined ? stockTotals[sku] : 0;
    
    xml += '      <Предложение>\n';
    xml += '        <Ид>' + escapeXml(sku) + '</Ид>\n';
    xml += '        <Артикул>' + escapeXml(sku) + '</Артикул>\n';
    if (item.barcode) {
      xml += '        <Штрихкод>' + escapeXml(item.barcode) + '</Штрихкод>\n';
    }
    xml += '        <Наименование>' + escapeXml(name) + '</Наименование>\n';
    xml += '        <БазоваяЕдиница Код="796" НаименованиеПолное="Штука">шт</БазоваяЕдиница>\n';
    xml += '        <Цены>\n';
    xml += '          <Цена>\n';
    xml += '            <Представление>' + price + ' руб.</Представление>\n';
    xml += '            <ИдТипаЦены>BASE-PRICE</ИдТипаЦены>\n';
    xml += '            <ЦенаЗаЕдиницу>' + price + '</ЦенаЗаЕдиницу>\n';
    xml += '            <Валюта>RUB</Валюта>\n';
    xml += '          </Цена>\n';
    xml += '        </Цены>\n';
    xml += '        <Количество>' + qty + '</Количество>\n';
    xml += '      </Предложение>\n';
  }
  
  xml += '    </Предложения>\n';
  xml += '  </ПакетПредложений>\n';
  xml += '</КоммерческаяИнформация>';
  return xml;
}

function generateCommerceMLAll(nomenclature, stock) {
  var now = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || "GMT+3", "yyyy-MM-dd'T'HH:mm:ss");
  
  var categories = {};
  for (var i = 0; i < nomenclature.length; i++) {
    var cat = nomenclature[i].category || "Одежда";
    categories[cat] = true;
  }
  
  var stockTotals = {};
  for (var s = 0; s < stock.length; s++) {
    var sSku = String(stock[s].sku || "").trim();
    var avail = Number(stock[s].available);
    if (isNaN(avail)) avail = Number(stock[s].quantity) || 0;
    if (sSku) {
      stockTotals[sSku] = (stockTotals[sSku] || 0) + avail;
    }
  }
  
  var xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<КоммерческаяИнформация ВерсияСхемы="2.08" ДатаФормирования="' + now + '">\n';
  xml += '  <Классификатор>\n';
  xml += '    <Ид>SHOWROOM-CLASSIFIER</Ид>\n';
  xml += '    <Наименование>Классификатор товаров шоурума</Наименование>\n';
  xml += '    <Группы>\n';
  for (var catName in categories) {
    var catId = "cat_" + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, catName)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    xml += '      <Группа>\n';
    xml += '        <Ид>' + escapeXml(catId) + '</Ид>\n';
    xml += '        <Наименование>' + escapeXml(catName) + '</Наименование>\n';
    xml += '      </Группа>\n';
  }
  xml += '    </Группы>\n';
  xml += '  </Классификатор>\n';
  
  xml += '  <Каталог СодержитТолькоИзменения="false">\n';
  xml += '    <Ид>SHOWROOM-CATALOG</Ид>\n';
  xml += '    <ИдКлассификатора>SHOWROOM-CLASSIFIER</ИдКлассификатора>\n';
  xml += '    <Наименование>Каталог товаров шоурума</Наименование>\n';
  xml += '    <Товары>\n';
  for (var t = 0; t < nomenclature.length; t++) {
    var item = nomenclature[t];
    var sku = item.sku || ("ITEM-" + (t + 1));
    var name = item.name || sku;
    var catName = item.category || "Одежда";
    var catId = "cat_" + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, catName)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
    
    xml += '      <Товар>\n';
    xml += '        <Ид>' + escapeXml(sku) + '</Ид>\n';
    xml += '        <Артикул>' + escapeXml(sku) + '</Артикул>\n';
    if (item.barcode) xml += '        <Штрихкод>' + escapeXml(item.barcode) + '</Штрихкод>\n';
    xml += '        <Наименование>' + escapeXml(name) + '</Наименование>\n';
    xml += '        <БазоваяЕдиница Код="796" НаименованиеПолное="Штука">шт</БазоваяЕдиница>\n';
    xml += '        <Группы><Ид>' + escapeXml(catId) + '</Ид></Группы>\n';
    if (item.description) xml += '        <Описание>' + escapeXml(item.description) + '</Описание>\n';
    if (item.photoUrl) xml += '        <Картинка>' + escapeXml(item.photoUrl) + '</Картинка>\n';
    xml += '        <ЗначенияСвойств>\n';
    if (item.brandName) xml += '          <ЗначенияСвойства><Наименование>Бренд</Наименование><Значение>' + escapeXml(item.brandName) + '</Значение></ЗначенияСвойства>\n';
    if (item.color) xml += '          <ЗначенияСвойства><Наименование>Цвет</Наименование><Значение>' + escapeXml(item.color) + '</Значение></ЗначенияСвойства>\n';
    if (item.size) xml += '          <ЗначенияСвойства><Наименование>Размер</Наименование><Значение>' + escapeXml(item.size) + '</Значение></ЗначенияСвойства>\n';
    xml += '        </ЗначенияСвойств>\n';
    xml += '      </Товар>\n';
  }
  xml += '    </Товары>\n';
  xml += '  </Каталог>\n';
  
  xml += '  <ПакетПредложений СодержитТолькоИзменения="false">\n';
  xml += '    <Ид>SHOWROOM-OFFERS</Ид>\n';
  xml += '    <Наименование>Пакет предложений шоурума</Наименование>\n';
  xml += '    <ИдКаталога>SHOWROOM-CATALOG</ИдКаталога>\n';
  xml += '    <ИдКлассификатора>SHOWROOM-CLASSIFIER</ИдКлассификатора>\n';
  xml += '    <ТипыЦен>\n';
  xml += '      <ТипЦены>\n';
  xml += '        <Ид>BASE-PRICE</Ид>\n';
  xml += '        <Наименование>Розничная цена</Наименование>\n';
  xml += '        <Валюта>RUB</Валюта>\n';
  xml += '      </ТипЦены>\n';
  xml += '    </ТипыЦен>\n';
  xml += '    <Предложения>\n';
  for (var o = 0; o < nomenclature.length; o++) {
    var oItem = nomenclature[o];
    var oSku = oItem.sku || ("ITEM-" + (o + 1));
    var oName = oItem.name || oSku;
    var oPrice = Number(oItem.price) || 0;
    var oQty = stockTotals[oSku] !== undefined ? stockTotals[oSku] : 0;
    xml += '      <Предложение>\n';
    xml += '        <Ид>' + escapeXml(oSku) + '</Ид>\n';
    xml += '        <Артикул>' + escapeXml(oSku) + '</Артикул>\n';
    if (oItem.barcode) xml += '        <Штрихкод>' + escapeXml(oItem.barcode) + '</Штрихкод>\n';
    xml += '        <Наименование>' + escapeXml(oName) + '</Наименование>\n';
    xml += '        <БазоваяЕдиница Код="796" НаименованиеПолное="Штука">шт</БазоваяЕдиница>\n';
    xml += '        <Цены>\n';
    xml += '          <Цена>\n';
    xml += '            <Представление>' + oPrice + ' руб.</Представление>\n';
    xml += '            <ИдТипаЦены>BASE-PRICE</ИдТипаЦены>\n';
    xml += '            <ЦенаЗаЕдиницу>' + oPrice + '</ЦенаЗаЕдиницу>\n';
    xml += '            <Валюта>RUB</Валюта>\n';
    xml += '          </Цена>\n';
    xml += '        </Цены>\n';
    xml += '        <Количество>' + oQty + '</Количество>\n';
    xml += '      </Предложение>\n';
  }
  xml += '    </Предложения>\n';
  xml += '  </ПакетПредложений>\n';
  xml += '</КоммерческаяИнформация>';
  return xml;
}

/**
 * ============================================================================
 * HTTP GET HANDLER
 * ============================================================================
 */
function doGet(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var params = e && e.parameter ? e.parameter : {};
    var apiKey = params.apiKey || "";
    var action = params.action || "";
    
    // 1. Экспорт CommerceML XML (Tilda / МойСклад / 1С)
    if (action === "cml" || action === "commerceml" || params.type === "catalog" || params.type === "offers") {
      var token = params.token || apiKey;
      if (API_SECRET_KEY && API_SECRET_KEY.trim() !== "" && token !== API_SECRET_KEY) {
        if (params.mode === "checkauth") {
          return ContentService.createTextOutput("failure\nНеверный ключ доступа")
            .setMimeType(ContentService.MimeType.TEXT);
        }
        return ContentService.createTextOutput('<?xml version="1.0" encoding="UTF-8"?><Error>Unauthorized: Неверный токен доступа</Error>')
          .setMimeType(ContentService.MimeType.XML);
      }
      
      if (params.mode === "checkauth") {
        return ContentService.createTextOutput("success\nshowroom_cookie\nshowroom_sess_2026")
          .setMimeType(ContentService.MimeType.TEXT);
      }
      if (params.mode === "init") {
        return ContentService.createTextOutput("zip=no\nfile_limit=10485760")
          .setMimeType(ContentService.MimeType.TEXT);
      }
      
      var sheetNom = getOrCreateSheet(ss, SHEET_NOMENCLATURE, NOMENCLATURE_HEADERS, "#1e3a8a");
      var sheetStk = getOrCreateSheet(ss, SHEET_STOCK, STOCK_HEADERS, "#065f46");
      var nomData = readSheetData(sheetNom, NOMENCLATURE_HEADERS);
      var stkData = readSheetData(sheetStk, STOCK_HEADERS);
      
      var cmlFeed = params.feed || params.type || "all";
      var xmlOut = "";
      if (cmlFeed === "catalog") {
        xmlOut = generateCommerceMLCatalog(nomData, stkData);
      } else if (cmlFeed === "offers") {
        xmlOut = generateCommerceMLOffers(nomData, stkData);
      } else {
        xmlOut = generateCommerceMLAll(nomData, stkData);
      }
      
      return ContentService.createTextOutput(xmlOut)
        .setMimeType(ContentService.MimeType.XML);
    }
    
    if (!checkAuth(apiKey)) {
      return createJsonResponse({ success: false, error: "Unauthorized: Неверный API_SECRET_KEY" });
    }
    
    // 2. Быстрая проверка версии для клиента (polling раз в 45-60 сек)
    if (action === "checkVersion" || action === "getSystemVersion") {
      var props = PropertiesService.getScriptProperties();
      var versionHash = props.getProperty("STOCK_STATE_HASH") || "v1";
      var lastUpdated = props.getProperty("STOCK_STATE_UPDATED_AT") || new Date().toISOString();
      return createJsonResponse({
        success: true,
        versionHash: versionHash,
        lastUpdated: lastUpdated
      });
    }
    
    // 3. Проверка прав пользователя при загрузке
    if (action === "checkAccess" || action === "checkUserAccess") {
      var authResult = handleCheckUserAccess(ss, params);
      return createJsonResponse(authResult);
    }
    
    // 4. Загрузка всех таблиц с разделением прав (бренд видит только свой ассортимент)
    var sheetBrands = getOrCreateSheet(ss, SHEET_BRANDS, BRAND_HEADERS, "#0f172a");
    var sheetAcl = getOrCreateSheet(ss, SHEET_ACL, ACL_HEADERS, "#312e81");
    var sheetLogs = getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS, "#1e293b");
    var sheetNom = getOrCreateSheet(ss, SHEET_NOMENCLATURE, NOMENCLATURE_HEADERS, "#1e3a8a");
    var sheetStk = getOrCreateSheet(ss, SHEET_STOCK, STOCK_HEADERS, "#065f46");
    var sheetOps = getOrCreateSheet(ss, SHEET_OPERATIONS, OPERATIONS_HEADERS, "#701a75");
    
    var brands = readSheetData(sheetBrands, BRAND_HEADERS);
    var aclUsers = readSheetData(sheetAcl, ACL_HEADERS);
    var auditLogs = readSheetData(sheetLogs, LOG_HEADERS);
    var nomenclature = readSheetData(sheetNom, NOMENCLATURE_HEADERS);
    var stock = readSheetData(sheetStk, STOCK_HEADERS);
    var operations = readSheetData(sheetOps, OPERATIONS_HEADERS);
    
    // Если запрос делает пользователь со статусом Brand — отдаем ТОЛЬКО данные его бренда
    var brandFilter = params.brandId || "";
    if (brandFilter) {
      brands = brands.filter(function(b) { return String(b.id) === String(brandFilter); });
      nomenclature = nomenclature.filter(function(n) { return String(n.brandId) === String(brandFilter); });
      stock = stock.filter(function(s) { return String(s.brandId) === String(brandFilter); });
      operations = operations.filter(function(o) { return String(o.brandId) === String(brandFilter); });
    }
    
    var props = PropertiesService.getScriptProperties();
    var versionHash = props.getProperty("STOCK_STATE_HASH") || "v1";
    
    return createJsonResponse({
      success: true,
      timestamp: new Date().toISOString(),
      versionHash: versionHash,
      brands: brands,
      aclUsers: aclUsers,
      auditLogs: auditLogs,
      nomenclature: nomenclature,
      stock: stock,
      operations: operations
    });
  } catch (err) {
    return createJsonResponse({
      success: false,
      error: err.toString()
    });
  }
}

/**
 * ============================================================================
 * HTTP POST HANDLER
 * ============================================================================
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
    var sheetNom = getOrCreateSheet(ss, SHEET_NOMENCLATURE, NOMENCLATURE_HEADERS, "#1e3a8a");
    var sheetStk = getOrCreateSheet(ss, SHEET_STOCK, STOCK_HEADERS, "#065f46");
    var sheetOps = getOrCreateSheet(ss, SHEET_OPERATIONS, OPERATIONS_HEADERS, "#701a75");
    
    // МЕТОД 0: checkAccess / checkUserAccess
    if (action === "checkAccess" || action === "checkUserAccess") {
      var authResult = handleCheckUserAccess(ss, payload);
      return createJsonResponse(authResult);
    }
    
    // МЕТОД 0.1: requestAccess
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
    
    // МЕТОД 1: getAllData
    if (action === "getAllData") {
      var brands = readSheetData(sheetBrands, BRAND_HEADERS);
      var aclUsers = readSheetData(sheetAcl, ACL_HEADERS);
      var auditLogs = readSheetData(sheetLogs, LOG_HEADERS);
      var nomenclature = readSheetData(sheetNom, NOMENCLATURE_HEADERS);
      var stock = readSheetData(sheetStk, STOCK_HEADERS);
      var operations = readSheetData(sheetOps, OPERATIONS_HEADERS);
      
      var brandFilter = payload.brandId || "";
      if (brandFilter) {
        brands = brands.filter(function(b) { return String(b.id) === String(brandFilter); });
        nomenclature = nomenclature.filter(function(n) { return String(n.brandId) === String(brandFilter); });
        stock = stock.filter(function(s) { return String(s.brandId) === String(brandFilter); });
        operations = operations.filter(function(o) { return String(o.brandId) === String(brandFilter); });
      }
      
      return createJsonResponse({
        success: true,
        brands: brands,
        aclUsers: aclUsers,
        auditLogs: auditLogs,
        nomenclature: nomenclature,
        stock: stock,
        operations: operations
      });
    }
    
    // МЕТОД 2: initialMigration / saveAllData
    if (action === "initialMigration" || action === "saveAllData") {
      var countBrands = 0;
      var countAcl = 0;
      var countLogs = 0;
      var countNom = 0;
      var countStock = 0;
      var countOps = 0;
      
      if (Array.isArray(payload.brands)) countBrands = batchWriteSheet(sheetBrands, BRAND_HEADERS, payload.brands);
      if (Array.isArray(payload.aclUsers)) countAcl = batchWriteSheet(sheetAcl, ACL_HEADERS, payload.aclUsers);
      if (Array.isArray(payload.auditLogs)) countLogs = batchWriteSheet(sheetLogs, LOG_HEADERS, payload.auditLogs);
      if (Array.isArray(payload.nomenclature)) countNom = batchWriteSheet(sheetNom, NOMENCLATURE_HEADERS, payload.nomenclature);
      if (Array.isArray(payload.stock)) countStock = batchWriteSheet(sheetStk, STOCK_HEADERS, payload.stock);
      if (Array.isArray(payload.operations)) countOps = batchWriteSheet(sheetOps, OPERATIONS_HEADERS, payload.operations);
      
      return createJsonResponse({
        success: true,
        action: action,
        message: "Данные успешно синхронизированы с Google Таблицей",
        counts: {
          brands: countBrands,
          aclUsers: countAcl,
          auditLogs: countLogs,
          nomenclature: countNom,
          stock: countStock,
          operations: countOps
        }
      });
    }
    
    // МЕТОД 3: syncBrands
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
        if (foundRow > 0) sheetBrands.deleteRow(foundRow);
        return createJsonResponse({ success: true, operation: "delete", id: brand.id });
      }
      
      var brandRow = [];
      for (var c = 0; c < BRAND_HEADERS.length; c++) {
        var k = BRAND_HEADERS[c];
        var v = brand[k];
        if (k === "updatedAt") v = new Date().toISOString();
        brandRow.push(v !== undefined && v !== null ? v : "");
      }
      
      if (foundRow > 0) {
        sheetBrands.getRange(foundRow, 1, 1, BRAND_HEADERS.length).setValues([brandRow]);
      } else {
        sheetBrands.appendRow(brandRow);
      }
      
      return createJsonResponse({ success: true, operation: op, id: brand.id });
    }
    
    // МЕТОД 4: syncUsers
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
        if (targetRow > 0) sheetAcl.deleteRow(targetRow);
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
    
    // МЕТОД 5: appendLog
    if (action === "appendLog") {
      var log = payload.log;
      if (!log) return createJsonResponse({ success: false, error: "Требуется объект log" });
      var logRow = [];
      for (var lc = 0; lc < LOG_HEADERS.length; lc++) {
        var lk = LOG_HEADERS[lc];
        logRow.push(log[lk] !== undefined && log[lk] !== null ? log[lk] : "");
      }
      sheetLogs.appendRow(logRow);
      return createJsonResponse({ success: true, logId: log.id });
    }
    
    // МЕТОД 6: recordOperation — атомарная кассовая или складская операция
    if (action === "recordOperation") {
      var op = payload.operation;
      if (!op || !op.sku || !op.type) {
        return createJsonResponse({ success: false, error: "Требуется объект operation с полями sku и type" });
      }
      
      var opId = op.id || ("OP-" + new Date().getTime() + "-" + Math.random().toString(36).slice(2, 6));
      var opTimestamp = op.timestamp || new Date().toISOString();
      var opType = op.type; // Продажа, Поставка, Возврат, Списание, Перемещение, Инвентаризация
      var opSku = String(op.sku).trim();
      var opBarcode = String(op.barcode || "").trim();
      var opBrandId = String(op.brandId || "").trim();
      var opBrandName = String(op.brandName || "").trim();
      var opPlace = String(op.place || "Рейл 1").trim();
      var opQty = Number(op.quantity) || 1;
      var opPrice = Number(op.price) || 0;
      var opTotal = Number(op.totalAmount) || (opQty * opPrice);
      var authorName = op.authorName || "Продавец";
      var authorTgId = cleanTgId(op.authorTgId);
      var receiptId = op.receiptId || "";
      var notes = op.notes || "";
      
      // 1. Запись в журнал операций Stock_Operations
      var opRow = [
        opId,
        opTimestamp,
        opType,
        opSku,
        opBarcode,
        opBrandId,
        opBrandName,
        opQty,
        opPrice,
        opTotal,
        opPlace,
        authorName,
        authorTgId,
        receiptId,
        notes
      ];
      sheetOps.appendRow(opRow);
      
      // 2. Обновление остатков на листе Stock
      var stkLastRow = sheetStk.getLastRow();
      var foundStkRow = 0;
      var currQty = 0;
      var currReserved = 0;
      
      if (stkLastRow > 1) {
        var stkData = sheetStk.getRange(2, 1, stkLastRow - 1, STOCK_HEADERS.length).getValues();
        for (var s = 0; s < stkData.length; s++) {
          var rowSku = String(stkData[s][0]).trim();
          var rowPlace = String(stkData[s][3]).trim();
          if (rowSku === opSku && rowPlace === opPlace) {
            foundStkRow = s + 2;
            currQty = Number(stkData[s][4]) || 0;
            currReserved = Number(stkData[s][5]) || 0;
            if (!opBarcode && stkData[s][1]) opBarcode = String(stkData[s][1]);
            if (!opBrandId && stkData[s][2]) opBrandId = String(stkData[s][2]);
            break;
          }
        }
      }
      
      var newQty = currQty;
      if (opType === "Продажа" || opType === "Списание") {
        newQty = Math.max(0, currQty - Math.abs(opQty));
      } else if (opType === "Поставка" || opType === "Возврат") {
        newQty = currQty + Math.abs(opQty);
      } else if (opType === "Инвентаризация") {
        newQty = Math.max(0, Math.abs(opQty));
      } else if (opType === "Перемещение") {
        newQty = Math.max(0, currQty - Math.abs(opQty));
        
        var targetPlace = String(op.targetPlace || "Склад").trim();
        var targetFoundRow = 0;
        var targetCurrQty = 0;
        if (stkLastRow > 1) {
          var allStk = sheetStk.getRange(2, 1, stkLastRow - 1, STOCK_HEADERS.length).getValues();
          for (var t = 0; t < allStk.length; t++) {
            if (String(allStk[t][0]).trim() === opSku && String(allStk[t][3]).trim() === targetPlace) {
              targetFoundRow = t + 2;
              targetCurrQty = Number(allStk[t][4]) || 0;
              break;
            }
          }
        }
        var newTargetQty = targetCurrQty + Math.abs(opQty);
        var targetAvail = Math.max(0, newTargetQty);
        if (targetFoundRow > 0) {
          sheetStk.getRange(targetFoundRow, 5, 1, 4).setValues([[newTargetQty, 0, targetAvail, new Date().toISOString()]]);
        } else {
          sheetStk.appendRow([opSku, opBarcode, opBrandId, targetPlace, newTargetQty, 0, targetAvail, new Date().toISOString()]);
        }
      }
      
      var newAvail = Math.max(0, newQty - currReserved);
      var nowIso = new Date().toISOString();
      
      if (foundStkRow > 0) {
        sheetStk.getRange(foundStkRow, 5, 1, 4).setValues([[newQty, currReserved, newAvail, nowIso]]);
      } else if (newQty > 0) {
        sheetStk.appendRow([opSku, opBarcode, opBrandId, opPlace, newQty, currReserved, newAvail, nowIso]);
      }
      
      // 3. Синхронизируем карточку бренда в Brands
      if (opBrandId) {
        updateBrandStockCount(sheetBrands, sheetStk, opBrandId);
      }
      
      // 4. Обновляем версию состояния
      var props = PropertiesService.getScriptProperties();
      var newHash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, "op:" + opId + ":" + nowIso));
      props.setProperty("STOCK_STATE_HASH", newHash);
      props.setProperty("STOCK_STATE_UPDATED_AT", nowIso);
      
      return createJsonResponse({
        success: true,
        operationId: opId,
        type: opType,
        sku: opSku,
        place: opPlace,
        remainingQuantity: newQty,
        available: newAvail
      });
    }
    
    // МЕТОД 7: importShipment — пакетная приемка поставки (из Excel/CSV)
    if (action === "importShipment") {
      var shipment = payload.shipment;
      if (!shipment || !Array.isArray(shipment.items) || shipment.items.length === 0) {
        return createJsonResponse({ success: false, error: "Требуется объект shipment с непустым массивом items" });
      }
      
      var bId = String(shipment.brandId || "").trim();
      var bName = String(shipment.brandName || "").trim();
      var defaultPlace = String(shipment.place || "Рейл 1").trim();
      var author = shipment.authorName || "Администратор";
      var authorTg = cleanTgId(shipment.authorTgId);
      var shipNotes = shipment.notes || "Поставка товаров";
      var nowIso = new Date().toISOString();
      
      var items = shipment.items;
      var importedCount = 0;
      var totalPieces = 0;
      
      var nomLastRow = sheetNom.getLastRow();
      var existingNomMap = {};
      if (nomLastRow > 1) {
        var nomSkus = sheetNom.getRange(2, 1, nomLastRow - 1, 1).getValues();
        for (var n = 0; n < nomSkus.length; n++) {
          existingNomMap[String(nomSkus[n][0]).trim()] = n + 2;
        }
      }
      
      var stkLastRow = sheetStk.getLastRow();
      var existingStkMap = {};
      if (stkLastRow > 1) {
        var stkVals = sheetStk.getRange(2, 1, stkLastRow - 1, STOCK_HEADERS.length).getValues();
        for (var k = 0; k < stkVals.length; k++) {
          var sKey = String(stkVals[k][0]).trim() + "_" + String(stkVals[k][3]).trim();
          existingStkMap[sKey] = {
            row: k + 2,
            qty: Number(stkVals[k][4]) || 0,
            reserved: Number(stkVals[k][5]) || 0
          };
        }
      }
      
      var newNomRows = [];
      var newOpsRows = [];
      
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var itemSku = String(it.sku || "").trim();
        if (!itemSku) continue;
        
        var itemBarcode = String(it.barcode || "").trim();
        var itemName = it.name || itemSku;
        var itemCat = it.category || "Одежда";
        var itemColor = it.color || "";
        var itemSize = it.size || "";
        var itemPrice = Number(it.price) || 0;
        var itemCost = Number(it.costPrice) || 0;
        var itemQty = Math.max(1, Number(it.quantity) || 1);
        var itemPlace = String(it.place || defaultPlace).trim();
        var itemDesc = it.description || "";
        var itemPhoto = it.photoUrl || "";
        
        // Номенклатура
        if (existingNomMap[itemSku]) {
          var targetNomRow = existingNomMap[itemSku];
          sheetNom.getRange(targetNomRow, 2, 1, 11).setValues([[
            itemBarcode,
            bId,
            bName,
            itemName,
            itemCat,
            itemColor,
            itemSize,
            itemPrice,
            itemCost,
            itemDesc,
            itemPhoto
          ]]);
          sheetNom.getRange(targetNomRow, 14).setValue(nowIso);
        } else {
          newNomRows.push([
            itemSku,
            itemBarcode,
            bId,
            bName,
            itemName,
            itemCat,
            itemColor,
            itemSize,
            itemPrice,
            itemCost,
            itemDesc,
            itemPhoto,
            nowIso,
            nowIso
          ]);
          existingNomMap[itemSku] = nomLastRow + newNomRows.length;
        }
        
        // Остатки
        var stkKey = itemSku + "_" + itemPlace;
        if (existingStkMap[stkKey]) {
          var stkEntry = existingStkMap[stkKey];
          var updatedQty = stkEntry.qty + itemQty;
          var updatedAvail = Math.max(0, updatedQty - stkEntry.reserved);
          sheetStk.getRange(stkEntry.row, 5, 1, 4).setValues([[updatedQty, stkEntry.reserved, updatedAvail, nowIso]]);
          stkEntry.qty = updatedQty;
        } else {
          sheetStk.appendRow([itemSku, itemBarcode, bId, itemPlace, itemQty, 0, itemQty, nowIso]);
          stkLastRow++;
          existingStkMap[stkKey] = { row: stkLastRow, qty: itemQty, reserved: 0 };
        }
        
        // Журнал операций
        var shipOpId = "OP-IN-" + new Date().getTime() + "-" + i;
        newOpsRows.push([
          shipOpId,
          nowIso,
          "Поставка",
          itemSku,
          itemBarcode,
          bId,
          bName,
          itemQty,
          itemPrice,
          itemQty * itemPrice,
          itemPlace,
          author,
          authorTg,
          shipment.receiptId || "НАКЛАДНАЯ",
          shipNotes
        ]);
        
        importedCount++;
        totalPieces += itemQty;
      }
      
      if (newNomRows.length > 0) {
        sheetNom.getRange(nomLastRow + 1, 1, newNomRows.length, NOMENCLATURE_HEADERS.length).setValues(newNomRows);
      }
      if (newOpsRows.length > 0) {
        sheetOps.getRange(sheetOps.getLastRow() + 1, 1, newOpsRows.length, OPERATIONS_HEADERS.length).setValues(newOpsRows);
      }
      
      if (bId) {
        updateBrandStockCount(sheetBrands, sheetStk, bId, nowIso);
      }
      
      var props = PropertiesService.getScriptProperties();
      var newHash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, "shipment:" + nowIso));
      props.setProperty("STOCK_STATE_HASH", newHash);
      props.setProperty("STOCK_STATE_UPDATED_AT", nowIso);
      
      return createJsonResponse({
        success: true,
        importedCount: importedCount,
        totalPieces: totalPieces,
        brandId: bId,
        place: defaultPlace,
        message: "Поставка успешно принята: " + importedCount + " позиций (" + totalPieces + " шт.)"
      });
    }
    
    // МЕТОД 8: syncNomenclature
    if (action === "syncNomenclature") {
      if (Array.isArray(payload.nomenclature)) {
        var nCount = batchWriteSheet(sheetNom, NOMENCLATURE_HEADERS, payload.nomenclature);
        return createJsonResponse({ success: true, message: "Номенклатура обновлена пакетом", count: nCount });
      }
      
      var nomItem = payload.item;
      var nomOp = payload.operation || "update";
      if (!nomItem || !nomItem.sku) {
        return createJsonResponse({ success: false, error: "Требуется объект item с полем sku" });
      }
      
      var nLastRow = sheetNom.getLastRow();
      var foundNRow = 0;
      if (nLastRow > 1) {
        var skuCol = sheetNom.getRange(2, 1, nLastRow - 1, 1).getValues();
        for (var nr = 0; nr < skuCol.length; nr++) {
          if (String(skuCol[nr][0]) === String(nomItem.sku)) {
            foundNRow = nr + 2;
            break;
          }
        }
      }
      
      if (nomOp === "delete") {
        if (foundNRow > 0) sheetNom.deleteRow(foundNRow);
        return createJsonResponse({ success: true, operation: "delete", sku: nomItem.sku });
      }
      
      var nomRowVals = [];
      for (var nc = 0; nc < NOMENCLATURE_HEADERS.length; nc++) {
        var nk = NOMENCLATURE_HEADERS[nc];
        var nv = nomItem[nk];
        if (nk === "updatedAt") nv = new Date().toISOString();
        if (nk === "createdAt" && !nv) nv = new Date().toISOString();
        nomRowVals.push(nv !== undefined && nv !== null ? nv : "");
      }
      
      if (foundNRow > 0) {
        sheetNom.getRange(foundNRow, 1, 1, NOMENCLATURE_HEADERS.length).setValues([nomRowVals]);
      } else {
        sheetNom.appendRow(nomRowVals);
      }
      return createJsonResponse({ success: true, operation: nomOp, sku: nomItem.sku });
    }
    
    // МЕТОД 9: syncStock
    if (action === "syncStock") {
      if (Array.isArray(payload.stock)) {
        var sCount = batchWriteSheet(sheetStk, STOCK_HEADERS, payload.stock);
        return createJsonResponse({ success: true, message: "Остатки обновлены пакетом", count: sCount });
      }
      return createJsonResponse({ success: false, error: "Требуется массив stock" });
    }
    
    return createJsonResponse({ success: false, error: "Неизвестное действие (action): " + action });
  } catch (err) {
    return createJsonResponse({ success: false, error: err.toString() });
  } finally {
    lock.releaseLock();
  }
}
