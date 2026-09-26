require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const ExcelJS  = require('exceljs');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const { Worker } = require('worker_threads');
const { OAuth2Client } = require('google-auth-library');
const { buildDemoSchool } = require('./demo-data');

const app  = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const JWT_SECRET      = process.env.JWT_SECRET || 'timetable_secret_change_me_in_production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient    = new OAuth2Client(GOOGLE_CLIENT_ID);

// Sessions: a short-lived access token held only in the page's memory, plus a
// long-lived httpOnly refresh cookie. That keeps you signed in across reloads
// and restarts (the thing sessionStorage could never do) without ever handing
// JavaScript a credential that is useful for more than half an hour.
const ACCESS_TTL     = '30m';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_COOKIE = 'sch_rt';

function signAccessToken(user) {
  return jwt.sign({ email: user.email, name: user.name, typ: 'access' }, JWT_SECRET, { expiresIn: ACCESS_TTL });
}

function signRefreshToken(user) {
  return jwt.sign({ email: user.email, name: user.name, typ: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TTL_MS / 1000 });
}

/** Read one cookie. express gives us res.cookie but not a parser for requests. */
function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

function setRefreshCookie(req, res, user) {
  res.cookie(REFRESH_COOKIE, signRefreshToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure:   req.secure,          // needs trust proxy so Railway's TLS counts
    maxAge:   REFRESH_TTL_MS,
    path:     '/'
  });
}

function clearRefreshCookie(req, res) {
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
}

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────
// Railway (and any reverse proxy) terminates TLS upstream; without this
// req.secure is always false and the session cookie never gets the Secure flag.
app.set('trust proxy', 1);

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// ─────────────────────────────────────────────
// PAGE ROUTES — real, linkable URLs
// ─────────────────────────────────────────────
// Every screen now has an address: /login, /projects, /projects/:id/:step and
// /s/:shareId. Registered before express.static so the old .html paths redirect
// instead of being served — a bookmarked /index.html used to open an editor
// with no project attached.
const STEP_SLUGS = ['standards', 'teachers', 'classrooms', 'timetable', 'assignments', 'rules', 'schedule'];
const sendPage = file => (req, res) => res.sendFile(path.join(__dirname, 'public', file));

app.get('/',               (req, res) => res.redirect('/projects'));
app.get('/index.html',     (req, res) => res.redirect('/projects'));
app.get('/dashboard.html', (req, res) => res.redirect('/projects'));
app.get('/login.html',     (req, res) => res.redirect('/login'));

app.get('/login',    sendPage('login.html'));
app.get('/projects', sendPage('dashboard.html'));
app.get('/projects/:id', (req, res) => res.redirect(`/projects/${encodeURIComponent(req.params.id)}/standards`));
app.get('/projects/:id/:step', (req, res, next) => {
  if (!STEP_SLUGS.includes(req.params.step)) return next();
  sendPage('index.html')(req, res);
});
app.get('/s/:shareId', sendPage('shared.html'));

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

const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

/**
 * Find a project by its public share id, across every user's file.
 *
 * Projects are stored per-user, so a share id has no home of its own — scanning
 * the data directory is the honest way to resolve one at this scale. If this ever
 * grows past a few hundred files it wants a share-id → file index instead.
 */
