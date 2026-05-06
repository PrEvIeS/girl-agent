# Changelog

## 0.2.0 — Anthropic OAuth (Claude Pro/Max)

Дата: 2026-05-06

- Добавлено: Claude.ai Pro/Max OAuth как альтернативный метод авторизации для пресета `anthropic`. В визарде новая радиокнопка между «API key» и «OAuth». Логин — paste-primary: открывается браузер на `claude.com/cai/oauth/authorize`, ты копируешь `code` (или весь redirect-URL) обратно в TUI.
- Добавлены CLI-флаги: `--reauth=<slug>` (перевыпустить токены для существующего OAuth-профиля) и `--no-browser` (только распечатать URL, не пытаться запустить браузер).
- Токены хранятся per-profile в `data/<slug>/config.json` (не в shared `~/.config/`). Refresh — гибридный: проактивный по `expiresAt` + lazy retry на 401. Single-flight через module-level Map в `src/llm/oauth.ts`.
- Scope: только `user:inference` — минимум, нужный для `messages.create`. Меньше surface для AUP.
- AUP caveat: Pro/Max OAuth — для личного использования. Прогон через бот, обслуживающий третьих лиц, может нарушать Anthropic AUP и привести к бану аккаунта. Визард показывает эту подсказку. Целевой кейс — owner-DM-only.
- API-key путь не изменён. Существующие профили загружаются без миграции.

## 0.1.3 — Telegram formatting fix

Дата: 2026-05-05

- Исправлено: включён `parse_mode: "MarkdownV2"` для отправки сообщений в Telegram (bot и userbot).
- Теперь поддерживается форматирование спойлеров `||текст||` и другие MarkdownV2-стили.

## 0.1.2 — communication realism update

Дата: 2026-05-05

- Hotfix: профили из wizard теперь сохраняются раньше, а список профилей больше не показывает недосохранённые папки без `config.json`.
- Добавлены жизненные стили общения: **Нормальная**, **Милая**, **Альтушка**, **Залипала**, **Болтушка**.
- Добавлен `CommunicationProfile` с настройками уведомлений, стиля сообщений, инициативы и life sharing.
- Presence, reply timing, bubbles, ignore chance и proactive agenda теперь учитывают профиль общения.
- Wizard и CLI получили настройку communication profile.
- Runtime `:status` и `:debug` показывают профиль общения.
- Команда `:log` стала удобнее и поддерживает выбор дня/лимита вывода.
- Старый `vibe` автоматически нормализуется в новый формат.

## 0.1.1 — stability baseline

- Базовый публичный релиз с Telegram bot/userbot режимами.
- Persona, speech, relationship state, memory, conflict и agenda-модули.
- Документация по установке, конфигурации, реализм-модулям и troubleshooting.
