# MoneyMap — Modern Expense Tracker

## Run it
1. Open `index.html` in a modern browser.
2. Add transactions, budgets, and recurring items.

## Features
- Responsive dashboard with summary cards
- Add, edit, and delete income, expense, and savings transactions
- Monthly selector and category spending chart
- Monthly and category budgets
- Six-month income/expense report
- Recurring item schedule list with automatic transaction creation for due items
- CSV export
- Light/dark mode
- Data saved locally in your browser using localStorage

## Notes
- Charts load Chart.js from jsDelivr, and fonts load from Google Fonts, so those visual enhancements require an internet connection.
- Editing a recurring transaction changes that individual transaction only; the saved recurring schedule remains unchanged.
- Your data is stored in this browser on this device. It is not synced between devices and may be removed if you clear browser site data.
- Recurring transactions are generated when you open the app if their due dates have arrived. The app catches up missed dates, advances the next due date, and records each occurrence so reopening the app does not duplicate it. This browser-only app must be opened to process due items; it does not run in the background or send payment reminders. Review generated entries like any other transaction.


## Savings goals
The Savings goals section lets you create named goals with a target amount, an optional target date, and an optional starting balance. Use the contribution field on a goal card to add progress; totals and progress bars update automatically. Goals are stored in this browser's local storage, alongside the rest of the app's local data. Deleting a goal removes only the goal tracker; it does not delete or create a transaction.


## Backup and restore

Open **Backup & restore** in the sidebar to download a full JSON backup of transactions, overall and category budgets, recurring items, savings goals, and theme settings. To restore, choose a JSON backup exported by MoneyMap and click **Restore selected backup**. The app validates the file and asks for confirmation before replacing current browser data. Keep backup files secure because they may contain personal financial information.

Backups are manual; export them regularly and before restoring. This is a browser-based app and does not automatically sync data between devices.


## Private cloud sync reliability

The cloud-sync build includes a sync status indicator and optimistic concurrency protection. Run `supabase-sync-reliability.sql` in your existing Supabase project before using this updated build. It adds a revision counter and an atomic save function without deleting your current cloud payload. If another device has saved a newer snapshot, MoneyMap pauses syncing instead of silently overwriting it. Export a backup before choosing to reload the latest cloud version. This detects conflicts; it does not automatically merge simultaneous edits.
