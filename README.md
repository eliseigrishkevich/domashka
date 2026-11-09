# Домашка

Telegram Mini App: [@domaaashka_bot](https://t.me/domaaashka_bot)

Frontend: GitHub Pages (index.html, icon.jpg).
Backend: Supabase Edge Function `domashka` (index.ts, app.js).
Database: PostgreSQL, closed schema `domashka`; schema.sql documents the structure.

Registration, named poll answers, broadcasts, theme text, member statistics, CSV export, and Telegram contact links for the organizer. The server verifies Telegram initData and checks organizer IDs. Bot credentials stay in Supabase Vault; they are never included in the frontend or repository.

Free Supabase projects may pause after low database activity over 7 days; they can be resumed from the Supabase dashboard within 90 days. GitHub Pages itself stays available.

Do not store database exports, registration data, bot tokens, or service keys in this public repository.
