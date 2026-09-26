# AI Codebase Context: Schedura

This document is designed to provide an AI assistant with a rapid, comprehensive understanding of the Schedura project's architecture, data models, logic, and component relationships.

## 1. Project Overview
This is a full-stack vanilla JavaScript web application built with a **Node.js/Express** backend and a **Genetic Algorithm (GA)** to generate conflict-free academic timetables. It supports multiple users, project management, customizable hard/soft constraints, and exports schedules to Excel.

*   **Frontend**: Vanilla HTML/JS/CSS, no frameworks. Shared `app.css` + `ui.js`; pages are `login.html`, `dashboard.html`, `index.html` (+ `editor.js`/`editor.css`) and the public `shared.html`. Every screen has a real URL (`/login`, `/projects`, `/projects/:id/:step`, `/s/:shareId`). Login is Google Sign-In; the access token lives in memory and is renewed from an httpOnly `sch_rt` refresh cookie.
*   **Backend**: Node.js, Express (`server.js`). Handles authentication, CRUD operations on JSON files, running the Genetic Algorithm, and generating Excel files.
*   **Database**: Flat JSON files (e.g., `data/projects_<email>.json` for project data). No local user table — identity comes from a verified Google ID token, and any Google account can use the app.

## 2. Key Files & Responsibilities
*   **`server.js` (800+ lines)**: The central backend file.
    *   Auth routes (`/api/auth/google`, `/api/config`, `/api/me`) using `google-auth-library` to verify the Google ID token and `jsonwebtoken` to issue the app's own session JWT.
    *   Project CRUD routes (`/api/projects`).
    *   `/api/generate-timetable`: The core endpoint. Handles validation (`validateInput`), mathematical feasibility (`checkFeasibility`), executes the GA, and formats the output.
    *   Excel Generation: Uses `exceljs` to render the output table (`createExcelTimetable`).
*   **`ga.js` (800+ lines)**: Contains the `GeneticAlgorithm` class. It manages the evolutionary process (population, fitness, selection, crossover, mutation, conflict repair) to find a schedule that breaks 0 hard constraints and minimizes soft constraint penalties.
*   **`public/index.html` + `public/editor.js`**: The editor, split into seven steps (standards · classrooms · teachers · timetable · assignments · rules · schedule) rather than one scrolling form. `index.html` is the shell of step panels; `editor.js` holds the model, the renderers, the step router (`STEPS`, `goToStep`, `stepGap`, `stepDone`), autosave, and the generate/improve flow.
*   **`public/ui.js`**: Shared browser runtime — `Schedura.api()` (token, silent refresh, re-auth overlay), toasts with Undo, modal `confirm`/`promptText`, offline banner, favicon, relative-time formatting.
*   **`public/shared.html`**: Public read-only viewer for `/s/:shareId`. Serves the generated schedule only; inputs and rules are never exposed.
*   **`ga-worker.js`**: Runs the GA on a worker thread so the server stays responsive and a run can be cancelled.
*   **`demo-data.js`**: Builds a valid week first and derives a sample school from it, so the demo is guaranteed solvable.
*   **`constraints_explanation.md`**: Detailed documentation explaining the logic behind hard and soft constraints.

## 3. Core Data Models
A **Project** object (stored in `data/projects_<email>.json`) contains the following key properties:
*   `standards`: Array of student classes (e.g. "8-A"). Each standard contains an array of `courses`.
*   `faculty`: Array of teachers with `id`, `name`, and `facultyCode`.
*   `classrooms`: Array of `{ id, name }`. A division pins to a room by `id`, so renaming a room cannot break the link.
*   `timeSlotValues`: Array of `{ startTime, endTime }` pairs.
*   `selectedDays`: Array of strings (e.g., "Monday").
*   `assignments`: The core input mapping. Each is `{ id, divisionId, courseId, facultyId, timesPerWeek }` — keyed on the *division*, which is what actually gets scheduled.
*   `runs`: Up to 12 recent generations — `{ at, mode, durationMs, classCount, conflicts, softMet, softTotal }`.
*   `share`: `{ id, createdAt, enabled }` when a public link exists.
*   `deletedAt`: Set by a soft delete; the project is hidden for 30 days, then purged.
*   `hardConstraints` & `softConstraints`: Arrays of rule objects defined by the user.

