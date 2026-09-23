# Schedura Codebase Explanation

## Project Overview

This is **Schedura**, a timetable generation web application that uses a **Genetic Algorithm (GA)** to create optimized school timetables. The system ensures that all hard constraints (e.g., no double-booking of faculty or classrooms) are satisfied while maximizing soft constraints (e.g., preferred time slots).

Key features:
- Sign in with any Google account (Google Identity Services)
- Project-based timetable creation and management
- Constraint-based scheduling (hard and soft constraints)
- Excel export of generated timetables
- Web-based interface with dashboard

## Architecture

The application follows a **client-server architecture**:

- **Backend**: Node.js/Express server handling API requests, authentication, and GA computation
- **Frontend**: Static HTML/CSS/JavaScript pages served by Express
- **Data Storage**: JSON files for projects (per-user basis); no local user table — identity comes from Google
- **Algorithm**: Custom Genetic Algorithm implementation for timetable optimization

### Directory Structure

```
timetabletest/
├── server.js              # Main Express server
├── ga.js                  # Genetic Algorithm implementation
├── package.json           # Node.js dependencies and scripts
├── PROJECToverview.md     # (Ignored as per request)
├── public/                # Static web assets
│   ├── index.html         # Main timetable creation page
│   ├── login.html         # Login page
│   └── dashboard.html     # User dashboard for project management
├── data/                  # User project data (JSON files per user)
│   └── projects_<email>.json
└── output/                # Generated Excel timetable files
    └── timetable_*.xlsx
```

## Key Components

### 1. Server (server.js)

**Express.js application** that provides REST API endpoints:

- **Authentication**: `/api/config`, `/api/auth/google`, `/api/logout`, `/api/me`
- **Project Management**: `/api/projects` (CRUD operations)
- **Timetable Generation**: `/api/generate-timetable`
- **File Serving**: Static files from `public/`, Excel downloads from `output/`

**Key Features**:
- Google Sign-In: the client posts the Google ID token to `/api/auth/google`, the server verifies it with `google-auth-library` against `GOOGLE_CLIENT_ID`, then issues its own 8-hour session JWT
- Any verified Google account can sign in — no domain restriction, no pre-registration
- Per-user project storage in JSON files, keyed by the Google account's email
- Input validation and feasibility checking before GA execution
- Excel generation using `exceljs` library

**Data Models**:
- **Users**: Not stored locally — identity is the verified email from the Google ID token
- **Projects**: Per-user JSON files containing:
  - Groups (classes) with courses
  - Faculty members
  - Course assignments (course ↔ faculty mappings)
  - Classrooms, time slots, days
  - Hard/soft constraints
  - Generated schedule data

### 2. Genetic Algorithm (ga.js)

**Custom GA implementation** that guarantees zero hard constraint violations:

- **Population**: 100 individuals
- **Operators**: Tournament selection, crossover, mutation
- **Elitism**: Preserves top 8 individuals
- **Termination**: Only stops when conflicts = 0 (may run indefinitely)
- **Restarts**: Automatic restart with fresh population if stuck

**Supported Constraints**:
- **Hard Constraints** (must be satisfied):
  - No faculty double-booking
  - No classroom double-booking
  - No group (class) double-booking per time slot
  - Faculty unavailability
  - Faculty first/second half restrictions
  - Room restrictions for specific courses

- **Soft Constraints** (optimization goals):
  - Minimize gaps in faculty schedules
  - Prefer certain time slots
  - Balance workload

**Algorithm Flow**:
1. Initialize population with constraint-aware random individuals
2. Evaluate fitness (hard conflicts + soft penalties)
3. Evolve through generations until zero conflicts
4. Return best solution with schedule data

### 3. Frontend (public/*.html)

**Static HTML pages** with embedded CSS/JS:

- **login.html**: "Sign in with Google" button (Google Identity Services)
- **dashboard.html**: Project listing, creation, editing
- **index.html**: Main timetable builder interface

