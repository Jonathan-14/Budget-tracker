# MoneyMap private cloud sync setup

This build uses Supabase Auth and one private JSONB row per authenticated user. Public registration is intentionally not provided in the MoneyMap interface. Cloud sync is inactive until you configure Supabase.

## 1. Create a private Supabase project

1. Create a project at https://supabase.com/dashboard.
2. Save the database password in a password manager.
3. In **Authentication → Providers / Sign In**, keep Email enabled.
4. In **Authentication → Settings** (the exact label can vary), disable **Allow new users to sign up**. Do not rely on hiding a sign-up button alone.
5. Create your one user in the Supabase dashboard's **Authentication → Users** area using the dashboard's supported invite/create-user flow. Set a strong, unique password and complete any required email verification.
6. In **Project Settings → API**, copy the Project URL and the publishable key (or legacy anon key). These are intended for browser clients. Never use a `service_role` key or secret key in this project.

## 2. Create the private database table

1. Open **SQL Editor** in the Supabase dashboard.
2. For a new database, run the contents of `supabase-schema.sql`.
3. If you already created the table using an earlier MoneyMap package, run `supabase-sync-reliability.sql` now. This adds a revision counter and an atomic save function without deleting your existing cloud payload. You can also run it after the schema file; it is designed to be repeatable.
4. In **Table Editor**, confirm `public.moneymap_sync` exists, RLS is enabled, and the `revision` column is present.
5. Do not add an anonymous/public policy. The included policies require an authenticated session whose `auth.uid()` equals the row's `user_id`.

The table stores a single payload row for each authorized user. The primary key is the authenticated user's ID; RLS is the actual access boundary. Keep the Supabase project owner account protected with MFA.

## 3. Configure the browser client

Edit `supabase-config.js` and replace the two placeholders:

```js
window.MONEYMAP_SUPABASE_CONFIG = {
  url: "https://YOUR_REAL_PROJECT_REF.supabase.co",
  anonKey: "YOUR_REAL_PUBLISHABLE_OR_ANON_KEY"
};
```

Only put the Project URL and publishable/anon key here. Never put a database password, service-role key, secret API key, or other privileged credential in a browser file. The publishable key is not a password; the database's RLS policies protect data access.

## 4. Serve the app over HTTPS

For a quick local smoke test, you can use a local static server from this folder (for example, `python3 -m http.server 8000`) and open `http://localhost:8000`. For access from your other devices, host the static files on a trusted HTTPS static host and add the exact site URL to Supabase **Authentication → URL Configuration** and the allowed redirect URLs. Do not expose it on an untrusted shared computer.

## 5. Sign in and first sync

1. Open the app. With valid configuration, the sign-in screen appears.
2. Sign in with the one user you created in the Supabase dashboard.
3. If no cloud data exists yet, MoneyMap asks whether to upload the data currently stored in this browser. Choose **OK** to upload that local data. Choose **Cancel** only if you intentionally want to start with an empty cloud profile; that choice replaces this browser's MoneyMap data with an empty profile.
4. Once signed in, edits are saved locally immediately and synced to Supabase after a short debounce. The status indicator shows sync progress or errors.
5. Sign in on your other device using the same account and the same hosted app. Existing cloud data will be loaded onto that device.
6. If two devices edit data from the same older cloud version, MoneyMap detects the stale revision and pauses rather than silently overwriting the newer cloud snapshot. Export a backup before choosing to load the latest cloud version.

## Security notes and limitations

- There is no public registration form in MoneyMap. Disable public sign-ups in Supabase Auth settings as described above; verify that setting in the dashboard before using real data.
- Every row is protected by RLS. Test that a signed-out request cannot read the table and that another test account cannot read or modify your row before putting real data in the cloud. Do not create a second user unless you are specifically testing isolation; remove any test user afterward.
- Use a strong unique password and enable MFA for the Supabase dashboard owner. The app's own account is protected by Supabase Auth.
- The browser app is not end-to-end encrypted: the Supabase project can process the data, and anyone with access to your signed-in browser profile may see it. Use device encryption, screen lock, HTTPS, and sign out on shared devices.
- Changes are synchronized as one complete snapshot. Revision checks prevent a stale device from silently overwriting a newer cloud snapshot. When a conflict is detected, syncing pauses; export a backup of local changes before choosing to reload the cloud version. This is conflict detection, not automatic merging.
- Always keep periodic JSON backups, especially before changing devices or restoring data.
- Recurring transactions are generated when the app is opened, not by a background server job. Open MoneyMap periodically to process due items.
- Cloud sync is not enabled until you complete the setup and test the policies. Until then, the app remains local-only and shows setup instructions.
