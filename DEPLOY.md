# Deploying the Reporting Center on Render

The app is one Node web service with a 1 GB disk for its own SQLite file. Report data stays in Supabase and is only read. Cost is about $7.25/month (Render Starter + disk).

## 1. Create a read-only database user in Supabase

In the Supabase dashboard, open **SQL editor** and run:

```sql
CREATE ROLE reporting_ro LOGIN PASSWORD 'choose-a-long-password';
GRANT USAGE ON SCHEMA public TO reporting_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporting_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting_ro;
```

Then go to **Project settings → Database → Connection string**, copy the pooler string, and replace the user with `reporting_ro.<project-ref>` and the password with the one above. That is your `REPORTING_DB_URL`.

If Row Level Security is on for a table, also add a policy that lets `reporting_ro` select, or that table will report as empty.

## 2. Create the service

1. In Render choose **New → Blueprint** and pick this repository. `render.yaml` sets up the service and its disk.
2. When asked, fill in:
   - `REPORTING_DB_URL`: from step 1
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD`: your first sign-in (the password needs 10+ characters with letters and numbers)
   - `SMTP_*` and `EMAIL_FROM`: your mail provider. You can leave these empty at first.
3. Deploy. When it is live, sign in with the admin email and password.

`SESSION_SECRET` is generated for you, and shared links use the `onrender.com` address Render gives the service. If you later add your own domain, set it under Settings → App address (or as `APP_URL`). `DELIVERY_MODE` starts at `dry_run`, so scheduled emails only go to the Outbox. Switch it to `live` (or set *Live* under Settings → Email) when you are ready to send.

## 3. First steps in the app

1. **Settings → Database → Test the connection.**
2. **Reports → Data settings:** untick any tables people shouldn't report on, and check which fields are hidden.
3. **Users & roles:** add people and pick their roles.
4. Build a report, or a report type with required data, and run the data audit.

## Updating

Every push to `main` redeploys. The SQLite file on the disk keeps users, reports, schedules and links between deploys.
