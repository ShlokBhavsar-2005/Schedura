# Timetable Generator

An intelligent academic timetable scheduling system built with Node.js and a custom Genetic Algorithm. It generates conflict-free timetables for multiple student groups while respecting faculty availability, classroom constraints, and institutional scheduling preferences.

---

## Overview

Manually building timetables for an institution is a time-consuming and error-prone process, especially when dealing with overlapping faculty assignments, limited classrooms, and varying course loads. This system automates that process by modeling the scheduling problem as an optimization task and solving it using a Genetic Algorithm that evolves solutions until all hard conflicts are eliminated.

The application is a full-stack web app. Faculty or administrators log in, define their courses, faculty, classrooms, and constraints through a browser-based UI, and the backend handles the rest — from validation to schedule generation to exporting a formatted Excel file.

---

## Features

- Multi-user support with JWT-based authentication
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
| Auth | JWT (`jsonwebtoken`), password hashing (`bcryptjs`) |
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
cd timetable-generator
npm install
```

### Running the Server

```bash
npm start
```

The server will start on `http://localhost:3000` by default.

---

## User Management

Users are not registered through the UI. They are added directly via the `adduser.js` script. Emails must belong to the institutional domain (`@diu.iiitvadodara.ac.in`).

```bash
node adduser.js admin@diu.iiitvadodara.ac.in YourPassword123
```

This hashes the password with bcrypt and appends the user entry to `users.json`. You can run this script multiple times to add more users.

---

## How the Timetable Generation Works

When a user submits their configuration and clicks "Generate Timetable", the backend executes the following pipeline in order:

1. **Input Validation** — Checks for duplicate IDs, empty fields, and malformed data structures.
2. **Feasibility Check** — Verifies mathematically that enough time slots exist for all required sessions. If not, it fails immediately with a clear message rather than running the algorithm indefinitely.
3. **Genetic Algorithm** — Evolves a population of candidate schedules. Each individual is scored by a fitness function that applies heavy penalties for hard constraint violations (faculty clashes, room double-bookings, student group conflicts) and lighter penalties for soft constraint violations. The algorithm runs until it produces a schedule with zero hard conflicts, or exits after a 25-second safety timeout.
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
├── adduser.js         # CLI script to register new users
├── users.json         # Stores hashed user credentials
├── package.json
├── public/
│   ├── login.html     # Login page
│   ├── dashboard.html # Project management dashboard
│   └── index.html     # Main timetable editor UI
├── data/              # Per-user project data (auto-created)
└── output/            # Generated Excel files (auto-created)
```

---

## Debugging Notes

- **Generation hangs or times out**: The GA has a hard 25-second limit. If it consistently times out, the feasibility checker likely has a gap — the configuration may be mathematically impossible to schedule even though the pre-check passed.
- **Constraints not being applied**: Verify that the constraint `type` string in the frontend form matches exactly what `ga.js` checks for in `checkHardConstraintViolations()` or `computeSoftPenalty()`.
- **Auth issues**: Clear `sessionStorage` in the browser. If the token is expired or malformed, the session will silently fail.
- **Excel export errors**: Errors in `createExcelTimetable()` are usually caused by unexpected null values in the formatted solution. Check the `formatSolution()` output first.

---

## License

ISC