A **Gene** (in the Genetic Algorithm):
Represents one individual class session. 
Structure: `{ assignmentId, courseId, facultyId, classroomIdx, dayIdx, timeSlotIdx, instance }`
*(Note: `classroomIdx`, `dayIdx`, and `timeSlotIdx` are integers mapping back to the project arrays).*

## 4. The Timetable Generation Pipeline
When the user clicks "Generate Timetable", the flow is strictly enforced in `server.js`:

1.  **`validateInput(data)`**: Ensures no duplicate IDs, empty names, or malformed data.
2.  **`checkFeasibility(data)`**: Mathematical boundary checks. (e.g., Are there enough total slots? Does a standard have more classes than available slots?). Fails early if mathematically impossible.
3.  **`GeneticAlgorithm.run()`**: Evolves solutions until `conflicts === 0`. There is no time limit — it restarts with a fresh population on stagnation and never returns a partial solution, so `checkFeasibility()` in step 2 is what has to catch impossible configurations.
4.  **`formatSolution(solution, metadata)`**: Transforms integer indices back into human-readable strings (Days, Times, Course Names).
5.  **`createExcelTimetable(schedule, filepath)`**: Writes out the beautifully formatted `.xlsx` file.

## 5. Genetic Algorithm Mechanics (`ga.js`)
*   **Fitness Function**: `fitness = distributionScore - softPenalty - hardPenalty`
    *   `hardPenalty` is astronomically high. A valid timetable *must* have a hard penalty of 0.
*   **Hard Conflicts Detected**: Faculty clash (double booking), Classroom clash (double booking), Standard clash (double booking), and custom Hard Constraint violations.
*   **Soft Constraints Evaluated**: `faculty_prefers_first_half`, `no_back_to_back_course`, `balanced_daily_load`, `course_preferred_slot`. These incur proportional weights but do not invalidate the timetable.
*   **Advanced Features**: The GA uses a `repairConflicts()` method to surgically mutate invalid genes in elite individuals, drastically reducing execution time compared to blind mutation. It also uses Adaptive Mutation (mutation rate spikes if stagnation occurs).

## 6. Constraint System Architecture
Constraints are defined on the frontend, sent to the backend, and heavily impact the GA fitness.
*   **Hard Constraints** (e.g., `faculty_unavailability`, `room_restriction`, `faculty_first_half_only`): Calculated inside `ga.js` -> `checkHardConstraintViolations()`. They increment the `violations` counter, which mathematically kills the chromosome.
*   **Soft Constraints** (e.g., `faculty_prefers_first_half`): Calculated inside `ga.js` -> `computeSoftPenalty()`. These increment a `penalty` based on the user-defined `weight`, guiding the algorithm toward an optimized schedule without strict failure.

## 7. How to Debug Common Issues
*   **Timetable never finishes / hangs**: Check the `ga.js` stagnation/restart loop. There is no time limit — the GA restarts until it reaches 0 conflicts, so a hang means the `checkFeasibility` logic in `server.js` is missing a mathematical edge case.
*   **Missing or duplicated constraints**: Ensure the DOM IDs map correctly to `hardConstraints` or `softConstraints` arrays in `index.html`, and ensure `ga.js` specifically looks for that `constraint.type` string.
*   **Excel Export issues**: Handled in `server.js` -> `createExcelTimetable()`. Columns are dynamically generated via `excelColName()`.
*   **State / Auth issues**: Delete the httpOnly `sch_rt` cookie to force a fresh sign-in (it cannot be cleared from script). Verify `data/projects_<email>.json` has valid JSON syntax.
