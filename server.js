require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const ExcelJS  = require('exceljs');
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const GeneticAlgorithm = require('./ga');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const JWT_SECRET      = process.env.JWT_SECRET || 'timetable_secret_change_me_in_production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient    = new OAuth2Client(GOOGLE_CLIENT_ID);

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// Create output directory if it doesn't exist
const outputDir = path.join(__dirname, 'output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Create projects data directory
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ─────────────────────────────────────────────
// PROJECT STORAGE HELPERS
// ─────────────────────────────────────────────

/** Get the file path for a user's projects JSON */
function userProjectsFile(email) {
  // Sanitize email to make a safe filename
  const safe = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  return path.join(dataDir, `projects_${safe}.json`);
}

/** Load all projects for a user */
function loadUserProjects(email) {
  const file = userProjectsFile(email);
  if (!fs.existsSync(file)) return [];
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return []; }
}

/** Save all projects for a user */
function saveUserProjects(email, projects) {
  const file = userProjectsFile(email);
  fs.writeFileSync(file, JSON.stringify(projects, null, 2));
}

// ─────────────────────────────────────────────
// AUTH HELPERS
// ─────────────────────────────────────────────

/** Middleware: verify JWT token on protected routes */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Unauthorized – please log in.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Session expired – please log in again.' });
  }
}

// ─────────────────────────────────────────────
// AUTH ROUTES (public – no auth needed)
// ─────────────────────────────────────────────

/**
 * GET /api/config – public config the frontend needs before login
 */
app.get('/api/config', (req, res) => {
  res.json({ success: true, googleClientId: GOOGLE_CLIENT_ID });
});

/**
 * POST /api/auth/google
 * Body: { credential }  — the ID token from Google Identity Services
 * Any verified Google account may sign in; the user's projects are
 * scoped by their Google email, no local password/user table needed.
 */
app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ success: false, error: 'Missing Google credential.' });
    }
    if (!GOOGLE_CLIENT_ID) {
      return res.status(500).json({ success: false, error: 'Server is not configured for Google Sign-In (GOOGLE_CLIENT_ID missing).' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();

    if (!payload || !payload.email_verified) {
      return res.status(401).json({ success: false, error: 'Google account email is not verified.' });
    }

    const email = payload.email.toLowerCase();
    const name  = payload.name || email.split('@')[0];

    const token = jwt.sign({ email, name }, JWT_SECRET, { expiresIn: '8h' });

    console.log(`✓ Google login: ${email}`);
    res.json({ success: true, token, email, name });

  } catch (err) {
    console.error('Google login error:', err);
    res.status(401).json({ success: false, error: 'Google sign-in failed. Please try again.' });
  }
});

/**
 * POST /api/logout  (client just discards token, but this confirms it)
 */
app.post('/api/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out.' });
});

/**
 * GET /api/me  – returns logged-in user info
 */
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ─────────────────────────────────────────────
// PROJECT CRUD ROUTES (all require auth)
// ─────────────────────────────────────────────

/** GET /api/projects  – list all projects for logged-in user */
app.get('/api/projects', requireAuth, (req, res) => {
  const projects = loadUserProjects(req.user.email);
  // Return list without bulky scheduleData to keep response small
  const summary = projects.map(p => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    hasOutput: !!p.scheduleData
  }));
  res.json({ success: true, projects: summary });
});

/** GET /api/projects/:id  – get full project (with inputs + output) */
app.get('/api/projects/:id', requireAuth, (req, res) => {
  const projects = loadUserProjects(req.user.email);
  const project  = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  res.json({ success: true, project });
});

/** POST /api/projects  – create new project */
app.post('/api/projects', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, error: 'Project name is required.' });
  }
  const project = {
    id: 'proj_' + Date.now(),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    standards: [],
    faculty: [],
    assignments: [],
    classrooms: [],
    selectedDays: [],
    timeSlotValues: [{ startTime: '', endTime: '' }],
    hardConstraints: [],
    softConstraints: [],
    scheduleData: null,
    scheduleStats: null,
    generatedFilename: null
  };
  const projects = loadUserProjects(req.user.email);
  projects.unshift(project);
  saveUserProjects(req.user.email, projects);
  console.log(`✓ Project created: "${project.name}" for ${req.user.email}`);
  res.json({ success: true, project });
});

