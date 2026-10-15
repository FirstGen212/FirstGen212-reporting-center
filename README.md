# Reporting Center

A standalone web app for reporting on the core Supabase database. People with the right role can:

1. **Build reports from any field and data type.** Tables, columns and the keys inside JSON columns are read from the database, with their types and how often each is filled in.
2. **Email reports automatically on any cadence.** Every few hours, daily, weekly, monthly, quarterly or any cron expression, with Excel, CSV or PDF attached.
3. **Create report types and customer reports, and export or share them.** A report type is a template; customer reports are made from it per customer. Downloads come as CSV, Excel, PDF or one file per customer, and expiring links let people outside the company view and download.
4. **Audit the data an export depends on.** Required fields with checks show which rows are missing data or have bad values, and can hold an export back until the data is fixed.

It only ever **reads** from Supabase. Its own data (users, saved reports, schedules, links, history) lives in a small SQLite file next to the app.

```bash
npm install
npm run demo   # http://localhost:4400 with a "sign in as anyone" picker (local only)
npm start      # email + password sign-in (what runs in production)
npm test
```

Requires Node 22.13+. See [DEPLOY.md](DEPLOY.md) to put it on Render.

## Connecting the database

Set `REPORTING_DB_URL` to a Postgres connection string for the Supabase project (or paste it under **Settings → Database**). The safest setup is a database user that can only read; DEPLOY.md has the SQL. Every report runs inside a `READ ONLY` transaction with a time limit either way.

On first start the app reads every table outside Supabase's system schemas. **Reports → Data settings** chooses which tables are reportable (all of `public` by default), hides individual fields, and can limit a role to certain tables. Fields that look like SSNs, birth dates, passwords, tokens or bank details stay hidden until an admin allows them.

## Who can do what

**Users & roles** manages people and roles. A role grants any of these capabilities:

| Capability | What it allows |
|---|---|
| Run and export reports | Open reports, preview them, download files, run the data audit |
| Create and edit reports and report types | The report builder |
| Schedule reports to be emailed | Create, edit, pause and send schedules |
| Share reports outside the company | Expiring public links, and schedules to addresses that aren't app users |
| Choose which tables and fields reports can use | Data settings |
| Manage users, roles and app settings | Users & roles, Settings |
| View the audit log and outbox | Outbox & audit log |

Three roles come built in: **Admin** (everything), **Report builder** (run, build, schedule, share) and **Viewer** (run and export). A report can be visible to everyone with access, or only to its owner and admins.

## Building a report

- **Fields panel:** search every field in every table you can use, and click a field to add it (click again to remove it). The first field picks the main table. Columns appear in the order you add them; drag them to reorder, and click one to rename, summarise or sort it. The preview updates as you go, and Excel, CSV and PDF exports sit in the header.
- **Linked tables:** picking a field from another table links that table in automatically, first from foreign keys and then by checking which ID-like fields actually share values (for example the company ID inside a census snapshot and `airtable_id` in the company directory). If no relationship can be found, the field isn't added and the panel says the tables can't be connected. Under **Settings** you can change the match, choose whether rows with no match are kept, and use only the newest row of a linked history table.
- **Columns:** any field, optionally summarised (count, count distinct, sum, average, min, max). When any column is summarised, the others become the grouping.
- **Filters:** depend on the field type. Text has *is*, *contains*, *is any of* and similar; numbers have comparisons and *between*; dates have *on*, *before*, *between*, *last/next N days*, *this month*, *last month* and *this year*; any field can be *empty* or *not empty*. Values can use `{{customer}}` and `{{today}}`. For text and number fields, **Pick** lists the values actually in the data (most common first) so you can tick the ones you want; ticking several turns *is* into *is any of*.
- **Locked rules** (under *Required data & audit*): conditions like *Employee status must be Active* that always apply to the report, its exports, emails and shared links, even when filters are set to match *any*. Customer reports made from a type inherit the type's locked rules and can't change them.
- **History:** *Only the newest row for each record* turns a change-log table (like `census_snapshot_history`) into one row per record, optionally as of a date.
- **Customer field:** the field that says which customer a row belongs to. It lets a report run for one customer, and it is required for a report type.
- Reports are saved as definitions, never as SQL: fields must exist, and every value is a bind parameter. Limits are set with `REPORT_QUERY_TIMEOUT_MS` (default 120000), `REPORT_MAX_ROWS` (100000) and `REPORT_AUDIT_MAX_ROWS` (50000).

## Report types and customer reports

A **report type** is a template with a customer field and required data. **+ Customer reports** picks customers from the data and makes one report each. Customer reports always follow the type, so changing the type changes all of them. **Export per customer** downloads a zip with one file per customer, and lists any customer whose export was held back by the audit.

## Scheduled email

Open a report and choose **Schedules → + Schedule**. Set how often it runs (in the timezone under Settings), who it goes to, the subject (`{{date}}` and `{{customer}}` are filled in), a message, and which files to attach. You can also skip sending when the report is empty. A schedule runs with its creator's current permissions. If the server was down when a send was due, it sends once when the server is back. Until **Settings → Email** is set to *Live* with SMTP details, every email is only logged in the **Outbox**.

## Sharing outside the company

**Shared links → + Create link** makes a page anyone with the link can open without signing in. It shows the table and offers the downloads you allow. A *snapshot* link freezes the data when it is created; a *live* link re-runs the report on each visit. Links expire after 1 to 365 days and can be turned off at any time. Only a hash of the link is stored, and views are counted.

## Data audit

Under **Required data**, list the fields an export can't do without. Each one gets a check (required, valid email, phone, date, number, one of a list, pattern, minimum length) and a severity (critical or warning). The **Data audit** tab shows:

- missing and invalid counts for each check
- a breakdown by customer
- the rows to fix, downloadable to Excel
- fill rates for every column

**When critical data is missing** decides what happens next. *Hold the export* stops downloads, shared links and scheduled sends; a held schedule emails its owner the rows to fix instead. *Send it, with a warning* goes ahead and notes the problems. *Don't check* skips the audit. Admins can export a held report anyway, and that is recorded in the audit log.

## Code map

```
server/
  index.js         Express app: sign-in, users & roles, settings, outbox/audit, scheduler, static files
  reporting.js     Saved reports and types, exports, schedules, share links, data audit routes, /r/:token pages
  reportSource.js  Read-only Supabase connection; discovers tables, columns and JSON keys
  reportQuery.js   Report definition → parameterised SELECT; field catalog; hidden fields
  reportAudit.js   Required-field checks
  reportExport.js  CSV / Excel / PDF files and per-customer zips
  reportCron.js    Cadences and cron expressions in the business timezone
  db.js            The app's own SQLite database
  auth.js          Passwords (scrypt), signed session cookies, sign-in throttling
  perms.js         Roles and capabilities
  mail.js          SMTP delivery and the outbox
frontend/          No-build UI (app.js: shell, users, settings, log; reporting.js: everything about reports)
test/              node --test unit tests
```
