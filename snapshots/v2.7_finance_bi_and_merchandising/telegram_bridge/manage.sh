#!/bin/bash
# Management script for Antigravity Telegram Bridge service

PLIST="$HOME/Library/LaunchAgents/com.antigravity.telegram_bridge.plist"
LOG="$HOME/.gemini/antigravity/log/telegram_bridge.log"
ERR_LOG="$HOME/.gemini/antigravity/log/telegram_bridge_err.log"

case "$1" in
  start)
    echo "Запуск службы Telegram Bridge в launchd..."
    launchctl unload "$PLIST" 2>/dev/null
    launchctl load -w "$PLIST"
    sleep 1
    launchctl list | grep com.antigravity.telegram_bridge && echo "✅ Служба успешно запущена!" || echo "❌ Ошибка запуска"
    ;;
  stop)
    echo "Остановка службы Telegram Bridge..."
    launchctl unload "$PLIST" 2>/dev/null
    echo "✅ Служба остановлена"
    ;;
  restart)
    echo "Перезапуск службы Telegram Bridge..."
    launchctl unload "$PLIST" 2>/dev/null
    sleep 1
    launchctl load -w "$PLIST"
    sleep 1
    launchctl list | grep com.antigravity.telegram_bridge && echo "✅ Служба перезапущена!" || echo "❌ Ошибка запуска"
    ;;
  status)
    echo "=== Статус службы com.antigravity.telegram_bridge ==="
    launchctl list | grep com.antigravity.telegram_bridge || echo "Служба не активна в launchctl"
    echo "=== Проверка локального порта IPC ==="
    curl -s http://127.0.0.1:18822/health || echo "Порт 18822 не отвечает"
    echo ""
    ;;
  logs)
    echo "=== Последние логи службы ($LOG) ==="
    tail -n 30 "$LOG" 2>/dev/null || echo "Логов пока нет"
    if [ -s "$ERR_LOG" ]; then
      echo "=== Ошибки ($ERR_LOG) ==="
      tail -n 20 "$ERR_LOG"
    fi
    ;;
  *)
    echo "Использование: $0 {start|stop|restart|status|logs}"
    exit 1
    ;;
esac