function findSharedProject(shareId) {
  if (!shareId) return null;
  let files;
  try { files = fs.readdirSync(dataDir).filter(f => f.startsWith('projects_') && f.endsWith('.json')); }
  catch { return null; }

  for (const file of files) {
    let projects;
    try { projects = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8')); }
    catch { continue; }
    const hit = (projects || []).find(p => !p.deletedAt && p.share && p.share.enabled && p.share.id === shareId);
    if (hit) return hit;
  }
  return null;
}

// ─────────────────────────────────────────────
// SCHEMA HELPERS / MIGRATION
// ─────────────────────────────────────────────

/** Collision-resistant id (Date.now() alone collides within the same millisecond) */
function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Classroom names, in order — for code that still works with plain names. */
function classroomNames(classrooms) {
  return (classrooms || []).map(r => (typeof r === 'string' ? r : (r && r.name) || ''));
}

/**
 * Bring a project up to the current schema, in place.
 *
 * v1 → v2 changes:
 *   - classrooms: ["Room 1"]        → [{ id, name }]
 *   - standards:  gain `divisions`  → [{ id, label, roomId }]  (one "A" per standard)
 *   - assignments: gain `divisionId` (pointed at its standard's only division)
 *   - hardConstraints: `room_restriction` dropped — every class now sits in its
 *     division's own room, so a per-course room rule can no longer be honoured.
 *
 * Returns true when something was rewritten, so the caller can persist it.
 */
function migrateProject(project) {
  let changed = false;

  // ── classrooms → objects ──
  if (Array.isArray(project.classrooms)) {
    project.classrooms = project.classrooms.map(room => {
      if (typeof room === 'string') {
        changed = true;
        return { id: uid('room'), name: room };
      }
      if (room && !room.id) { changed = true; return { id: uid('room'), name: room.name || '' }; }
      return room;
    });
  } else if (project.classrooms === undefined) {
    project.classrooms = [];
  }

  // ── standards gain divisions; each division claims a distinct room ──
  const takenRoomIds = new Set(
    (project.standards || []).flatMap(s => (s.divisions || []).map(d => d.roomId)).filter(Boolean)
  );
  const freeRoom = () => {
    const room = (project.classrooms || []).find(r => !takenRoomIds.has(r.id));
    if (room) takenRoomIds.add(room.id);
    return room ? room.id : null;
  };

  (project.standards || []).forEach(std => {
    if (!Array.isArray(std.divisions) || std.divisions.length === 0) {
      changed = true;
      std.divisions = [{ id: uid('div'), label: 'A', roomId: freeRoom() }];
    }
  });

  // ── assignments gain divisionId (resolved via the course's owning standard) ──
  if (Array.isArray(project.assignments)) {
    const divisionForCourse = {};
    (project.standards || []).forEach(std => {
      const firstDivision = (std.divisions || [])[0];
      (std.courses || []).forEach(c => {
        if (firstDivision) divisionForCourse[c.id] = firstDivision.id;
      });
    });

    project.assignments.forEach(a => {
      if (!a.divisionId) {
        const divisionId = divisionForCourse[a.courseId];
        if (divisionId) { a.divisionId = divisionId; changed = true; }
      }
    });
  }

  // ── drop the now-meaningless room_restriction rules ──
  if (Array.isArray(project.hardConstraints)) {
    const kept = project.hardConstraints.filter(hc => hc.type !== 'room_restriction');
    if (kept.length !== project.hardConstraints.length) {
      project.hardConstraints = kept;
      changed = true;
    }
  }

  return changed;
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
    return res.status(401).json({ success: false, error: 'Unauthorized – please log in.', code: 'no_token' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.typ && decoded.typ !== 'access') {
      return res.status(401).json({ success: false, error: 'Wrong token type.', code: 'bad_token' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    // The client reacts differently to these: an expired access token is
    // refreshed silently, anything else means sign in again.
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({
      success: false,
      error: expired ? 'Access token expired.' : 'Invalid session.',
      code:  expired ? 'token_expired' : 'bad_token'
    });
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

    setRefreshCookie(req, res, { email, name });
    const token = signAccessToken({ email, name });

    console.log(`✓ Google login: ${email}`);
    res.json({ success: true, token, email, name });

  } catch (err) {
    console.error('Google login error:', err);
    res.status(401).json({ success: false, error: 'Google sign-in failed. Please try again.' });
  }
});

/**
 * POST /api/auth/refresh
 * Trades the httpOnly refresh cookie for a fresh access token. This is what
 * makes a reload (or coming back tomorrow) keep you signed in.
 */
app.post('/api/auth/refresh', (req, res) => {
  const raw = readCookie(req, REFRESH_COOKIE);
  if (!raw) return res.status(401).json({ success: false, error: 'No session.' });

  try {
    const decoded = jwt.verify(raw, JWT_SECRET);
    if (decoded.typ !== 'refresh') throw new Error('not a refresh token');
    const user = { email: decoded.email, name: decoded.name };
    // Rolling expiry: active users never get logged out mid-use.
    setRefreshCookie(req, res, user);
    res.json({ success: true, token: signAccessToken(user), email: user.email, name: user.name });
  } catch {
    clearRefreshCookie(req, res);
    res.status(401).json({ success: false, error: 'Session expired – please sign in again.' });
  }
});

/**
 * POST /api/logout – clears the refresh cookie so the session really ends.
 */
app.post('/api/logout', (req, res) => {
  clearRefreshCookie(req, res);
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
  let projects = loadUserProjects(req.user.email);

  // Deletes are soft for 30 days so "Undo" can actually put a project back.
  // Anything older than that is dropped here, on the next visit.
  const cutoff = Date.now() - TRASH_TTL_MS;
  const kept = projects.filter(p => !p.deletedAt || new Date(p.deletedAt).getTime() > cutoff);
  if (kept.length !== projects.length) {
    saveUserProjects(req.user.email, kept);
    projects = kept;
  }
  projects = projects.filter(p => !p.deletedAt);
  // Return list without bulky scheduleData to keep response small
  const summary = projects.map(p => ({
    id: p.id,
    name: p.name,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastGeneratedAt: p.lastGeneratedAt || null,
    hasOutput: !!p.scheduleData,
    shared: !!(p.share && p.share.enabled),
    counts: {
      standards: (p.standards || []).length,
      divisions: (p.standards || []).reduce((n, s) => n + (s.divisions || []).length, 0),
      faculty:   (p.faculty || []).length,
      classes:   p.scheduleStats ? Number(p.scheduleStats.classCount) || 0 : 0
    }
  }));
  res.json({ success: true, projects: summary });
});

/** GET /api/projects/:id  – get full project (with inputs + output) */
app.get('/api/projects/:id', requireAuth, (req, res) => {
  const projects = loadUserProjects(req.user.email);
  const project  = projects.find(p => p.id === req.params.id && !p.deletedAt);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

  // Older projects predate divisions / classroom objects — upgrade on read so the
  // client only ever deals with the current shape, and persist it once.
  if (migrateProject(project)) {
    saveUserProjects(req.user.email, projects);
    console.log(`↻ Migrated project "${project.name}" to the divisions schema`);
  }

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
  const idx = projects.findIndex(p => p.id === req.params.id && !p.deletedAt);
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

    // Divisions: ids unique across the whole project, and one room serves one division
    const divIds = body.standards.flatMap(s => (s.divisions||[]).map(d => d.id)).filter(Boolean);
    const dupDiv = divIds.find((id, i) => divIds.indexOf(id) !== i);
    if (dupDiv) return res.status(400).json({ success: false, error: `Duplicate division ID "${dupDiv}".` });

    const roomIds = body.standards.flatMap(s => (s.divisions||[]).map(d => d.roomId)).filter(Boolean);
    const dupRoomUse = roomIds.find((id, i) => roomIds.indexOf(id) !== i);
    if (dupRoomUse) {
      const roomName = (body.classrooms || []).find(r => r && r.id === dupRoomUse);
      return res.status(400).json({
        success: false,
        error: `Classroom "${roomName ? roomName.name : dupRoomUse}" is assigned to more than one division — each division needs its own room.`
      });
    }
  }

  if (body.classrooms && Array.isArray(body.classrooms)) {
    const ids = body.classrooms.map(r => r && r.id).filter(Boolean);
    const dupId = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dupId) return res.status(400).json({ success: false, error: `Duplicate classroom ID "${dupId}".` });

    const names = classroomNames(body.classrooms).map(n => n.trim().toUpperCase()).filter(Boolean);
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

/**
 * POST /api/projects/:id/share  – create (or re-enable) a public read-only link
 *
 * A timetable exists to be handed to 27 teachers and 18 classes, so there has to
 * be a way out of the app that isn't "download a file and email it". The link
 * exposes the generated schedule only — never the inputs, the constraints, or
 * anything else on the project.
 */
app.post('/api/projects/:id/share', requireAuth, (req, res) => {
  const projects = loadUserProjects(req.user.email);
  const project  = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

  if (!project.share || !project.share.id) {
    project.share = { id: crypto.randomBytes(9).toString('base64url'), createdAt: new Date().toISOString(), enabled: true };
  } else {
    project.share.enabled = true;
  }
  saveUserProjects(req.user.email, projects);
  res.json({ success: true, share: project.share });
});

/** DELETE /api/projects/:id/share  – turn the public link off (id is kept) */
app.delete('/api/projects/:id/share', requireAuth, (req, res) => {
  const projects = loadUserProjects(req.user.email);
  const project  = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  if (project.share) project.share.enabled = false;
  saveUserProjects(req.user.email, projects);
  res.json({ success: true, share: project.share || null });
});

/**
 * GET /api/shared/:shareId  – public, no auth. Returns the schedule only.
 */
app.get('/api/shared/:shareId', (req, res) => {
  const found = findSharedProject(req.params.shareId);
  if (!found) return res.status(404).json({ success: false, error: 'This link is no longer active.' });

  res.json({
    success: true,
    name: found.name,
    generatedAt: found.lastGeneratedAt || found.updatedAt || null,
    schedule: found.scheduleData || null,
    stats: found.scheduleStats
      ? { classCount: found.scheduleStats.classCount, conflicts: found.scheduleStats.conflicts }
      : null
  });
});

/**
 * DELETE /api/projects/:id  – move to trash (or ?purge=1 to erase now)
 *
 * Soft by default. The id survives, so restoring keeps the project's URL and
 * any share link working — which is what makes the Undo on the dashboard a real
 * undo rather than a re-creation that quietly loses both.
 */
app.delete('/api/projects/:id', requireAuth, (req, res) => {
  let projects = loadUserProjects(req.user.email);
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Project not found.' });

  if (req.query.purge === '1') {
    projects = projects.filter(p => p.id !== req.params.id);
  } else {
    projects[idx].deletedAt = new Date().toISOString();
    // A trashed project stops being publicly reachable immediately. The flag
    // records that the delete is what switched it off, so restoring can put it
    // back — an undo that silently leaves the link dead is not an undo.
    if (projects[idx].share && projects[idx].share.enabled) {
      projects[idx].share.enabled = false;
      projects[idx].share.disabledByDelete = true;
    }
  }
  saveUserProjects(req.user.email, projects);
  res.json({ success: true });
});

/** POST /api/projects/:id/restore  – undo a delete */
app.post('/api/projects/:id/restore', requireAuth, (req, res) => {
  const projects = loadUserProjects(req.user.email);
  const project  = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  delete project.deletedAt;
  if (project.share && project.share.disabledByDelete) {
    project.share.enabled = true;
    delete project.share.disabledByDelete;
  }
  saveUserProjects(req.user.email, projects);
  res.json({ success: true, project: { id: project.id, name: project.name } });
});

// ─────────────────────────────────────────────
// GENERATION JOBS
// ─────────────────────────────────────────────
//
// The GA has no time limit by design, so it cannot run inside the request. Each
// run becomes a job on a worker thread: the client starts it, polls progress,
// and can cancel — all of which are impossible while the main thread is blocked.

const jobs = new Map();          // jobId -> job
const JOB_RETENTION_MS = 10 * 60 * 1000;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - job.finishedAt > JOB_RETENTION_MS) jobs.delete(id);
  }
}

/**
 * Where the schedule is under pressure. Computed from the inputs alone, so it
 * is available even while the GA is still searching — this is what the UI shows
 * once a run starts taking a long time.
 */
function buildDiagnostics(data) {
  const { standards = [], faculty = [], assignments = [], daysOfWeek = [], timeSlots = [], hardConstraints = [], breakTime } = data;
  const slotsPerWeek = daysOfWeek.length * timeSlots.length;
  if (!slotsPerWeek) return { tight: [], suggestions: [] };

  const firstHalfCount = breakTime && breakTime.start
    ? timeSlots.filter(s => s.startTime < breakTime.start).length
    : timeSlots.length;

  const halfOnly = new Map();
  const blocked  = {};
  hardConstraints.forEach(hc => {
    if (hc.type === 'faculty_first_half_only')  halfOnly.set(hc.facultyId, 'first');
    if (hc.type === 'faculty_second_half_only') halfOnly.set(hc.facultyId, 'second');
    if (hc.type === 'faculty_unavailability' && daysOfWeek.includes(hc.day)) {
      if (hc.timeslot && !timeSlots.some(s => s.startTime === hc.timeslot)) return;
      blocked[hc.facultyId] = (blocked[hc.facultyId] || 0) + (hc.timeslot ? 1 : timeSlots.length);
    }
  });

  const tight = [];

  // Teacher pressure
  const load = {};
  assignments.forEach(a => { load[a.facultyId] = (load[a.facultyId] || 0) + parseInt(a.timesPerWeek || 1); });
  Object.entries(load).forEach(([facId, used]) => {
    const half    = halfOnly.get(facId);
    const cap     = (half === 'first'  ? daysOfWeek.length * firstHalfCount
                  :  half === 'second' ? daysOfWeek.length * (timeSlots.length - firstHalfCount)
                  :  slotsPerWeek) - (blocked[facId] || 0);
    const f = faculty.find(x => x.id === facId);
    if (cap > 0 && used / cap >= 0.8) {
      tight.push({ kind: 'faculty', name: f ? f.name : facId, used, capacity: cap,
                   percent: Math.round((used / cap) * 100) });
    }
  });

  // Division pressure
  const divLoad = {};
  assignments.forEach(a => { if (a.divisionId) divLoad[a.divisionId] = (divLoad[a.divisionId] || 0) + parseInt(a.timesPerWeek || 1); });
  standards.forEach(std => (std.divisions || []).forEach(d => {
    const used = divLoad[d.id] || 0;
    if (used / slotsPerWeek >= 0.8) {
      tight.push({ kind: 'division', name: `${std.name}-${d.label}`, used, capacity: slotsPerWeek,
                   percent: Math.round((used / slotsPerWeek) * 100) });
    }
  }));

  tight.sort((a, b) => b.percent - a.percent);

  const suggestions = [];
  const worst = tight[0];
  if (worst && worst.percent >= 95) {
    suggestions.push(worst.kind === 'faculty'
      ? `${worst.name} is booked ${worst.used} of ${worst.capacity} periods (${worst.percent}%) — with almost no free slots there is very little room to resolve clashes. Reduce their load or spread it over more teachers.`
      : `${worst.name} fills ${worst.used} of ${worst.capacity} periods (${worst.percent}%) — an almost completely full week leaves nowhere to move classes.`);
  }
  if (tight.some(t => t.kind === 'faculty' && t.percent >= 90))
    suggestions.push('Add another time slot to the day, or an extra working day — even one more slot gives the scheduler far more freedom.');
  if (tight.filter(t => t.kind === 'faculty').length >= 3)
    suggestions.push('Several teachers are near capacity. Adding one more faculty member and splitting a subject between them usually resolves this quickly.');
  if (hardConstraints.length >= 3)
    suggestions.push(`You have ${hardConstraints.length} hard constraints. Temporarily relaxing the least important one is often enough to unlock a solution.`);
  if (suggestions.length === 0)
    suggestions.push('Nothing looks obviously over-booked, so the clash is likely a specific combination of constraints. Try relaxing one hard constraint, or add a time slot.');

  return { tight: tight.slice(0, 6), suggestions };
}

/**
 * GET /api/demo-data – a ready-made sample school for trying the app out.
 * Feasible by construction (see demo-data.js), so the demo can't land on an
 * unsolvable configuration.
 */
app.get('/api/demo-data', requireAuth, (req, res) => {
  try {
    const school = buildDemoSchool();
    delete school._layout;          // internal scaffolding, not part of a project
    res.json({ success: true, data: school });
  } catch (err) {
    console.error('Demo data generation failed:', err);
    res.status(500).json({ success: false, error: 'Could not build the demo data.' });
  }
});

/** Spawn a GA worker and register it as a job. Returns the job id. */
function startWorkerJob({ owner, projectId, gaInput, mode, seedGenes }) {
  const jobId = uid('job');
  const job = {
    id: jobId,
    owner,
    mode,
    projectId: projectId || null,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    progress: { attempt: 1, generation: 0, totalGenerations: 0, conflicts: null, fitness: null },
    diagnostics: buildDiagnostics(gaInput),
    meta: gaInput,
    result: null,
    error: null,
    worker: null
  };
  jobs.set(jobId, job);

  const worker = new Worker(path.join(__dirname, 'ga-worker.js'), {
    workerData: { ...gaInput, mode, seedGenes: seedGenes || null }
  });
  job.worker = worker;

  worker.on('message', async msg => {
    if (msg.type === 'progress') { job.progress = msg; return; }
    if (msg.type === 'error') {
      job.status = 'error'; job.error = msg.message; job.finishedAt = Date.now();
      return;
    }
    if (msg.type === 'done') {
      try {
        await finishJob(job, msg.solution);
      } catch (err) {
        job.status = 'error'; job.error = err.message; job.finishedAt = Date.now();
        console.error('Post-processing failed:', err);
      }
    }
  });

  worker.on('error', err => {
    job.status = 'error'; job.error = err.message; job.finishedAt = Date.now();
    console.error('GA worker error:', err);
  });

  worker.on('exit', () => {
    if (job.status === 'running') {
      job.status = 'error';
      job.error  = job.error || 'The scheduler stopped unexpectedly.';
      job.finishedAt = Date.now();
    }
    job.worker = null;
  });

  return jobId;
}

/**
 * POST /api/generate-timetable
 * Validates, then starts a worker job. Responds immediately with a jobId.
 */
app.post('/api/generate-timetable', requireAuth, (req, res) => {
  try {
    const {
      projectId, standards, faculty, assignments, classrooms,
      daysOfWeek, timeSlots, hardConstraints, softConstraints, breakTime
    } = req.body;

    console.log(`Timetable request from: ${req.user.email} (${(assignments || []).length} assignments)`);

    const validation = validateInput({ standards, faculty, assignments, classrooms, daysOfWeek, timeSlots });
    if (!validation.isValid) {
      return res.status(400).json({ success: false, error: validation.errors.join(' | '), errors: validation.errors });
    }

    const feasibilityCheck = checkFeasibility({
      standards, faculty, assignments, classrooms, daysOfWeek, timeSlots,
      hardConstraints: hardConstraints || [], breakTime
    });
    if (!feasibilityCheck.isPossible) {
      return res.status(400).json({ success: false, impossible: true, error: feasibilityCheck.reason, reasons: feasibilityCheck.reasons });
    }

    pruneJobs();

    const gaInput = {
      standards, faculty, assignments, classrooms, daysOfWeek, timeSlots,
      hardConstraints: hardConstraints || [],
      softConstraints: softConstraints || [],
      breakTime: breakTime || null
    };

    const jobId = startWorkerJob({ owner: req.user.email, projectId, gaInput, mode: 'generate' });

    res.status(202).json({ success: true, jobId });

  } catch (error) {
    console.error('Error starting generation:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/** Turn a finished solution into the Excel file + saved project output. */
async function finishJob(job, solution) {
  const m = job.meta;

  if (solution.conflicts > 0) {
    job.status = 'error';
    job.error  = `Internal error: the scheduler returned ${solution.conflicts} unresolved conflict(s).`;
    job.finishedAt = Date.now();
    return;
  }

  const formattedData = formatSolution(solution, m);
  const filename = `timetable_${Date.now()}.xlsx`;
  await createExcelTimetable(formattedData, path.join(outputDir, filename));
  cleanupOldOutputFiles();

  const softReport = solution.softReport || [];
  const stats = {
    conflicts:  solution.conflicts,
    fitness:    Number(solution.fitness).toFixed(2),
    classCount: solution.genes.length,
    softReport,
    // Headline soft score, used for the before/after comparison after an improve run
    softMet:     softReport.filter(r => r.satisfied).length,
    softTotal:   softReport.length,
    softPenalty: solution.softPenalty
  };

  if (job.projectId) {
    const projects = loadUserProjects(job.owner);
    const idx = projects.findIndex(p => p.id === job.projectId);
    if (idx !== -1) {
      projects[idx].scheduleData      = formattedData;
      projects[idx].scheduleStats     = stats;
      // Raw genes are kept so "Improve schedule" can reseed from this solution
      // after a page reload, rather than only within the same session.
      projects[idx].scheduleGenes     = solution.genes;
      projects[idx].generatedFilename = filename;
      projects[idx].updatedAt         = new Date().toISOString();
      projects[idx].lastGeneratedAt   = projects[idx].updatedAt;

      // A short run history, so a schedule has a past and not only a present —
      // "last generated Thursday, 540 classes, 0 conflicts" is most of what
      // makes a tool feel lived-in rather than freshly booted.
      const run = {
        id:          uid('run'),
        at:          projects[idx].updatedAt,
        mode:        job.mode === 'improve' ? 'improve' : 'generate',
        durationMs:  Date.now() - job.startedAt,
        classCount:  stats.classCount,
        conflicts:   stats.conflicts,
        fitness:     stats.fitness,
        softMet:     stats.softMet,
        softTotal:   stats.softTotal,
        softPenalty: stats.softPenalty
      };
      projects[idx].runs = [run, ...(projects[idx].runs || [])].slice(0, 12);

      saveUserProjects(job.owner, projects);
    }
  }

  job.result = { filename, filepath: `/output/${filename}`, stats, data: formattedData, genes: solution.genes };
  job.status = 'done';
  job.finishedAt = Date.now();
  console.log(`✓ Job ${job.id} finished — 0 conflicts, ${solution.genes.length} classes in ${Date.now() - job.startedAt}ms`);
}

/**
 * POST /api/improve-timetable
 * Spends more time reducing soft-constraint penalties on a schedule that already
 * satisfies every hard constraint. Never returns something worse than the seed.
 */
app.post('/api/improve-timetable', requireAuth, (req, res) => {
  try {
    const {
      projectId, standards, faculty, assignments, classrooms,
      daysOfWeek, timeSlots, hardConstraints, softConstraints, breakTime
    } = req.body;

    let seedGenes = req.body.genes;

    // Fall back to the genes stored on the project (survives a page reload)
    if ((!seedGenes || !seedGenes.length) && projectId) {
      const project = loadUserProjects(req.user.email).find(p => p.id === projectId);
      if (project) seedGenes = project.scheduleGenes;
    }

    if (!seedGenes || !seedGenes.length) {
      return res.status(400).json({ success: false, error: 'Generate a schedule first — there is nothing to improve yet.' });
    }
    if (!(softConstraints || []).length) {
      return res.status(400).json({ success: false, error: 'Add at least one soft constraint before improving — there are no preferences to optimise.' });
    }

    const validation = validateInput({ standards, faculty, assignments, classrooms, daysOfWeek, timeSlots });
    if (!validation.isValid) {
      return res.status(400).json({ success: false, error: validation.errors.join(' | '), errors: validation.errors });
    }

    pruneJobs();

    const gaInput = {
      standards, faculty, assignments, classrooms, daysOfWeek, timeSlots,
      hardConstraints: hardConstraints || [],
      softConstraints: softConstraints || [],
      breakTime: breakTime || null
    };

    const jobId = startWorkerJob({ owner: req.user.email, projectId, gaInput, mode: 'improve', seedGenes });
    console.log(`Improve request from ${req.user.email} — seeded with ${seedGenes.length} classes`);
    res.status(202).json({ success: true, jobId });

  } catch (error) {
    console.error('Error starting improvement:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/** GET /api/jobs/:id – poll progress / collect the result */
app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.owner !== req.user.email) {
    return res.status(404).json({ success: false, error: 'That generation job no longer exists. Please generate again.' });
  }

  const body = {
    success: true,
    status: job.status,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    progress: job.progress,
    diagnostics: job.diagnostics
  };
  if (job.status === 'done')  Object.assign(body, job.result);
  if (job.status === 'error') body.error = job.error;

  res.json(body);
});

/** DELETE /api/jobs/:id – cancel a running generation */
app.delete('/api/jobs/:id', requireAuth, async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.owner !== req.user.email) {
    return res.status(404).json({ success: false, error: 'Job not found.' });
  }
  if (job.status === 'running') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    // terminate() stops the thread mid-loop; the GA has no cancellation points
    // of its own, so this is what makes Cancel actually work.
    if (job.worker) { try { await job.worker.terminate(); } catch {} }
    console.log(`✗ Job ${job.id} cancelled after ${job.finishedAt - job.startedAt}ms`);
  }
  res.json({ success: true, status: job.status });
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

  // ── Division validation ──────────────────────────────────────────────
  const divisionIds  = [];
  const usedRoomIds  = new Map(); // roomId -> "1st-A"
  (data.standards || []).forEach(std => {
    const divisions = std.divisions || [];
    if (divisions.length === 0)
      errors.push(`Standard "${std.name || '?'}": Must have at least one division`);

    divisions.forEach(d => {
      const label = `${std.name || '?'}-${d.label || '?'}`;
      if (!d.id) { errors.push(`${label}: Missing division ID`); return; }

      if (divisionIds.includes(d.id)) errors.push(`Duplicate division ID "${d.id}"`);
      else divisionIds.push(d.id);

      if (!d.roomId) {
        errors.push(`${label}: No classroom assigned — every division needs its own room`);
      } else if (usedRoomIds.has(d.roomId)) {
        errors.push(`${label} and ${usedRoomIds.get(d.roomId)} are both assigned the same classroom — each division needs its own room`);
      } else {
        usedRoomIds.set(d.roomId, label);
      }
    });
  });

  // ── Classroom validation ─────────────────────────────────────────────
  const seenRoomNames = [];
  (data.classrooms || []).forEach((room, i) => {
    const name = (room && room.name || '').trim();
    if (!name) {
      errors.push(`Classroom ${i + 1}: Name cannot be empty`);
      return;
    }
    const key = name.toUpperCase();
    if (seenRoomNames.includes(key))
      errors.push(`Duplicate classroom "${name}" — classroom names must be unique`);
    else seenRoomNames.push(key);
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
  // Which standard owns each course / division, for cross-checks below
  const standardOfCourse   = {};
  const standardOfDivision = {};
  (data.standards || []).forEach(std => {
    (std.courses   || []).forEach(c => { standardOfCourse[c.id]   = std; });
    (std.divisions || []).forEach(d => { standardOfDivision[d.id] = std; });
  });

  const assignmentIds   = [];
  const divisionCourses = []; // divisionId+courseId — one teacher per course per division
  (data.assignments || []).forEach((a, i) => {
    const label = `Assignment ${i + 1}`;
    if (!a.courseId)   errors.push(`${label}: No course selected`);
    if (!a.facultyId)  errors.push(`${label}: No faculty selected`);
    if (!a.divisionId) errors.push(`${label}: No division selected`);

    // Check referenced IDs actually exist
    if (a.courseId && !courseIds.includes(a.courseId))
      errors.push(`${label}: References a course that does not exist`);
    if (a.facultyId && !facultyIds.includes(a.facultyId))
      errors.push(`${label}: References a faculty member that does not exist`);
    if (a.divisionId && !divisionIds.includes(a.divisionId))
      errors.push(`${label}: References a division that does not exist`);

    // The course must belong to the division's own standard
    if (a.divisionId && a.courseId && standardOfDivision[a.divisionId] && standardOfCourse[a.courseId]
        && standardOfDivision[a.divisionId].id !== standardOfCourse[a.courseId].id) {
      errors.push(`${label}: That course does not belong to this division's standard`);
    }

    // A division can't be given the same course twice. Note the same
    // course+teacher pair across *different* divisions is perfectly normal —
    // one teacher commonly takes the same subject for several divisions.
    if (a.divisionId && a.courseId) {
      const pair = `${a.divisionId}::${a.courseId}`;
      if (divisionCourses.includes(pair))
        errors.push(`${label}: This division already has this course assigned`);
      else divisionCourses.push(pair);
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
  const { assignments, classrooms, daysOfWeek, timeSlots, standards = [], hardConstraints = [], breakTime } = data;

  const slotsPerWeek = daysOfWeek.length * timeSlots.length;

  // Work out how many first-half slots exist (for faculty_first_half_only constraint)
  const firstHalfCount = breakTime && breakTime.start
    ? timeSlots.filter(s => s.startTime < breakTime.start).length
    : timeSlots.length;

  // ── Readable labels ───────────────────────────────────────────────────
  const facultyName = id => {
    const f = (data.faculty || []).find(x => x.id === id);
    return f && f.name ? f.name : id;
  };
  const divisionLabel = {};   // divisionId -> "1st-A"
  standards.forEach(std => {
    (std.divisions || []).forEach(d => { divisionLabel[d.id] = `${std.name}-${d.label}`; });
  });
  const divName = id => divisionLabel[id] || id;

  // ── Global capacity: every division has its own room, so the ceiling is
  //    divisions × days × slots (rooms no longer multiply capacity) ──
  const allDivisions = standards.flatMap(s => (s.divisions || []));
  const totalSlots   = allDivisions.length * slotsPerWeek;
  let totalNeeded    = 0;
  assignments.forEach(a => { totalNeeded += parseInt(a.timesPerWeek || 1); });

  if (allDivisions.length > 0 && totalNeeded > totalSlots) {
    reasons.push(
      `Need ${totalNeeded} class slots but only ${totalSlots} exist ` +
      `(${allDivisions.length} divisions × ${daysOfWeek.length} days × ${timeSlots.length} slots). ` +
      `Add more days or time slots, or reduce how often courses meet.`
    );
  }

  // ── One room per division ──
  if (classrooms.length < allDivisions.length) {
    reasons.push(
      `There are ${allDivisions.length} divisions but only ${classrooms.length} classroom(s). ` +
      `Each division needs its own room — add ${allDivisions.length - classrooms.length} more.`
    );
  }

  // ── Per-faculty capacity ──
  // A teacher can only be in one room at a time, so their ceiling is
  // days × slots. (This used to be multiplied by the classroom count, which
  // overstated every teacher's availability and let impossible inputs through.)
  const facultyLoad = {};
  assignments.forEach(a => {
    facultyLoad[a.facultyId] = (facultyLoad[a.facultyId] || 0) + parseInt(a.timesPerWeek || 1);
  });

  const halfOnly = new Map(); // facultyId -> 'first' | 'second'
  (hardConstraints || []).forEach(hc => {
    if (hc.type === 'faculty_first_half_only')  halfOnly.set(hc.facultyId, 'first');
    if (hc.type === 'faculty_second_half_only') halfOnly.set(hc.facultyId, 'second');
  });

  // Blocked (day, slot) pairs per faculty — again not multiplied by rooms
  const blockedSlots = {};
  (hardConstraints || []).forEach(hc => {
    if (hc.type !== 'faculty_unavailability') return;
    if (daysOfWeek.indexOf(hc.day) === -1) return;
    // A timeslot that no longer matches any current slot is ignored, matching ga.js
    if (hc.timeslot && !timeSlots.some(s => s.startTime === hc.timeslot)) return;
    const slotCount = hc.timeslot ? 1 : timeSlots.length;
    blockedSlots[hc.facultyId] = (blockedSlots[hc.facultyId] || 0) + slotCount;
  });

  Object.entries(facultyLoad).forEach(([facId, load]) => {
    const half     = halfOnly.get(facId);
    const halfCap  = half === 'first'  ? daysOfWeek.length * firstHalfCount
                   : half === 'second' ? daysOfWeek.length * (timeSlots.length - firstHalfCount)
                   : slotsPerWeek;
    const maxSlots = Math.max(0, halfCap - (blockedSlots[facId] || 0));

    if (load > maxSlots) {
      const limits = [];
      if (half) limits.push(`${half}-half-only`);
      if (blockedSlots[facId]) limits.push(`${blockedSlots[facId]} blocked slot(s)`);
      reasons.push(
        `${facultyName(facId)} is assigned ${load} classes but only has ${maxSlots} available period(s)` +
        (limits.length ? ` (${limits.join(', ')})` : '') +
        `. Reduce their load, or add more days or time slots.`
      );
    }
  });

  // ── Per-division capacity — a division attends one class at a time ──
  const divisionLoad = {};
  assignments.forEach(a => {
    if (!a.divisionId) return;
    divisionLoad[a.divisionId] = (divisionLoad[a.divisionId] || 0) + parseInt(a.timesPerWeek || 1);
  });

  Object.entries(divisionLoad).forEach(([divId, needed]) => {
    if (needed > slotsPerWeek) {
      reasons.push(
        `${divName(divId)} needs ${needed} class slots but only ${slotsPerWeek} exist ` +
        `(${daysOfWeek.length} days × ${timeSlots.length} slots). ` +
        `A division can only attend one class per time slot. Add more days or time slots.`
      );
    }
  });

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

  // divisionId -> { label: "1st-A", standardName, roomName }
  const divisionInfo = {};
  (metadata.standards || []).forEach(std => {
    (std.divisions || []).forEach(d => {
      const room = (metadata.classrooms || []).find(r => r.id === d.roomId);
      divisionInfo[d.id] = {
        label:        `${std.name}-${d.label}`,
        standardName: std.name,
        roomName:     room ? room.name : ''
      };
    });
  });

  solution.genes.forEach(gene => {
    const day      = metadata.daysOfWeek[gene.dayIdx];
    const timeSlot = metadata.timeSlots[gene.timeSlotIdx];
    const info     = divisionInfo[gene.divisionId] || { label: '', standardName: '', roomName: '' };

    let courseName = '', courseCode = '';
    const standard = metadata.standards.find(s => s.courses && s.courses.some(c => c.id === gene.courseId));
    if (standard) {
      const course = standard.courses.find(c => c.id === gene.courseId);
      if (course) { courseName = course.name; courseCode = course.courseCode; }
    }

    const faculty = metadata.faculty.find(f => f.id === gene.facultyId);

    schedule[day].push({
      timeSlot,
      startTime:   timeSlot.startTime,
      endTime:     timeSlot.endTime,
      // `standard` carries the division label ("1st-A") because the timetable
      // views group by it, and a division is what actually sits in a room.
      standard:     info.label,
      divisionId:   gene.divisionId,
      divisionLabel: info.label,
      standardName: info.standardName,
      course:       courseName,
      courseCode,
      faculty:      faculty ? faculty.name : '',
      facultyCode:  faculty ? faculty.facultyCode : '',
      classroom:    info.roomName
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

// Workbook palette — mirrors the app's light "cream paper" theme.
const XL = {
  headerFill: 'FFF0ECE2',  // sunken cream
  headerText: 'FF1F232B',
  emptyFill:  'FFFFFFFF',
  border:     'FFD8D2C6',
  // Subtle tints cycled per standard row so adjacent standards stay distinguishable
  groupFills: ['FFECF1F7', 'FFEFF4EC', 'FFFAF3E8', 'FFF2EFF6']
};

async function createExcelTimetable(schedule, filepath) {
  const workbook  = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Schedule');

  const edge       = { style: 'thin', color: { argb: XL.border } };
  const cellBorder = { top: edge, left: edge, bottom: edge, right: edge };

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
  infoCell.value = 'Each time column is labelled with the start time of that slot.';
  infoCell.font  = { size: 10, italic: true, color: { argb: 'FF7C776E' } };
  infoCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  worksheet.getRow(1).height = 24;

  worksheet.getCell('A2').value = 'Day';
  worksheet.getCell('B2').value = 'Division';
  worksheet.getCell('C2').value = 'Classes';
  timeSlots.forEach((time, idx) => {
    const col = excelColName(3 + idx); // D, E, F, ...
    worksheet.getCell(`${col}2`).value = time;
  });

  // Style header row (columns A through last time-slot column)
  const totalCols = 3 + timeSlots.length; // A, B, C + time slots
  for (let ci = 0; ci < totalCols; ci++) {
    const cell = worksheet.getCell(`${excelColName(ci)}2`);
    cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.headerFill } };
    cell.font  = { bold: true, color: { argb: XL.headerText } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = cellBorder;
  }

  let currentRow = 3;
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
        dayCell.alignment = { horizontal: 'center', vertical: 'middle' };
        worksheet.mergeCells(`A${currentRow}:A${currentRow + standards.length - 1}`);
      }
      worksheet.getCell(`A${currentRow}`).border = cellBorder;

      const groupCell = worksheet.getCell(`B${currentRow}`);
      groupCell.value = standard;
      groupCell.alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
      groupCell.border = cellBorder;

      const countCell = worksheet.getCell(`C${currentRow}`);
      countCell.value = stdClasses.length;
      countCell.alignment = { horizontal: 'center', vertical: 'top' };
      countCell.border = cellBorder;

      timeSlots.forEach((time, timeIdx) => {
        const col  = excelColName(3 + timeIdx);
        const cell = worksheet.getCell(`${col}${currentRow}`);
        const classesAtTime = stdClasses.filter(c => c.startTime === time);
        if (classesAtTime.length > 0) {
          const cls  = classesAtTime[0];
          cell.value = `${cls.course} (${cls.faculty})\n${cls.classroom}`;
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.groupFills[colorIdx % XL.groupFills.length] } };
        } else {
          cell.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.emptyFill } };
        }
        cell.alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
        cell.border = cellBorder;
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