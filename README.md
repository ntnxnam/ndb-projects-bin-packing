# NDB Projects – Bin packing Gantt

Schedule NDB 3.0 work items by **duration** (largest first) with optional **FTE capacity** so bars reorder and repack when you change the timeline or headcount.

## What it does

- **Two views**
  - **Sequential:** Projects sorted by duration (largest first); each bar starts when the previous one ends.
  - **Capacity-based:** Same order, but projects are placed in time so that total people allocated in any month does not exceed the configured capacity (parallel work where headcount allows).

- **Visual encoding**
  - **Bar length** = duration (months, from sizing “up to”).
  - **Bar thickness** = people allocated to that project (1 = no parallelization, &gt;1 = team chose to parallelize within the project).

- **Controls**
  - **Start date / End date** – timeline window (default: 01 Apr 2026 – 30 Jan 2027).
  - **Number of FTEs** – headcount (people).
  - **Capacity per FTE (%)** – share of each person’s time on this work (e.g. 60 = 60%); effective capacity = FTEs × capacity %.
  - **Priority** – filter by P0, P1, or All; bin packing runs only on the selected priority.

## Run locally

Data is loaded from `data/projects.json`, so the app must be served (no `file://`). The app always runs on **port 3847** so the URL stays consistent when you relaunch.

```bash
# From repo root (recommended – always uses port 3847)
npm run ndb
# or from this folder
npm start
# or
npx serve . -l 3847
# or
python3 -m http.server 3847
```

Then open **http://localhost:3847**

## Deploy to QA server

From the repo root:

```bash
./deploy.sh
```

This zips the app, uploads to ndb-qa.dev.nutanix.com, backs up the previous version, unzips, and starts the app on port 3847. Open **http://ndb-qa.dev.nutanix.com:3847**

### If you get "Connection timed out" (ERR_CONNECTION_TIMED_OUT)

The browser can’t reach the server. Common causes:

1. **Firewall** – Port 3847 may be blocked between your network and the server. Ask IT to open TCP port 3847 to `ndb-qa.dev.nutanix.com` (or the VM’s IP).
2. **VPN** – If ndb-qa.dev.nutanix.com is internal, connect to your org VPN and try again.
3. **Check the app is running on the server** – SSH in and run:
   ```bash
   ssh santhosh.s@ndb-qa.dev.nutanix.com
   curl -s -o /dev/null -w "%{http_code}" http://localhost:3847/
   lsof -i :3847
   cat /tmp/ndb-projects-bin-packing.log
   ```
   If `curl` returns 200 and `lsof` shows a process, the app is up; the problem is network/firewall between you and the server.

### Access via SSH tunnel (when port 3847 is blocked)

If the app is running on the server (deploy showed HTTP 200) but the browser can’t reach ndb-qa.dev.nutanix.com:3847, use an SSH tunnel so traffic goes over SSH (port 22), which is usually allowed:

```bash
ssh -L 3847:localhost:3847 santhosh.s@ndb-qa.dev.nutanix.com -N
```

Leave that terminal open, then open **http://localhost:3847** in your browser. Your Mac forwards local port 3847 to the server’s localhost:3847 over the SSH connection.

## Data

- **Source:** Prioritization CSV (Sheet1) with columns: FEAT NUMBER, SUMMARY, 3.0 Commitment Status, Total resources required, sizing.
- **Included:** Rows with commitment **Committed** or **Approved**, non-empty sizing, and numeric total resources.
- **Sizing:** Label → “up to” months (XS=1, S=3, M=5, L=8, XL=13, XXL=21, 3L=34, 4L=55).

### Regenerating `data/projects.json`

Place your Sheet1 export as `data/sheet1.csv`, then:

```bash
node scripts/prepare-data.js data/sheet1.csv
```

Or pass any CSV path:

```bash
node scripts/prepare-data.js /path/to/NDB-2026-IndiaOffsite-GlobalPriroritization - Sheet1.csv
```

## Repo layout

```
├── index.html          # Single-page app and controls
├── css/main.css        # Layout and Gantt styles
├── js/
│   ├── app.js          # Load data, bind controls, render both views
│   ├── bin-packing.js  # Sequential and capacity-based packing
│   ├── gantt.js        # Timeline axis and bar rendering
│   └── sizing.js       # Sizing map and helpers
├── data/
│   ├── sheet1.csv      # Optional: your Sheet1 export
│   └── projects.json   # Generated project list (used by the app)
├── scripts/
│   └── prepare-data.js # CSV → projects.json
└── README.md
```

## Conventions (from planning context)

- **Max parallelization:** More people can shorten calendar time; some work cannot be fully parallelized.
- **60% capacity:** Only 60% of a person’s time is assumed for this planning; the rest is other work.
- **3 devs : 1 QA:** QA headcount is derived from dev count by this ratio.

These are reflected in the source CSV and sizing; the Gantt uses **duration** and **total resources** as provided in the prepared data.