/** PUT /api/projects/:id  – save/update project (inputs + optionally output) */
app.put('/api/projects/:id', requireAuth, (req, res) => {
  const projects = loadUserProjects(req.user.email);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Project not found.' });

  // ── Validate uniqueness of IDs in any input data being saved ──
  const body = req.body;

  if (body.faculty && Array.isArray(body.faculty)) {
    const ids   = body.faculty.map(f => f.id).filter(Boolean);
    const codes = body.faculty.map(f => (f.facultyCode||'').trim().toUpperCase()).filter(Boolean);
    const dupId   = ids.find((id, i) => ids.indexOf(id) !== i);
    const dupCode = codes.find((c, i) => codes.indexOf(c) !== i);
    if (dupId)   return res.status(400).json({ success: false, error: `Duplicate faculty ID "${dupId}" — faculty IDs must be unique.` });
    if (dupCode) return res.status(400).json({ success: false, error: `Duplicate faculty code — faculty codes must be unique.` });
  }

  if (body.standards && Array.isArray(body.standards)) {
    const stdIds = body.standards.map(s => s.id).filter(Boolean);
    const dupStd = stdIds.find((id, i) => stdIds.indexOf(id) !== i);
    if (dupStd) return res.status(400).json({ success: false, error: `Duplicate standard ID "${dupStd}".` });

    const allCourseIds   = body.standards.flatMap(s => (s.courses||[]).map(c => c.id)).filter(Boolean);
    const allCourseCodes = body.standards.flatMap(s => (s.courses||[]).map(c => (c.courseCode||'').trim().toUpperCase())).filter(Boolean);
    const dupCId   = allCourseIds.find((id, i) => allCourseIds.indexOf(id) !== i);
    const dupCCode = allCourseCodes.find((c, i) => allCourseCodes.indexOf(c) !== i);
    if (dupCId)   return res.status(400).json({ success: false, error: `Duplicate course ID "${dupCId}" — course IDs must be unique.` });
    if (dupCCode) return res.status(400).json({ success: false, error: `Duplicate course code — course codes must be unique.` });
  }

  if (body.classrooms && Array.isArray(body.classrooms)) {
    const names = body.classrooms.map(r => (r||'').trim().toUpperCase()).filter(Boolean);
    const dupRoom = names.find((n, i) => names.indexOf(n) !== i);
    if (dupRoom) return res.status(400).json({ success: false, error: `Duplicate classroom "${dupRoom}" — classroom names must be unique.` });
  }

  // Merge only the allowed fields
  const allowed = [
    'name', 'standards', 'faculty', 'assignments', 'classrooms',
    'selectedDays', 'timeSlotValues', 'hardConstraints', 'softConstraints',
    'breakTime', 'scheduleData', 'scheduleStats', 'generatedFilename'
  ];

  allowed.forEach(key => {
    if (req.body[key] !== undefined) {
      projects[idx][key] = req.body[key];
    }
  });

  projects[idx].updatedAt = new Date().toISOString();
  saveUserProjects(req.user.email, projects);
  res.json({ success: true, project: projects[idx] });
});

/** DELETE /api/projects/:id  – delete project */
app.delete('/api/projects/:id', requireAuth, (req, res) => {
  let projects = loadUserProjects(req.user.email);
  const exists = projects.some(p => p.id === req.params.id);
  if (!exists) return res.status(404).json({ success: false, error: 'Project not found.' });
  projects = projects.filter(p => p.id !== req.params.id);
  saveUserProjects(req.user.email, projects);
  res.json({ success: true });
});

/**
 * POST /api/generate-timetable
 * Body should include projectId so output is persisted to disk
 */
