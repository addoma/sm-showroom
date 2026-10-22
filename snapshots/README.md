# Снапшоты и Резервные копии версий Showroom CRM

В этой папке хранятся неизменяемые слепки (снапшоты) рабочих версий проекта для возможности быстрого отката при необходимости.

## Список снапшотов:

1. **`v1.0_original_localStorage`**
   - Исходная версия CRM, работавшая исключительно на локальном `localStorage` браузера пользователя.
   - Файлы: `index.html`.

2. **`v2.0_cloud_migration`**
   - Первая версия с интеграцией Google Apps Script (Zero-Data-Loss, Anti-Wipe Guard, экспорт/импорт).
   - Файлы: `index.html`, `Code.js`.

3. **`v2.1_zero_deadlock_auth_stable` (Текущая стабильная)**
   - Полноценная защита от Deadlock авторизации для новых сотрудников:
     - Облачный pre-auth через `checkAccess`.
     - Автолинковка постоянного числового `tgUserId`.
     - Интерактивный экран блокировки с передачей номера телефона через Telegram WebApp SDK.
     - Развернутый продакшн-деплой `@3`.
   - Файлы: `index.html`, `Code.js`.

---

## Как откатиться на любой снапшот:

Чтобы восстановить проект из любого снапшота (например, `v2.0_cloud_migration`), выполните в корне проекта:
```bash
cp snapshots/v2.0_cloud_migration/index.html ./index.html
cp snapshots/v2.0_cloud_migration/Code.js ./Code.js
git commit -am "rollback: restore snapshot v2.0_cloud_migration"
git push
/usr/local/bin/node /usr/local/bin/clasp push
```