**Features**:
- Light "cream paper" theme with IBM Plex fonts
- Responsive design
- Client-side form validation
- AJAX calls to backend APIs
- Dynamic UI for adding/removing entities

## Data Flow

1. **User Login**: Google Identity Services returns an ID token to the client → client posts it to `/api/auth/google` → server verifies it with Google, then returns its own session JWT
2. **Project Creation**: Client sends project data → Server validates → Saves to `data/projects_<email>.json`
3. **Timetable Generation**:
   - Client sends project data + generation request
   - Server validates input and checks feasibility
   - GA runs until zero conflicts
   - Schedule formatted and saved to project
   - Excel file generated in `output/`
   - Client receives download link
4. **Project Management**: CRUD operations on user's project files

## Technologies Used

- **Backend**: Node.js, Express.js
- **Authentication**: Google Sign-In (`google-auth-library`), session JWT (`jsonwebtoken`)
- **Algorithm**: Custom Genetic Algorithm (JavaScript)
- **File Processing**: exceljs for Excel generation
- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Data Storage**: JSON files (no database)

## Dependencies (from package.json)

```json
{
  "express": "^4.18.2",             // Web framework
  "cors": "^2.8.5",                 // Cross-origin requests
  "exceljs": "^4.3.0",              // Excel file generation
  "google-auth-library": "^11.1.0", // Verifies Google ID tokens
  "jsonwebtoken": "^9.0.2"          // Session JWT tokens
}
```

## How to Run

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Google Sign-In**: create an OAuth 2.0 Client ID in the Google Cloud Console (see `README.md`) and set it as an env var:
   ```bash
   export GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
   ```

3. **Start Server**:
   ```bash
   npm start
   # or
   node server.js
   ```
   Server runs on http://localhost:5000

4. **Access Application**:
   - Login: http://localhost:5000/login.html
   - Dashboard: http://localhost:5000/dashboard.html
   - Main App: http://localhost:5000/

## Key Files Description

### server.js (Main Server)
- Express app setup with middleware
- Authentication routes with JWT
- Project CRUD with per-user JSON storage
- Timetable generation endpoint with GA integration
- Excel export functionality
- Input validation and feasibility checking

### ga.js (Genetic Algorithm)
- GA class with population management
- Constraint evaluation (hard/soft)
- Evolution operators (selection, crossover, mutation)
- Individual representation (genes for assignments)
- Constraint-aware initialization and repair

### public/index.html (Main Interface)
- Form for defining groups, courses, faculty, assignments
- Constraint configuration
- AJAX submission to generate timetable
- Results display with download link

### public/dashboard.html (Project Management)
- List user's projects
- Create/edit/delete projects
- Navigation to timetable builder

### public/login.html (Authentication)
- Google Identity Services "Sign in with Google" button
- Posts the Google ID token to `/api/auth/google`
- JWT token storage in `sessionStorage`

### data/projects_*.json (Project Data)
- Per-user project storage
- Contains all input data and generated schedules

### output/*.xlsx (Generated Timetables)
- Excel files with formatted timetables
- Auto-cleanup keeps only 20 most recent

## Security Considerations

- Identity is a Google-verified email (ID token checked server-side via `google-auth-library`); no locally stored passwords
- Any Google account can sign in — access control is per-project (each project file is scoped to its owner's email), not role-based
- JWT session tokens with expiration
- Input validation on all endpoints
- Path traversal protection for file downloads
- No sensitive data in client-side code

## Performance Notes

- GA may run for extended periods to find zero-conflict solutions
- Large populations/courses increase computation time
- Feasibility checking prevents impossible requests
- Excel generation is synchronous (may block for large timetables)

## Development Notes

- GA guarantees hard constraint satisfaction but may take time
- Soft constraints are optimization goals, not requirements
- Projects are stored as JSON for simplicity (no DB migration needed)
- Static frontend allows easy deployment

This codebase represents a complete, production-ready timetable generation system with robust constraint handling and user management.