app.post('/api/generate-timetable', requireAuth, async (req, res) => {
  try {
    const {
      projectId, standards, faculty, assignments, classrooms,
      daysOfWeek, timeSlots, hardConstraints, softConstraints, breakTime
    } = req.body;

    console.log(`Timetable request from: ${req.user.email}`);
    console.log('Assignments:', assignments.length);

    const validation = validateInput({ standards, faculty, assignments, classrooms, daysOfWeek, timeSlots });
    if (!validation.isValid) {
      return res.status(400).json({ success: false, error: validation.errors.join(' | '), errors: validation.errors });
    }

    const feasibilityCheck = checkFeasibility({
      standards, assignments, classrooms, daysOfWeek, timeSlots,
      hardConstraints: hardConstraints || [], breakTime
    });
    if (!feasibilityCheck.isPossible) {
      return res.status(400).json({ success: false, impossible: true, error: feasibilityCheck.reason, reasons: feasibilityCheck.reasons });
    }

    const ga = new GeneticAlgorithm({
      standards, faculty, assignments, classrooms, daysOfWeek, timeSlots,
      hardConstraints: hardConstraints || [],
      softConstraints: softConstraints || [],
      breakTime: breakTime || null
    });

    // ga.run() blocks until ALL hard constraints are satisfied (conflicts === 0).
    // It will restart indefinitely — the feasibilityCheck above ensures a solution exists.
    const solution = ga.run();

    // Defensive check: should never be non-zero, but guard just in case
    if (solution.conflicts > 0) {
      console.error(`FATAL: GA returned with ${solution.conflicts} conflicts — this should not happen.`);
      return res.status(500).json({
        success: false,
        error: `Internal error: GA could not eliminate all hard constraint conflicts (${solution.conflicts} remaining). Please report this.`
      });
    }

    console.log(`✓ Valid timetable generated — 0 conflicts, fitness=${solution.fitness.toFixed(2)}`);

    const formattedData = formatSolution(solution, { standards, faculty, assignments, classrooms, daysOfWeek, timeSlots });

    const filename = `timetable_${Date.now()}.xlsx`;
    const filepath = path.join(outputDir, filename);
    await createExcelTimetable(formattedData, filepath);
    cleanupOldOutputFiles();

    const stats = {
      conflicts:  solution.conflicts,
      fitness:    solution.fitness.toFixed(2),
      classCount: solution.genes.length,
      softReport: solution.softReport || []
    };

    if (projectId) {
      const projects = loadUserProjects(req.user.email);
      const idx = projects.findIndex(p => p.id === projectId);
      if (idx !== -1) {
        projects[idx].scheduleData      = formattedData;
        projects[idx].scheduleStats     = stats;
        projects[idx].generatedFilename = filename;
        projects[idx].updatedAt         = new Date().toISOString();
        saveUserProjects(req.user.email, projects);
        console.log(`✓ Output saved to project "${projects[idx].name}"`);
      }
    }

    res.json({ success: true, filename, filepath: `/output/${filename}`, stats, data: formattedData });

  } catch (error) {
    console.error('Error generating timetable:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /output/:filename  – download Excel (protected)
 */
app.get('/output/:filename', requireAuth, (req, res) => {
  try {
    const filepath = path.join(outputDir, req.params.filename);
    // Security: prevent path traversal (e.g. "../../users.json")
    const resolved = path.resolve(filepath);
    if (!resolved.startsWith(path.resolve(outputDir))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.download(filepath, req.params.filename);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server running on port ' + PORT });
});

// ─────────────────────────────────────────────
// BUSINESS LOGIC (unchanged from original)
// ─────────────────────────────────────────────

function validateInput(data) {
  const errors = [];

  // ── Presence checks ──────────────────────────────────────────────────
  if (!data.standards   || data.standards.length   === 0) errors.push('At least one standard is required');
  if (!data.faculty     || data.faculty.length     === 0) errors.push('At least one faculty member is required');
  if (!data.assignments || data.assignments.length === 0) errors.push('At least one course assignment is required');
  if (!data.classrooms  || data.classrooms.length  === 0) errors.push('At least one classroom is required');
  if (!data.daysOfWeek  || data.daysOfWeek.length  === 0) errors.push('At least one day must be selected');
  if (!data.timeSlots   || data.timeSlots.length   === 0) errors.push('At least one time slot is required');

  // ── Faculty validation ───────────────────────────────────────────────
  const facultyIds   = [];
  const facultyCodes = [];
  const facultyNames = [];
  (data.faculty || []).forEach((f, i) => {
    const label = `Faculty ${i + 1}`;
    if (!f.id || !f.id.trim())
      errors.push(`${label}: Missing ID`);
    if (!f.name || !f.name.trim())
      errors.push(`${label}: Name cannot be empty`);
    if (!f.facultyCode || !f.facultyCode.trim())
      errors.push(`${label}: Faculty code cannot be empty`);

    if (f.id) {
      if (facultyIds.includes(f.id))
        errors.push(`Duplicate faculty ID "${f.id}" — every faculty member must have a unique ID`);
      else facultyIds.push(f.id);
    }
    if (f.facultyCode) {
      const code = f.facultyCode.trim().toUpperCase();
      if (facultyCodes.includes(code))
        errors.push(`Duplicate faculty code "${f.facultyCode}" — faculty codes must be unique`);
      else facultyCodes.push(code);
    }
    if (f.name) {
      const name = f.name.trim().toLowerCase();
      if (facultyNames.includes(name))
        errors.push(`Duplicate faculty name "${f.name}" — if intentional, use different codes to distinguish`);
      else facultyNames.push(name);
    }
  });

  // ── Standards & Courses validation ───────────────────────────────────
  const standardIds   = [];
  const standardNames = [];
  const courseIds     = [];
  const courseCodes   = [];
  (data.standards || []).forEach((s, si) => {
    const sLabel = `Standard ${si + 1}`;
    if (!s.id || !s.id.trim())
      errors.push(`${sLabel}: Missing ID`);
    if (!s.name || !s.name.trim())
      errors.push(`${sLabel}: Name cannot be empty`);
    if (!s.courses || s.courses.length === 0)
      errors.push(`${sLabel} ("${s.name || '?'}"): Must have at least one course`);

    if (s.id) {
      if (standardIds.includes(s.id))
        errors.push(`Duplicate standard ID "${s.id}"`);
      else standardIds.push(s.id);
    }
    if (s.name) {
      const name = s.name.trim().toLowerCase();
      if (standardNames.includes(name))
        errors.push(`Duplicate standard name "${s.name}"`);
      else standardNames.push(name);
    }

    (s.courses || []).forEach((c, ci) => {
      const cLabel = `Standard "${s.name || si + 1}" → Course ${ci + 1}`;
      if (!c.id || !c.id.trim())
        errors.push(`${cLabel}: Missing ID`);
      if (!c.name || !c.name.trim())
        errors.push(`${cLabel}: Name cannot be empty`);
      if (!c.courseCode || !c.courseCode.trim())
        errors.push(`${cLabel}: Course code cannot be empty`);

      if (c.id) {
        if (courseIds.includes(c.id))
          errors.push(`Duplicate course ID "${c.id}" — every course must have a unique ID`);
        else courseIds.push(c.id);
      }
      if (c.courseCode) {
        const code = c.courseCode.trim().toUpperCase();
        if (courseCodes.includes(code))
          errors.push(`Duplicate course code "${c.courseCode}" — course codes must be unique across all standards`);
        else courseCodes.push(code);
      }
    });
  });

  // ── Classroom validation ─────────────────────────────────────────────
  const classroomNames = [];
  (data.classrooms || []).forEach((room, i) => {
    if (!room || !room.trim()) {
      errors.push(`Classroom ${i + 1}: Name cannot be empty`);
      return;
    }
    const name = room.trim().toUpperCase();
    if (classroomNames.includes(name))
      errors.push(`Duplicate classroom "${room}" — classroom names must be unique`);
    else classroomNames.push(name);
  });

  // ── Time slot validation ─────────────────────────────────────────────
  const slotKeys = [];
  (data.timeSlots || []).forEach((slot, i) => {
    if (!slot.startTime || !slot.endTime) {
      errors.push(`Time slot ${i + 1}: Both start and end time are required`);
      return;
    }
    if (slot.startTime >= slot.endTime)
      errors.push(`Time slot ${i + 1}: Start time must be before end time`);
    const key = `${slot.startTime}-${slot.endTime}`;
    if (slotKeys.includes(key))
      errors.push(`Duplicate time slot ${slot.startTime}–${slot.endTime}`);
    else slotKeys.push(key);
  });

  // ── Assignment validation ────────────────────────────────────────────
  const assignmentIds  = [];
  const assignmentPairs = []; // courseId+facultyId combos
  (data.assignments || []).forEach((a, i) => {
    const label = `Assignment ${i + 1}`;
    if (!a.courseId)  errors.push(`${label}: No course selected`);
    if (!a.facultyId) errors.push(`${label}: No faculty selected`);

    // Check referenced IDs actually exist
    if (a.courseId && !courseIds.includes(a.courseId))
      errors.push(`${label}: References a course that does not exist`);
    if (a.facultyId && !facultyIds.includes(a.facultyId))
      errors.push(`${label}: References a faculty member that does not exist`);

    // No two assignments can assign the same course to the same teacher twice
    if (a.courseId && a.facultyId) {
      const pair = `${a.courseId}::${a.facultyId}`;
      if (assignmentPairs.includes(pair))
        errors.push(`${label}: This course is already assigned to this faculty member`);
      else assignmentPairs.push(pair);
    }

    if (a.id) {
      if (assignmentIds.includes(a.id))
        errors.push(`Duplicate assignment ID "${a.id}"`);
      else assignmentIds.push(a.id);
    }

    const tpw = parseInt(a.timesPerWeek);
    if (isNaN(tpw) || tpw < 1)
      errors.push(`${label}: Times per week must be at least 1`);
    const dayCount = (data.daysOfWeek || []).length;
    if (tpw > dayCount)
      errors.push(`${label}: Times per week (${tpw}) cannot exceed the number of selected days (${dayCount})`);
  });

  return { isValid: errors.length === 0, errors };
}

function checkFeasibility(data) {
  const reasons = [];
  const { assignments, classrooms, daysOfWeek, timeSlots, hardConstraints = [], breakTime } = data;

  // Work out how many first-half slots exist (for faculty_first_half_only constraint)
  const firstHalfCount = breakTime && breakTime.start
    ? timeSlots.filter(s => s.startTime < breakTime.start).length
    : timeSlots.length;

  const totalSlots  = classrooms.length * daysOfWeek.length * timeSlots.length;
  let totalNeeded   = 0;
  assignments.forEach(a => { totalNeeded += parseInt(a.timesPerWeek || 1); });

  if (totalNeeded > totalSlots) {
    reasons.push(
      `Need ${totalNeeded} class slots but only ${totalSlots} available ` +
      `(${classrooms.length} classrooms × ${daysOfWeek.length} days × ${timeSlots.length} slots). ` +
      `Add more classrooms, days, or time slots.`
    );
  }

  // Per-faculty feasibility — check if first-half-only faculty have enough slots
  const facultyLoad = {};
  assignments.forEach(a => {
    facultyLoad[a.facultyId] = (facultyLoad[a.facultyId] || 0) + parseInt(a.timesPerWeek || 1);
  });

  const firstHalfOnlyFaculty = new Set(
    (hardConstraints || [])
      .filter(hc => hc.type === 'faculty_first_half_only')
      .map(hc => hc.facultyId)
  );

  Object.entries(facultyLoad).forEach(([facId, load]) => {
    const maxSlots = firstHalfOnlyFaculty.has(facId)
      ? classrooms.length * daysOfWeek.length * firstHalfCount
      : classrooms.length * daysOfWeek.length * timeSlots.length;
    if (load > maxSlots) {
      reasons.push(
        `Faculty "${facId}" needs to teach ${load} classes but only has ${maxSlots} available slots` +
        (firstHalfOnlyFaculty.has(facId) ? ` (first-half-only constraint active)` : ``)
      );
    }
  });

  // Faculty unavailability — subtract blocked slots per faculty
  const blockedSlots = {}; // facultyId → count of blocked (day,slot) pairs
  (hardConstraints || []).forEach(hc => {
    if (hc.type !== 'faculty_unavailability') return;
    const dayIdx  = daysOfWeek.indexOf(hc.day);
    if (dayIdx === -1) return;
    const slotCount = hc.timeslot
      ? 1
      : timeSlots.length;
    blockedSlots[hc.facultyId] = (blockedSlots[hc.facultyId] || 0) + (classrooms.length * slotCount);
  });

  Object.entries(facultyLoad).forEach(([facId, load]) => {
    const blocked  = blockedSlots[facId] || 0;
    const maxSlots = classrooms.length * daysOfWeek.length * timeSlots.length - blocked;
    if (load > maxSlots) {
      reasons.push(`Faculty "${facId}" needs ${load} classes but unavailability constraints leave only ${maxSlots} valid slots.`);
    }
  });

  // Per-standard feasibility — a standard can only have ONE class per timeslot
  // (regardless of how many classrooms exist), so maxSlots = days × timeslots.
  if (data.standards && Array.isArray(data.standards)) {
    const maxSlotsPerStandard = daysOfWeek.length * timeSlots.length;
    data.standards.forEach(std => {
      const courseIds = (std.courses || []).map(c => c.id);
      let needed = 0;
      assignments.forEach(a => {
        if (courseIds.includes(a.courseId)) {
          needed += parseInt(a.timesPerWeek || 1);
        }
      });
      if (needed > maxSlotsPerStandard) {
        reasons.push(
          `Standard "${std.name}" needs ${needed} class slots but only ${maxSlotsPerStandard} exist ` +
          `(${daysOfWeek.length} days × ${timeSlots.length} slots). ` +
          `A standard can only attend one class per timeslot. Add more days or time slots.`
        );
      }
    });
  }

  if (reasons.length > 0) {
    return {
      isPossible: false,
      reason: '❌ IMPOSSIBLE TIMETABLE:\n' + reasons.map((r, i) => `${i + 1}. ${r}`).join('\n'),
      reasons
    };
  }

  return { isPossible: true, reason: null, reasons: [] };
}

function formatSolution(solution, metadata) {
  const schedule = {};
  metadata.daysOfWeek.forEach(day => { schedule[day] = []; });

  solution.genes.forEach(gene => {
    const day       = metadata.daysOfWeek[gene.dayIdx];
    const timeSlot  = metadata.timeSlots[gene.timeSlotIdx];
    const classroom = metadata.classrooms[gene.classroomIdx];

    let courseName = '', courseCode = '', standardName = '';
    const standard = metadata.standards.find(s => s.courses && s.courses.some(c => c.id === gene.courseId));
    if (standard) {
      standardName = standard.name;
      const course = standard.courses.find(c => c.id === gene.courseId);
      if (course) { courseName = course.name; courseCode = course.courseCode; }
    }

    const faculty = metadata.faculty.find(f => f.id === gene.facultyId);

    schedule[day].push({
      timeSlot,
      startTime:   timeSlot.startTime,
      endTime:     timeSlot.endTime,
      standard:    standardName,
      course:      courseName,
      courseCode,
      faculty:     faculty ? faculty.name : '',
      facultyCode: faculty ? faculty.facultyCode : '',
      classroom
    });
  });

  Object.keys(schedule).forEach(day => {
    schedule[day].sort((a, b) => a.startTime.localeCompare(b.startTime));
  });

  return schedule;
}

/**
 * Convert a 0-based column index to an Excel column name (0→A, 25→Z, 26→AA, etc.)
 * Handles any number of columns — no more overflow past 'Z'.
 */
function excelColName(idx) {
  let name = '';
  let n = idx;
  while (true) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return name;
}

async function createExcelTimetable(schedule, filepath) {
  const workbook  = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Timetable');

  const days = Object.keys(schedule);
  const allTimeSlots = new Set();
  Object.values(schedule).forEach(dayClasses => {
    dayClasses.forEach(cls => { allTimeSlots.add(cls.startTime); });
  });
  const timeSlots = Array.from(allTimeSlots).sort();

  // Fixed columns: A=Day, B=Class/Standard, C=Cap#.  Time slot columns start at D (index 3).
  worksheet.getColumn('A').width = 12;
  worksheet.getColumn('B').width = 25;
  worksheet.getColumn('C').width = 12;
  for (let i = 3; i < 3 + timeSlots.length; i++) {
    worksheet.getColumn(i + 1).width = 18; // ExcelJS columns are 1-based
  }

  const lastColName = excelColName(2 + timeSlots.length); // 0-based: col 0=A, col 1=B, col 2=C, col 3=D...
  worksheet.mergeCells(`A1:${lastColName}1`);
  const infoCell = worksheet.getCell('A1');
  infoCell.value = 'Time mentioned is corresponding to the left cell boundary. Each cell is of 15 minutes duration.';
  infoCell.font  = { size: 10, italic: true };
  infoCell.alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
  worksheet.getRow(1).height = 30;

  worksheet.getCell('A2').value = 'Day';
  worksheet.getCell('B2').value = 'Class/Standard';
  worksheet.getCell('C2').value = 'Cap #';
  timeSlots.forEach((time, idx) => {
    const col = excelColName(3 + idx); // D, E, F, ...
    worksheet.getCell(`${col}2`).value = time;
  });

  // Style header row (columns A through last time-slot column)
  const totalCols = 3 + timeSlots.length; // A, B, C + time slots
  for (let ci = 0; ci < totalCols; ci++) {
    const cell = worksheet.getCell(`${excelColName(ci)}2`);
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    cell.font  = { bold: true };
    cell.alignment = { horizontal: 'center', vertical: 'center' };
    cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
  }

  let currentRow = 3;
  const colors   = ['FFFCE4d6', 'FFDDEBF7', 'FFe2efda', 'FFfce4d6'];
  let colorIdx   = 0;

  days.forEach(day => {
    const dayClasses = schedule[day];
    const standards  = [...new Set(dayClasses.map(c => c.standard))];

    standards.forEach((standard, stdIdx) => {
      const stdClasses = dayClasses.filter(c => c.standard === standard);
      const rowHeight  = Math.max(15, stdClasses.length * 20);

      if (stdIdx === 0) {
        const dayCell = worksheet.getCell(`A${currentRow}`);
        dayCell.value = day;
        dayCell.font  = { bold: true, size: 11 };
        dayCell.alignment = { horizontal: 'center', vertical: 'top' };
        worksheet.mergeCells(`A${currentRow}:A${currentRow + standards.length - 1}`);
      }

      worksheet.getCell(`B${currentRow}`).value = standard;
      worksheet.getCell(`B${currentRow}`).alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
      worksheet.getCell(`C${currentRow}`).value = stdClasses.length;
      worksheet.getCell(`C${currentRow}`).alignment = { horizontal: 'center', vertical: 'top' };

      timeSlots.forEach((time, timeIdx) => {
        const col  = excelColName(3 + timeIdx);
        const cell = worksheet.getCell(`${col}${currentRow}`);
        const classesAtTime = stdClasses.filter(c => c.startTime === time);
        if (classesAtTime.length > 0) {
          const cls  = classesAtTime[0];
          cell.value = `${cls.course} (${cls.faculty})\n${cls.classroom}`;
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors[colorIdx % colors.length] } };
        } else {
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
        }
        cell.alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
        cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
      });

      worksheet.getRow(currentRow).height = rowHeight;
      currentRow++;
      colorIdx++;
    });
  });

  await workbook.xlsx.writeFile(filepath);
  console.log('Excel file created:', filepath);
}

/**
 * Clean up old output files — keep only the 20 most recent .xlsx files.
 * Called after each new file is created.
 */
function cleanupOldOutputFiles() {
  try {
    const files = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.xlsx'))
      .map(f => ({ name: f, time: fs.statSync(path.join(outputDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time); // newest first

    const MAX_KEEP = 20;
    if (files.length > MAX_KEEP) {
      files.slice(MAX_KEEP).forEach(f => {
        fs.unlinkSync(path.join(outputDir, f.name));
        console.log(`🧹 Cleaned up old output: ${f.name}`);
      });
    }
  } catch (err) {
    console.error('Cleanup error (non-fatal):', err.message);
  }
}

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✓ Server running on http://localhost:${PORT}`);
  if (!GOOGLE_CLIENT_ID) {
    console.warn(`⚠ GOOGLE_CLIENT_ID is not set – Google Sign-In will not work until it is configured.`);
  } else {
    console.log(`✓ Google Sign-In enabled`);
  }
  console.log(`✓ POST http://localhost:${PORT}/api/auth/google`);
  console.log(`✓ POST http://localhost:${PORT}/api/generate-timetable  (requires auth)`);
  console.log(`✓ Output files saved to: ${outputDir}\n`);
});

module.exports = app;