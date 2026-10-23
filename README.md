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
