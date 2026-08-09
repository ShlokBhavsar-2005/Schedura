# Timetable Generator Codebase Explanation

## Project Overview

This is an **Intelligent Timetable Generator** web application that uses a **Genetic Algorithm (GA)** to create optimized school timetables. The system ensures that all hard constraints (e.g., no double-booking of faculty or classrooms) are satisfied while maximizing soft constraints (e.g., preferred time slots).

Key features:
- User authentication restricted to `@diu.iiitvadodara.ac.in` domain
- Project-based timetable creation and management
- Constraint-based scheduling (hard and soft constraints)
- Excel export of generated timetables
- Web-based interface with dashboard

## Architecture

The application follows a **client-server architecture**:

- **Backend**: Node.js/Express server handling API requests, authentication, and GA computation
- **Frontend**: Static HTML/CSS/JavaScript pages served by Express
- **Data Storage**: JSON files for users and projects (per-user basis)
- **Algorithm**: Custom Genetic Algorithm implementation for timetable optimization

### Directory Structure

```
timetabletest/
├── server.js              # Main Express server
├── ga.js                  # Genetic Algorithm implementation
├── adduser.js             # Script to add users to users.json
├── login_test.py          # Selenium tests for login functionality
├── package.json           # Node.js dependencies and scripts
├── users.json             # User database (email, hashed passwords)
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

- **Authentication**: `/api/login`, `/api/logout`, `/api/me`
- **Project Management**: `/api/projects` (CRUD operations)
- **Timetable Generation**: `/api/generate-timetable`
- **File Serving**: Static files from `public/`, Excel downloads from `output/`

**Key Features**:
- JWT-based authentication with 8-hour tokens
- Domain restriction to `@diu.iiitvadodara.ac.in`
- Per-user project storage in JSON files
- Input validation and feasibility checking before GA execution
- Excel generation using `exceljs` library

**Data Models**:
- **Users**: Stored in `users.json` with bcrypt-hashed passwords
- **Projects**: Per-user JSON files containing:
  - Standards (classes) with courses
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
  - No standard (class) double-booking per timeslot
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

- **login.html**: Authentication form with domain validation
- **dashboard.html**: Project listing, creation, editing
- **index.html**: Main timetable builder interface

**Features**:
- Dark theme with IBM Plex fonts
- Responsive design
- Client-side form validation
- AJAX calls to backend APIs
- Dynamic UI for adding/removing entities

### 4. User Management (adduser.js)

**Command-line script** to add users:
```bash
node adduser.js user@diu.iiitvadodara.ac.in password123
```

- Validates domain
- Hashes passwords with bcrypt
- Updates `users.json`

### 5. Testing (login_test.py)

**Selenium-based test suite** for login functionality:
- Tests various failure cases (empty fields, wrong domain, etc.)
- Validates success scenarios
- Uses Chrome WebDriver

## Data Flow

1. **User Login**: Client posts credentials → Server validates against `users.json` → Returns JWT
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
- **Authentication**: JWT, bcrypt
- **Algorithm**: Custom Genetic Algorithm (JavaScript)
- **File Processing**: exceljs for Excel generation
- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Testing**: Selenium WebDriver (Python)
- **Data Storage**: JSON files (no database)

## Dependencies (from package.json)

```json
{
  "express": "^4.18.2",      // Web framework
  "cors": "^2.8.5",          // Cross-origin requests
  "exceljs": "^4.3.0",       // Excel file generation
  "bcryptjs": "^2.4.3",      // Password hashing
  "jsonwebtoken": "^9.0.2"   // JWT tokens
}
```

## How to Run

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Add Users** (optional, sample users exist):
   ```bash
   node adduser.js newuser@diu.iiitvadodara.ac.in password123
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

5. **Run Tests**:
   ```bash
   python login_test.py
   ```

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
- Form for defining standards, courses, faculty, assignments
- Constraint configuration
- AJAX submission to generate timetable
- Results display with download link

### public/dashboard.html (Project Management)
- List user's projects
- Create/edit/delete projects
- Navigation to timetable builder

### public/login.html (Authentication)
- Email/password form
- Domain validation feedback
- JWT token storage

### users.json (User Database)
- Array of user objects with email, hashed password, name, role

### data/projects_*.json (Project Data)
- Per-user project storage
- Contains all input data and generated schedules

### output/*.xlsx (Generated Timetables)
- Excel files with formatted timetables
- Auto-cleanup keeps only 20 most recent

## Security Considerations

- Domain-restricted authentication (`@diu.iiitvadodara.ac.in`)
- Password hashing with bcrypt
- JWT tokens with expiration
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
- Selenium tests ensure login reliability

This codebase represents a complete, production-ready timetable generation system with robust constraint handling and user management.