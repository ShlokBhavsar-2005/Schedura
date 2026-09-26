# Schedura

An intelligent academic timetable scheduling system built with Node.js and a custom Genetic Algorithm. It generates conflict-free timetables for multiple student groups while respecting faculty availability, classroom constraints, and institutional scheduling preferences.

---

## Overview

Manually building timetables for an institution is a time-consuming and error-prone process, especially when dealing with overlapping faculty assignments, limited classrooms, and varying course loads. This system automates that process by modeling the scheduling problem as an optimization task and solving it using a Genetic Algorithm that evolves solutions until all hard conflicts are eliminated.

The application is a full-stack web app. Users sign in with their Google account, define their courses, faculty, classrooms, and constraints through a browser-based UI, and the backend handles the rest — from validation to schedule generation to exporting a formatted Excel file.

---

## Features

- Sign in with any Google account (Google Identity Services + JWT session)
- Project-based data management (each user manages their own scheduling projects)
- Configurable hard and soft constraints
- Genetic Algorithm with adaptive mutation and conflict repair
- Feasibility check before running the algorithm, so invalid configurations fail fast
- Excel export of the generated timetable
- Runs entirely on flat JSON files — no database setup required

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Algorithm | Custom Genetic Algorithm (`ga.js`) |
| Auth | Google Sign-In (`google-auth-library`), session JWT (`jsonwebtoken`) |
| Export | ExcelJS |
| Frontend | Vanilla HTML, CSS, JavaScript |
| Storage | JSON files |

---

## Getting Started

### Prerequisites

- Node.js v18 or higher
- npm

### Installation

```bash
git clone <repository-url>
cd schedura
npm install
```

### Google Sign-In Setup

This app authenticates users with Google Sign-In (Google Identity Services), so you need an OAuth 2.0 Client ID:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**.
2. Create an **OAuth client ID** of type **Web application**.
3. Under **Authorized JavaScript origins**, add the URL(s) you'll serve the app from (e.g. `http://localhost:5000` for local dev, plus your production URL).
4. Copy the generated **Client ID** and set it as an environment variable before starting the server:

```bash
set GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com   # Windows (cmd)
$env:GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com" # Windows (PowerShell)
export GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com # macOS/Linux
```

Also set `JWT_SECRET` to a strong random value in production (it defaults to a placeholder that must not be used outside local dev).

No user registration step is needed — any Google account can sign in, and a project workspace is created for that account automatically on first login.

### Running the Server

```bash
npm start
```

The server will start on `http://localhost:5000` by default.

---

## How the Timetable Generation Works

When a user submits their configuration and clicks "Generate Timetable", the backend executes the following pipeline in order:

1. **Input Validation** — Checks for duplicate IDs, empty fields, and malformed data structures.
2. **Feasibility Check** — Verifies mathematically that enough time slots exist for all required sessions. If not, it fails immediately with a clear message rather than running the algorithm indefinitely.
3. **Genetic Algorithm** — Evolves a population of candidate schedules. Each individual is scored by a fitness function that applies heavy penalties for hard constraint violations (faculty clashes, room double-bookings, student group conflicts) and lighter penalties for soft constraint violations. The algorithm restarts with a fresh population whenever it stagnates and never returns until it produces a schedule with zero hard conflicts — there is no time limit, so the feasibility check in step 2 is what keeps a request from running forever.
4. **Solution Formatting** — Converts the raw integer indices from the chromosome representation back into human-readable days, times, course names, and faculty.
5. **Excel Export** — Writes the final timetable to a formatted `.xlsx` file, which is made available for download.

---

## Constraint System

Constraints are defined by the user through the UI and sent to the backend as part of the scheduling request.

**Hard Constraints** must be satisfied for a timetable to be valid. Violations are penalized so heavily that any chromosome carrying them is effectively eliminated from the population. Examples include:

- Faculty unavailability on specific days or slots
- Room restrictions (e.g., a course must use a specific room)
- Faculty restricted to first-half slots only

**Soft Constraints** guide the algorithm toward a preferred schedule without strict enforcement. They carry user-defined weights. Examples include:

- Faculty prefers morning slots
- No back-to-back sessions for the same course
- Balanced daily course load across the week

---

## Project Structure

```
.
├── server.js          # Express server, API routes, validation, Excel export
├── ga.js              # Genetic Algorithm implementation
├── package.json
├── ga-worker.js       # Runs the GA on a worker thread
├── demo-data.js       # Feasible-by-construction sample school
├── public/
│   ├── app.css        # Shared design system (tokens, chrome, primitives)
│   ├── ui.js          # Shared runtime: session, API, toasts, modals
│   ├── login.html     # Sign-in page
│   ├── dashboard.html # Project list
│   ├── index.html     # Editor shell (seven steps)
│   ├── editor.css     # Editor-specific styles
│   ├── editor.js      # Editor logic and step router
│   └── shared.html    # Public read-only timetable viewer
├── data/              # Per-user project data (auto-created)
└── output/            # Generated Excel files (auto-created)
```

---

## Debugging Notes

- **Generation hangs**: The GA has no time limit and will restart indefinitely until it finds a zero-conflict schedule. If a request hangs for a long time, the feasibility checker likely has a gap — the configuration may be mathematically impossible to schedule even though the pre-check passed.
- **Constraints not being applied**: Verify that the constraint `type` string in the frontend form matches exactly what `ga.js` checks for in `checkHardConstraintViolations()` or `computeSoftPenalty()`.
- **Auth issues**: Sessions are an in-memory access token (30 min) plus an httpOnly `sch_rt` refresh cookie (30 days). To force a clean slate, delete that cookie in DevTools → Application → Cookies. An expired access token is refreshed silently; only a dead refresh cookie raises the "Signed out" overlay. If the Google button doesn't render, check that `GOOGLE_CLIENT_ID` is set on the server and that the page's origin is listed under "Authorized JavaScript origins" for that OAuth client.
- **A URL 404s**: Pages are served from real routes (`/login`, `/projects`, `/projects/:id/:step`, `/s/:shareId`), registered *before* `express.static`. A step slug that is not in `STEP_SLUGS` falls through to a 404 by design.
- **Excel export errors**: Errors in `createExcelTimetable()` are usually caused by unexpected null values in the formatted solution. Check the `formatSolution()` output first.

---

## License

ISC
