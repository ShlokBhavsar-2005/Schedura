const API_BASE_URL = '';  // relative — works on any host

// Date.now() alone can collide when two items are added within the same
// millisecond (e.g. scripted/bulk adds), which breaks id-based lookups
// and DOM ids. Always mix in a random suffix for uniqueness.
function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const { toast, relTime } = Schedura;

// ── Which project, from the URL ──
// /projects/:id/:step. The id used to live in sessionStorage, which meant every
// screen shared one address: nothing could be bookmarked, linked, or opened in
// a second tab without hijacking the first.
const PATH_PARTS = location.pathname.split('/').filter(Boolean);
const PROJ_ID    = PATH_PARTS[0] === 'projects' ? decodeURIComponent(PATH_PARTS[1] || '') : '';

let projectName = '';

/**
 * Fetch shim over Schedura.api, which handles the bearer token, the silent
 * refresh of an expired one, and the re-auth overlay. Shaped like a fetch
 * Response so the call sites below did not all have to change.
 */
async function authFetch(url, opts = {}) {
  const body = await Schedura.api(url, opts);
  return { ok: body.ok, status: body.status, json: async () => body };
}

// ── Auto-save ──
// Three things the old version got wrong: the status vanished (leaving you
// unsure anything was stored), a failure was announced once and then forgotten,
// and going offline silently dropped the write.

const SAVE_LABELS = {
  idle:   'All changes saved',
  dirty:  'Unsaved changes',
  saving: 'Saving…',
  error:  'Save failed — retrying'
};

let _saveTimer = null;
let _saving    = false;
let _dirty     = false;

function setSaveState(state) {
  const el = document.getElementById('saveStatus');
  if (!el) return;
  el.dataset.state = state;
  el.innerHTML = `<span class="dot"></span><span class="save-label">${SAVE_LABELS[state] || ''}</span>`;
}

function markDirty() {
  _dirty = true;
  setSaveState('dirty');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(autoSave, 1200);
  refreshStepState();
}

async function autoSave({ force = false } = {}) {
  if (!PROJ_ID || (!_dirty && !force)) return;

  // Held, not dropped. The banner tells the user, and the reconnect handler
  // below flushes it.
  if (!Schedura.net.online) { setSaveState('dirty'); return; }

  if (_saving) { clearTimeout(_saveTimer); _saveTimer = setTimeout(autoSave, 600); return; }

  _saving = true;
  setSaveState('saving');
  const data = await Schedura.api(`${API_BASE_URL}/api/projects/${PROJ_ID}`, {
    method: 'PUT',
    body: JSON.stringify({ standards, faculty, assignments, classrooms: getClassrooms(), selectedDays, timeSlotValues, hardConstraints, softConstraints, breakTime })
  });
  _saving = false;

  if (!data.ok || !data.success) {
    setSaveState('error');
    // Validation errors are the user's to fix; anything else is worth retrying.
    if (data.status === 400 && data.error) showAlert(data.error, 'error');
    else { clearTimeout(_saveTimer); _saveTimer = setTimeout(autoSave, 5000); }
    return;
  }

  _dirty = false;
  setSaveState('idle');
}

Schedura.net.onChange(online => { if (online && _dirty) autoSave(); });

// Last line of defence: never let a tab close on unsaved work in silence.
window.addEventListener('beforeunload', e => {
  if (_dirty) { e.preventDefault(); e.returnValue = ''; }
});

// Switching tabs or minimising is a natural moment to flush.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && _dirty) autoSave();
});

// Data structures
// standards[].divisions = [{ id, label, roomId }] — a division is the unit that
// gets scheduled: its students move together and it owns one classroom.
let standards = [];
let faculty = [];
let assignments = [];   // { id, divisionId, courseId, facultyId, timesPerWeek }
let classrooms = [];    // { id, name }
let selectedDays = [];
let timeSlots = [];
let timeSlotsCount = 1;
let timeSlotValues = [{ startTime: '', endTime: '' }];
let generatedFilename = null;
let currentScheduleData = null;
let hardConstraints = [];
let softConstraints = [];
let breakTime = { start: '', end: '' };

/**
 * Short confirmations go to a toast; long ones — validation lists, mostly —
 * stay on the page, because a wall of text that disappears on a timer is
 * useless for the thing it is trying to tell you.
 */
function showAlert(message, type = 'success') {
  const text = String(message);
  const long = text.includes('\n') || text.includes(' | ') || text.length > 130;

  if (!long) {
    toast(text, { type: type === 'error' ? 'error' : type === 'success' ? 'success' : undefined });
    return;
  }

  const container = document.getElementById('alertContainer');
  container.innerHTML = '';
  const alert = document.createElement('div');
  alert.className = `alert alert-${type} active`;
  alert.style.position = 'relative';
  alert.style.paddingRight = '38px';
  alert.textContent = text.replace(/ \| /g, '\n• ');

  const close = document.createElement('button');
  close.className = 'btn-icon';
  close.style.cssText = 'position:absolute;top:6px;right:6px';
  close.setAttribute('aria-label', 'Dismiss');
  close.innerHTML = '&times;';
  close.onclick = () => alert.remove();
  alert.appendChild(close);

  container.appendChild(alert);
  alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Classrooms are objects ({ id, name }) because divisions reference a room by
// id — pinning by name would break the link the moment a room is renamed.
function getClassrooms() {
  return classrooms.filter(r => r.name && r.name.trim());
}

function classroomName(roomId) {
  const room = classrooms.find(r => r.id === roomId);
  return room ? room.name : '';
}

/** All division objects across every standard, flattened. */
function allDivisions() {
  return standards.flatMap(std =>
    (std.divisions || []).map(d => ({ ...d, standardId: std.id, standardName: std.name }))
  );
}

/** Display name for a division, e.g. "1st-A". */
function divisionName(division, standard) {
  const std = standard || standards.find(s => (s.divisions || []).some(d => d.id === division.id));
  return `${std ? std.name : ''}-${division.label}`;
}

/** First classroom not already claimed by a division, or null. */
function nextFreeRoomId() {
  const taken = new Set(allDivisions().map(d => d.roomId).filter(Boolean));
  const free  = classrooms.find(r => !taken.has(r.id));
  return free ? free.id : null;
}

/** An unused "Room N" name. */
function suggestRoomName() {
  const used = new Set(classrooms.map(r => (r.name || '').trim().toLowerCase()));
  for (let n = 1; n <= 500; n++) {
    const name = `Room ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  return `Room ${classrooms.length + 1}`;
}

/**
 * A room for a new division, creating one if nothing is spare.
 *
 * Every division needs its own room or it cannot be scheduled at all, so making
 * someone leave the standards step, add rooms by hand, and come back is pure
 * friction. This also means the steps can run in the order people expect.
 */
function ensureRoomForDivision() {
  const free = nextFreeRoomId();
  if (free) return free;

  const room = { id: uid('room'), name: suggestRoomName() };
  classrooms.push(room);
  if (document.getElementById('roomContainer')) renderRoomCard(room);
  return room.id;
}

// Update selected days
function updateDays() {
  const checkboxes = document.querySelectorAll('#daysCheckboxes input[type="checkbox"]');
  selectedDays = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.value);
  markDirty();
}

// Standards Management
// NOTE: all handlers below look up standards/courses by their stable `id`,
// never by array index — indices baked into onclick/onchange attributes go
// stale as soon as an earlier item in the list is removed.
/** Next division label: A, B, C … then A2, B2 … if a school ever needs >26. */
function nextDivisionLabel(standard) {
  const used = new Set((standard.divisions || []).map(d => d.label));
  for (let i = 0; i < 26; i++) {
    const label = String.fromCharCode(65 + i);
    if (!used.has(label)) return label;
  }
  return 'D' + ((standard.divisions || []).length + 1);
}

// One renderer for a standard card, used both when adding a new one and when
// restoring a saved project — keeping two copies of this template in sync is
// what caused the stale-index bug previously.
function renderStandardCard(standard) {
  const container = document.getElementById('standardsContainer');
  document.getElementById(standard.id)?.remove();

  const card = document.createElement('div');
  card.className = 'card';
  card.id = standard.id;
  card.innerHTML = `
    <div class="grid">
      <div>
        <label>Standard name</label>
        <input type="text" value="${esc(standard.name)}" placeholder="e.g. 1st"
          onchange="updateStandardName('${standard.id}', this.value)">
      </div>
      <div>
        <label>Number of divisions</label>
        <input type="number" min="1" max="26" value="${(standard.divisions || []).length || 1}"
          onchange="setDivisionCount('${standard.id}', parseInt(this.value))">
      </div>
    </div>

    <div id="${standard.id}-divisions" style="margin-top:14px;"></div>

    <div style="margin-top: 16px;">
      <p style="margin:0 0 8px 0; font-weight:600; font-size:13px; color:var(--text);">Courses</p>
      <p style="margin:0 0 10px 0; font-size:12px; color:var(--muted);">Every division of this standard studies these courses.</p>
      <div id="${standard.id}-courses"></div>
      <button class="btn btn-outline btn-sm" style="margin-top: 10px;" onclick="addCourse('${standard.id}')">+ Add course</button>
    </div>

    <button class="btn btn-danger btn-sm" onclick="removeStandard('${standard.id}')">Remove standard</button>
  `;
  container.appendChild(card);

  renderStandardDivisions(standard.id);
  (standard.courses || []).forEach(c => renderCourseCard(standard.id, c));
}

function addStandard() {
  const standardId = uid('standard');
  standards.push({
    id: standardId,
    name: '',
    courses: [],
    divisions: [{ id: uid('div'), label: 'A', roomId: ensureRoomForDivision() }]
  });
  renderStandardCard(standards[standards.length - 1]);
  renderAssignmentMatrix();
  markDirty();
}

function updateStandardName(standardId, name) {
  const standard = standards.find(s => s.id === standardId);
  if (!standard) return;
  standard.name = name;
  renderStandardDivisions(standardId);  // division labels show "1st-A"
  renderAssignmentMatrix();
  refreshConstraintDropdowns();
  markDirty();
}

// ── Divisions ───────────────────────────────────────────────────────
function renderStandardDivisions(standardId) {
  const standard = standards.find(s => s.id === standardId);
  const host = document.getElementById(`${standardId}-divisions`);
  if (!standard || !host) return;

  const takenElsewhere = new Set(
    allDivisions().filter(d => d.standardId !== standardId).map(d => d.roomId).filter(Boolean)
  );

  const rows = (standard.divisions || []).map(d => {
    const options = ['<option value="">No classroom</option>'].concat(
      classrooms.map(r => {
        const usedByOther = takenElsewhere.has(r.id) ||
          (standard.divisions || []).some(o => o.id !== d.id && o.roomId === r.id);
        return `<option value="${r.id}" ${r.id === d.roomId ? 'selected' : ''} ${usedByOther ? 'disabled' : ''}>${esc(r.name)}${usedByOther ? ' — taken' : ''}</option>`;
      })
    ).join('');

    return `
      <div style="display:flex; gap:10px; align-items:flex-end; margin-bottom:8px; flex-wrap:wrap;">
        <div style="width:110px;">
          <label>Division</label>
          <input type="text" value="${esc(d.label)}" maxlength="6"
            onchange="updateDivisionLabel('${standardId}','${d.id}',this.value)">
        </div>
        <div style="flex:1; min-width:170px;">
          <label>Classroom${standard.name ? ` for ${esc(standard.name)}-${esc(d.label)}` : ''}</label>
          <select onchange="updateDivisionRoom('${standardId}','${d.id}',this.value)">${options}</select>
        </div>
      </div>`;
  }).join('');

  const shortfall = allDivisions().length - classrooms.length;
  const warning = shortfall > 0
    ? `<p style="margin:4px 0 0 0; font-size:12px; color:var(--danger);">${shortfall} more classroom${shortfall > 1 ? 's' : ''} needed — every division must have its own room.</p>`
    : '';

  host.innerHTML = `
    <p style="margin:0 0 8px 0; font-weight:600; font-size:13px; color:var(--text);">Divisions</p>
    <p style="margin:0 0 10px 0; font-size:12px; color:var(--muted);">Each division stays in its own classroom all week.</p>
    ${rows}${warning}`;
}

/** Grow or shrink a standard's divisions to `count`, auto-claiming free rooms. */
async function setDivisionCount(standardId, count) {
  const standard = standards.find(s => s.id === standardId);
  if (!standard) return;
  if (isNaN(count) || count < 1) count = 1;
  if (count > 26) count = 26;

  const divisions = standard.divisions || (standard.divisions = []);

  while (divisions.length < count) {
    divisions.push({ id: uid('div'), label: nextDivisionLabel(standard), roomId: ensureRoomForDivision() });
  }

  while (divisions.length > count) {
    const removed = divisions[divisions.length - 1];
    const used = assignments.some(a => a.divisionId === removed.id);
    if (used && !(await Schedura.confirm({
      title: `Remove ${standard.name || 'this standard'}-${removed.label}?`,
      body: 'It has teachers assigned to it. Those assignments will be removed too.',
      confirmLabel: 'Remove division',
      danger: true
    }))) break;
    divisions.pop();
    // Drop assignments that belonged to the removed division
    for (let i = assignments.length - 1; i >= 0; i--) {
      if (assignments[i].divisionId === removed.id) assignments.splice(i, 1);
    }
  }

  // Reflect any clamping back into the input
  const input = document.querySelector(`#${CSS.escape(standardId)} input[type="number"]`);
  if (input) input.value = divisions.length;

  renderStandardDivisions(standardId);
  renderAssignmentMatrix();
  markDirty();
}

function updateDivisionLabel(standardId, divisionId, label) {
  const standard = standards.find(s => s.id === standardId);
  const division = standard && (standard.divisions || []).find(d => d.id === divisionId);
  if (!division) return;
  division.label = (label || '').trim() || division.label;
  renderStandardDivisions(standardId);
  renderAssignmentMatrix();
  markDirty();
}

function updateDivisionRoom(standardId, divisionId, roomId) {
  const standard = standards.find(s => s.id === standardId);
  const division = standard && (standard.divisions || []).find(d => d.id === divisionId);
  if (!division) return;
  division.roomId = roomId || null;
  // A room can serve only one division — re-render every standard so the
  // "taken" markers stay accurate across cards.
  standards.forEach(s => renderStandardDivisions(s.id));
  markDirty();
}

// ── Courses ─────────────────────────────────────────────────────────
function renderCourseCard(standardId, course) {
  const container = document.getElementById(`${standardId}-courses`);
  if (!container) return;
  document.getElementById(course.id)?.remove();

  const sub = document.createElement('div');
  sub.className = 'sub-card';
  sub.id = course.id;
  sub.innerHTML = `
    <div class="sub-card-grid">
      <div>
        <label>Course name</label>
        <input type="text" value="${esc(course.name)}" placeholder="e.g. Mathematics"
          onchange="updateCourseName('${standardId}', '${course.id}', 'name', this.value)">
      </div>
      <div>
        <label>Course code</label>
        <input type="text" value="${esc(course.courseCode)}" placeholder="e.g. MATH101"
          onchange="updateCourseName('${standardId}', '${course.id}', 'courseCode', this.value)">
      </div>
    </div>
    <button class="btn btn-danger btn-sm" style="font-size: 11px; padding: 4px 8px;"
      onclick="removeCourse('${course.id}', '${standardId}')">Remove course</button>
  `;
  container.appendChild(sub);
}

function addCourse(standardId) {
  const standard = standards.find(s => s.id === standardId);
  if (!standard) return;
  const course = { id: uid('course'), name: '', courseCode: '' };
  standard.courses.push(course);
  renderCourseCard(standardId, course);
  renderAssignmentMatrix();
  markDirty();
}

function updateCourseName(standardId, courseId, field, value) {
  const standard = standards.find(s => s.id === standardId);
  const course   = standard && standard.courses.find(c => c.id === courseId);
  if (!course) return;
  course[field] = value;
  renderAssignmentMatrix();
  refreshConstraintDropdowns();
  markDirty();
}

function removeCourse(courseId, standardId) {
  const standard = standards.find(s => s.id === standardId);
  if (!standard) return;
  const courseIndex = standard.courses.findIndex(c => c.id === courseId);
  if (courseIndex === -1) return;

  document.getElementById(courseId)?.remove();
  standard.courses.splice(courseIndex, 1);

  // Drop every division's assignment for this course
  for (let i = assignments.length - 1; i >= 0; i--) {
    if (assignments[i].courseId === courseId) assignments.splice(i, 1);
  }

  renderAssignmentMatrix();
  refreshConstraintDropdowns();
  markDirty();
}

/** Re-render the whole standards list, in order. Needed so an undo can put a
 *  removed standard back where it was rather than at the bottom. */
function renderAllStandards() {
  const container = document.getElementById('standardsContainer');
  if (!container) return;
  container.innerHTML = '';
  standards.forEach(renderStandardCard);
}

function removeStandard(standardId) {
  const standardIndex = standards.findIndex(s => s.id === standardId);
  if (standardIndex === -1) return;

  // Removed straight away and offered back for a while. Asking "are you sure?"
  // is what you do when you cannot undo — and this can.
  const removed = standards[standardIndex];
  const divisionIds = new Set((removed.divisions || []).map(d => d.id));
  const removedAssignments = assignments.filter(a => divisionIds.has(a.divisionId));

  for (let i = assignments.length - 1; i >= 0; i--) {
    if (divisionIds.has(assignments[i].divisionId)) assignments.splice(i, 1);
  }
  standards.splice(standardIndex, 1);
  renderAllStandards();
  renderAssignmentMatrix();
  refreshConstraintDropdowns();
  markDirty();

  toast(`${removed.name ? '“' + removed.name + '”' : 'Standard'} removed`, {
    action: 'Undo',
    onAction: () => {
      standards.splice(Math.min(standardIndex, standards.length), 0, removed);
      assignments.push(...removedAssignments);
      renderAllStandards();
      renderAssignmentMatrix();
      refreshConstraintDropdowns();
      markDirty();
    }
  });
}

// Faculty Management
// Single renderer used by the add button, project load and demo data alike
function renderFacultyCard(fac) {
  const container = document.getElementById('facultyContainer');
  document.getElementById(fac.id)?.remove();

  const cardDiv = document.createElement('div');
  cardDiv.className = 'card';
  cardDiv.id = fac.id;
  cardDiv.innerHTML = `
    <div class="grid">
      <div>
        <label>Teacher name</label>
        <input type="text" value="${esc(fac.name)}" placeholder="e.g. Anjali Sharma"
          onchange="updateFaculty('${fac.id}', 'name', this.value)">
      </div>
      <div>
        <label>Short code</label>
        <input type="text" value="${esc(fac.facultyCode)}" placeholder="e.g. AS1"
          onchange="updateFaculty('${fac.id}', 'facultyCode', this.value)">
      </div>
    </div>
    <button class="btn btn-danger btn-sm" onclick="removeFaculty('${fac.id}')">Remove</button>
  `;
  container.appendChild(cardDiv);
}

function addFaculty() {
  const facultyId = uid('faculty');
  faculty.push({ id: facultyId, name: '', facultyCode: '' });
  renderFacultyCard(faculty[faculty.length - 1]);

  renderAssignmentMatrix();
  markDirty();
}

function updateFaculty(facultyId, field, value) {
  const fac = faculty.find(f => f.id === facultyId);
  if (!fac) return;
  fac[field] = value;
  renderAssignmentMatrix();
  refreshConstraintDropdowns();
  markDirty();
}

function renderAllFaculty() {
  const container = document.getElementById('facultyContainer');
  if (!container) return;
  container.innerHTML = '';
  faculty.forEach(renderFacultyCard);
}

function renderAllRooms() {
  const container = document.getElementById('roomContainer');
  if (!container) return;
  container.innerHTML = '';
  classrooms.forEach(renderRoomCard);
}

function removeFaculty(facultyId) {
  const facultyIndex = faculty.findIndex(f => f.id === facultyId);
  if (facultyIndex === -1) return;

  const removed = faculty[facultyIndex];
  // Their assignments can't stand without a teacher — drop them outright
  // (an assignment with no faculty is rejected by validation anyway), but keep
  // a copy so Undo restores the teacher together with their work.
  const removedAssignments = assignments.filter(a => a.facultyId === facultyId);
  const removedRules = [
    ...hardConstraints.filter(c => c.facultyId === facultyId),
    ...softConstraints.filter(c => c.facultyId === facultyId)
  ];

  faculty.splice(facultyIndex, 1);
  for (let i = assignments.length - 1; i >= 0; i--) {
    if (assignments[i].facultyId === facultyId) assignments.splice(i, 1);
  }

  renderAllFaculty();
  renderAssignmentMatrix();
  refreshConstraintDropdowns();
  markDirty();

  toast(`${removed.name ? removed.name : 'Teacher'} removed`, {
    action: 'Undo',
    onAction: () => {
      faculty.splice(Math.min(facultyIndex, faculty.length), 0, removed);
      assignments.push(...removedAssignments);
      renderAllFaculty();
      renderAssignmentMatrix();
      refreshConstraintDropdowns();
      markDirty();
      if (removedRules.length) {
        toast(`${removedRules.length} rule${removedRules.length === 1 ? '' : 's'} referring to them still need${removedRules.length === 1 ? 's' : ''} checking`);
      }
    }
  });
}

// ── Assignments: one grid per standard ──────────────────────────────
// Rows are courses, columns are divisions, each cell picks the teacher.
// A flat list would be unusable: 8 standards x 3 divisions x 8 courses is
// ~190 rows, whereas this is 8 compact tables.

/** The standard that owns a course, or null. */
function standardForCourse(courseId) {
  return standards.find(s => (s.courses || []).some(c => c.id === courseId)) || null;
}

function findAssignment(divisionId, courseId) {
  return assignments.find(a => a.divisionId === divisionId && a.courseId === courseId) || null;
}

/** Times per week is set per course and shared by all its divisions. */
function courseTimesPerWeek(courseId) {
  const existing = assignments.find(a => a.courseId === courseId);
  return existing ? (existing.timesPerWeek || 1) : 1;
}

function setCourseFaculty(divisionId, courseId, facultyId) {
  const existing = findAssignment(divisionId, courseId);

  if (!facultyId) {                       // "Not taught" — drop the assignment
    if (existing) assignments.splice(assignments.indexOf(existing), 1);
  } else if (existing) {
    existing.facultyId = facultyId;
  } else {
    assignments.push({
      id: uid('assignment'),
      divisionId, courseId, facultyId,
      timesPerWeek: courseTimesPerWeek(courseId)
    });
  }
  renderAssignmentMatrix();
  markDirty();
}

function setCourseTimesPerWeek(courseId, value) {
  let tpw = parseInt(value);
  if (isNaN(tpw) || tpw < 1) tpw = 1;
  assignments.forEach(a => { if (a.courseId === courseId) a.timesPerWeek = tpw; });
  renderAssignmentMatrix();
  markDirty();
}

function renderAssignmentMatrix() {
  const host = document.getElementById('assignmentMatrix');
  if (!host) return;

  const usable = standards.filter(s => (s.courses || []).length && (s.divisions || []).length);
  if (usable.length === 0) {
    host.innerHTML = `
      <div class="empty">
        <svg width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        <h3>Nothing to assign yet</h3>
        <p>This grid pairs courses with teachers, division by division. It needs at least one standard that has both a course and a division.</p>
        <div class="empty-actions"><button class="btn btn-primary" onclick="goToStep('standards')">Go to standards</button></div>
      </div>`;
    return;
  }
  if (faculty.length === 0) {
    host.innerHTML = `
      <div class="empty">
        <svg width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
        <h3>No teachers to assign</h3>
        <p>Add your teachers first — then each course in each division can be given one here.</p>
        <div class="empty-actions"><button class="btn btn-primary" onclick="goToStep('teachers')">Go to teachers</button></div>
      </div>`;
    return;
  }

  host.innerHTML = usable.map(std => {
    const divisions = std.divisions || [];

    const head = divisions.map(d =>
      `<th style="min-width:150px;">${esc(std.name)}-${esc(d.label)}</th>`).join('');

    const rows = (std.courses || []).map(course => {
      const cells = divisions.map(d => {
        const current = findAssignment(d.id, course.id);
        const options = ['<option value="">Not taught</option>'].concat(
          faculty.map(f => {
            const label = f.facultyCode ? `${f.name} (${f.facultyCode})` : f.name;
            return `<option value="${f.id}" ${current && current.facultyId === f.id ? 'selected' : ''}>${esc(label || '(unnamed)')}</option>`;
          })
        ).join('');
        return `<td><select onchange="setCourseFaculty('${d.id}','${course.id}',this.value)">${options}</select></td>`;
      }).join('');

      return `
        <tr>
          <td style="text-align:left;font-weight:600;">${esc(course.name || '(unnamed course)')}
            ${course.courseCode ? `<span style="font-weight:400;color:var(--muted);"> · ${esc(course.courseCode)}</span>` : ''}
          </td>
          <td style="width:110px;">
            <input type="number" min="1" value="${courseTimesPerWeek(course.id)}"
              onchange="setCourseTimesPerWeek('${course.id}', this.value)">
          </td>
          ${cells}
        </tr>`;
    }).join('');

    return `
      <div class="matrix-standard">
        <h3>${esc(std.name || '(unnamed standard)')}</h3>
        <p>${divisions.length} division${divisions.length === 1 ? '' : 's'} · ${(std.courses || []).length} course${(std.courses || []).length === 1 ? '' : 's'}</p>
        <div class="table-wrapper">
          <table>
            <thead><tr><th style="text-align:left;">Course</th><th>Per week</th>${head}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}

// Classroom Management
/** Re-render every standard's division rows (their room dropdowns list rooms). */
function refreshDivisionRoomPickers() {
  standards.forEach(s => renderStandardDivisions(s.id));
}

function addRoom(name = '') {
  const roomId = uid('room');
  classrooms.push({ id: roomId, name });
  renderRoomCard({ id: roomId, name });
  refreshDivisionRoomPickers();
  markDirty();
  return roomId;
}

function renderRoomCard(room) {
  const container = document.getElementById('roomContainer');
  const cardDiv = document.createElement('div');
  cardDiv.className = 'card';
  cardDiv.id = room.id;
  cardDiv.innerHTML = `
    <div class="grid">
      <div><label>Classroom name</label>
        <input type="text" placeholder="e.g. Room 1" value="${esc(room.name)}"
          onchange="updateRoom('${room.id}', this.value)"></div>
    </div>
    <button class="btn btn-danger btn-sm" onclick="removeRoom('${room.id}')">Remove</button>
  `;
  container.appendChild(cardDiv);
}

function updateRoom(roomId, name) {
  const room = classrooms.find(r => r.id === roomId);
  if (!room) return;
  room.name = name;
  refreshDivisionRoomPickers();
  if (typeof refreshConstraintDropdowns === 'function') refreshConstraintDropdowns();
  markDirty();
}

function removeRoom(roomId) {
  const idx = classrooms.findIndex(r => r.id === roomId);
  if (idx === -1) return;

  const removed = classrooms[idx];
  // A division must never point at a room that no longer exists. Remember which
  // ones did, so Undo can re-pin them rather than leaving them roomless.
  const orphaned = [];
  standards.forEach(std => {
    (std.divisions || []).forEach(d => {
      if (d.roomId === roomId) { orphaned.push(d); d.roomId = null; }
    });
  });

  classrooms.splice(idx, 1);
  renderAllRooms();
  refreshDivisionRoomPickers();
  if (typeof refreshConstraintDropdowns === 'function') refreshConstraintDropdowns();
  markDirty();

  toast(`${removed.name ? removed.name : 'Classroom'} removed`, {
    action: 'Undo',
    onAction: () => {
      classrooms.splice(Math.min(idx, classrooms.length), 0, removed);
      orphaned.forEach(d => { d.roomId = removed.id; });
      renderAllRooms();
      refreshDivisionRoomPickers();
      if (typeof refreshConstraintDropdowns === 'function') refreshConstraintDropdowns();
      markDirty();
    }
  });
}

// Time Slot Management - FIXED
function addTimeSlot() {
  timeSlotValues.push({ startTime: '', endTime: '' });
  renderTimeSlots();
  markDirty();
}

function removeTimeSlot(index) {
  if (timeSlotValues.length > 1) {
    timeSlotValues.splice(index, 1);
    renderTimeSlots();
    markDirty();
  }
}

/** Edit one end of a period. Went through a bare inline assignment before, which
 *  meant changing a period never marked the project dirty and the new times were
 *  only ever saved if some unrelated edit happened to follow. */
function updateTimeSlot(index, field, value) {
  if (!timeSlotValues[index]) return;
  timeSlotValues[index][field] = value;
  refreshConstraintDropdowns();
  markDirty();
}

function renderTimeSlots() {
  const container = document.getElementById("timeSlots");
  let html = '';
  for (let i = 0; i < timeSlotValues.length; i++) {
    html += `
      <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 12px; margin-bottom: 12px; align-items: flex-end;">
        <div>
          <label>Period ${i + 1} starts</label>
          <input type="time" value="${timeSlotValues[i].startTime}" onchange="updateTimeSlot(${i}, 'startTime', this.value)">
        </div>
        <div>
          <label>Period ${i + 1} ends</label>
          <input type="time" value="${timeSlotValues[i].endTime}" onchange="updateTimeSlot(${i}, 'endTime', this.value)">
        </div>
        ${timeSlotValues.length > 1 ? `<button class="btn btn-danger btn-sm" style="height: 38px;" onclick="removeTimeSlot(${i})">−</button>` : ''}
      </div>
    `;
  }
  container.innerHTML = html;
}

// Collect time slots from data array
function collectTimeSlots() {
  return timeSlotValues.filter(slot => slot.startTime && slot.endTime);
}

// ── Break Time ──────────────────────────────────────────────────────
function updateBreakTime() {
  breakTime = {
    start: document.getElementById('breakStartInput').value,
    end:   document.getElementById('breakEndInput').value
  };
  markDirty();
}

// ── Helper: build faculty options HTML ──────────────────────────────
function facultyOptionsHtml(selectedId) {
  return faculty.map(f =>
    `<option value="${f.id}" ${f.id === selectedId ? 'selected' : ''}>${esc(f.name)} (${esc(f.facultyCode)})</option>`
  ).join('');
}

// ── Helper: build course options HTML (shows courseName, standardName, courseCode) ──
function courseOptionsHtml(selectedId) {
  let opts = '';
  standards.forEach(std => {
    (std.courses || []).forEach(c => {
      opts += `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${esc(c.name)} — ${esc(std.name)} (${esc(c.courseCode)})</option>`;
    });
  });
  return opts;
}

// ── Helper: build day options HTML ──────────────────────────────────
function dayOptionsHtml(selectedDay) {
  const days = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  return days.map(d => `<option value="${d}" ${d === selectedDay ? 'selected' : ''}>${d}</option>`).join('');
}

// ── Helper: build timeslot options HTML ─────────────────────────────
function slotOptionsHtml(selectedStart) {
  const allSlot = `<option value="" ${!selectedStart ? 'selected' : ''}>All day</option>`;
  const slotOpts = timeSlotValues.filter(s => s.startTime && s.endTime).map(s =>
    `<option value="${s.startTime}" ${s.startTime === selectedStart ? 'selected' : ''}>${s.startTime} – ${s.endTime}</option>`
  ).join('');
  return allSlot + slotOpts;
}

// ── Hard Constraints ────────────────────────────────────────────────
// NOTE: cards are looked up/updated by their stable `id`, never by array
// index (see the Standards/Faculty/Assignment fix above for why).
function addHardConstraint() {
  const container = document.getElementById('hardConstraintsContainer');
  const cid = uid('hard');
  hardConstraints.push({ id: cid, type: 'faculty_unavailability', facultyId: '', day: '', timeslot: '', courseId: '', classroom: '' });
  renderHardConstraintCard(cid, container);
  markDirty();
}

function renderHardConstraintCard(cid, container) {
  const c = hardConstraints.find(x => x.id === cid);
  if (!c) return;
  const existing = document.getElementById(c.id);
  if (existing) existing.remove();

  const card = document.createElement('div');
  card.className = 'card'; card.id = c.id;

  let fieldsHtml = '';
  if (c.type === 'faculty_unavailability') {
    fieldsHtml = `
      <div><label>Teacher</label>
        <select onchange="updateHC('${cid}','facultyId',this.value)">
          <option value="">Choose a teacher</option>${facultyOptionsHtml(c.facultyId)}
        </select></div>
      <div><label>Unavailable day</label>
        <select onchange="updateHC('${cid}','day',this.value)">
          <option value="">Choose a day</option>${dayOptionsHtml(c.day)}
        </select></div>
      <div><label>Period (optional)</label>
        <select onchange="updateHC('${cid}','timeslot',this.value)">
          ${slotOptionsHtml(c.timeslot)}
        </select></div>`;
  } else if (c.type === 'faculty_first_half_only') {
    fieldsHtml = `
      <div><label>Teacher (first half only)</label>
        <select onchange="updateHC('${cid}','facultyId',this.value)">
          <option value="">Choose a teacher</option>${facultyOptionsHtml(c.facultyId)}
        </select></div>
      <div style="font-size:12px;color:var(--muted);padding-top:20px;">Uses the break time set above to determine first half.</div>`;
  } else if (c.type === 'faculty_second_half_only') {
    fieldsHtml = `
      <div><label>Teacher (second half only)</label>
        <select onchange="updateHC('${cid}','facultyId',this.value)">
          <option value="">Choose a teacher</option>${facultyOptionsHtml(c.facultyId)}
        </select></div>
      <div style="font-size:12px;color:var(--muted);padding-top:20px;">Uses the break time set above to determine second half.</div>`;
  }

  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
      <label style="margin:0;white-space:nowrap;">Rule type</label>
      <select style="flex:1;min-width:220px;" onchange="updateHCType('${cid}',this.value)">
        <option value="faculty_unavailability"   ${c.type==='faculty_unavailability'?'selected':''}>Teacher unavailable</option>
        <option value="faculty_first_half_only"  ${c.type==='faculty_first_half_only'?'selected':''}>Teacher available first half only</option>
        <option value="faculty_second_half_only" ${c.type==='faculty_second_half_only'?'selected':''}>Teacher available second half only</option>
      </select>
    </div>
    <div class="grid">${fieldsHtml}</div>
    <button class="btn btn-danger btn-sm" onclick="removeHardConstraint('${c.id}')">Remove</button>`;
  container.appendChild(card);
}

function updateHCType(cid, newType) {
  const c = hardConstraints.find(x => x.id === cid);
  if (!c) return;
  c.type = newType;
  c.facultyId = '';
  c.day       = '';
  c.timeslot  = '';
  c.courseId  = '';
  c.classroom = '';
  const container = document.getElementById('hardConstraintsContainer');
  renderHardConstraintCard(cid, container);
  markDirty();
}

function updateHC(cid, field, value) {
  const c = hardConstraints.find(x => x.id === cid);
  if (c) { c[field] = value; markDirty(); }
}

function removeHardConstraint(cid) {
  document.getElementById(cid)?.remove();
  const idx = hardConstraints.findIndex(x => x.id === cid);
  if (idx !== -1) hardConstraints.splice(idx, 1);
  markDirty();
}

// ── Soft Constraints ────────────────────────────────────────────────
function addSoftConstraint() {
  const container = document.getElementById('softConstraintsContainer');
  const cid = uid('soft');
  softConstraints.push({ id: cid, type: 'faculty_prefers_first_half', facultyId: '', courseId: '', preference: 'morning', weight: 50, label: '' });
  renderSoftConstraintCard(cid, container);
  markDirty();
}

function renderSoftConstraintCard(cid, container) {
  const c = softConstraints.find(x => x.id === cid);
  if (!c) return;
  const existing = document.getElementById(c.id);
  if (existing) existing.remove();

  const card = document.createElement('div');
  card.className = 'card'; card.id = c.id;

  let fieldsHtml = '';
  if (c.type === 'faculty_prefers_first_half') {
    fieldsHtml = `
      <div><label>Teacher</label>
        <select onchange="updateSC('${cid}','facultyId',this.value)">
          <option value="">Choose a teacher</option>${facultyOptionsHtml(c.facultyId)}
        </select></div>`;
  } else if (c.type === 'faculty_prefers_second_half') {
    fieldsHtml = `
      <div><label>Teacher</label>
        <select onchange="updateSC('${cid}','facultyId',this.value)">
          <option value="">Choose a teacher</option>${facultyOptionsHtml(c.facultyId)}
        </select></div>`;
  } else if (c.type === 'no_back_to_back_course') {
    fieldsHtml = `<div style="font-size:12px;color:var(--muted);padding-top:20px;">Applies to all courses and standards — penalises any course taught to the same standard in consecutive time slots on the same day.</div>`;
  } else if (c.type === 'balanced_daily_load') {
    fieldsHtml = `<div style="font-size:12px;color:var(--muted);padding-top:20px;">Applies to all faculty — penalises uneven load distribution across the week.</div>`;
  } else if (c.type === 'course_preferred_slot') {
    fieldsHtml = `
      <div><label>Course</label>
        <select onchange="updateSC('${cid}','courseId',this.value)">
          <option value="">Choose a course</option>${courseOptionsHtml(c.courseId)}
        </select></div>
      <div><label>Preferred time</label>
        <select onchange="updateSC('${cid}','preference',this.value)">
          <option value="morning"   ${c.preference==='morning'?'selected':''}>Morning (first half)</option>
          <option value="afternoon" ${c.preference==='afternoon'?'selected':''}>Afternoon (second half)</option>
          <option value="last"      ${c.preference==='last'?'selected':''}>Last slot of day</option>
        </select></div>`;
  }

  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
      <label style="margin:0;white-space:nowrap;">Preference type</label>
      <select style="flex:1;min-width:220px;" onchange="updateSCType('${cid}',this.value)">
        <option value="faculty_prefers_first_half"  ${c.type==='faculty_prefers_first_half'?'selected':''}>Teacher prefers the first half</option>
        <option value="faculty_prefers_second_half" ${c.type==='faculty_prefers_second_half'?'selected':''}>Teacher prefers the second half</option>
        <option value="no_back_to_back_course"      ${c.type==='no_back_to_back_course'?'selected':''}>No back-to-back periods of the same course</option>
        <option value="balanced_daily_load"         ${c.type==='balanced_daily_load'?'selected':''}>Even daily load for a teacher</option>
        <option value="course_preferred_slot"       ${c.type==='course_preferred_slot'?'selected':''}>Course prefers a time of day</option>
      </select>
      <div style="display:flex;align-items:center;gap:6px;">
        <label style="margin:0;white-space:nowrap;font-size:12px;">Weight</label>
        <input type="number" value="${c.weight}" min="1" max="200" style="width:70px;"
          onchange="updateSC('${cid}','weight',parseInt(this.value))">
      </div>
    </div>
    <div class="grid">${fieldsHtml}</div>
    <button class="btn btn-danger btn-sm" onclick="removeSoftConstraint('${c.id}')">Remove</button>`;
  container.appendChild(card);
}

function updateSCType(cid, newType) {
  const c = softConstraints.find(x => x.id === cid);
  if (!c) return;
  c.type       = newType;
  c.facultyId  = '';
  c.courseId   = '';
  c.preference = 'morning';
  const container = document.getElementById('softConstraintsContainer');
  renderSoftConstraintCard(cid, container);
  markDirty();
}

function updateSC(cid, field, value) {
  const c = softConstraints.find(x => x.id === cid);
  if (c) { c[field] = value; markDirty(); }
}

function removeSoftConstraint(cid) {
  document.getElementById(cid)?.remove();
  const idx = softConstraints.findIndex(x => x.id === cid);
  if (idx !== -1) softConstraints.splice(idx, 1);
  markDirty();
}

// ── Refresh constraint dropdowns when faculty/courses/rooms change ──
function refreshConstraintDropdowns() {
  const hardContainer = document.getElementById('hardConstraintsContainer');
  hardConstraints.forEach(c => {
    if (document.getElementById(c.id)) renderHardConstraintCard(c.id, hardContainer);
  });
  const softContainer = document.getElementById('softConstraintsContainer');
  softConstraints.forEach(c => {
    if (document.getElementById(c.id)) renderSoftConstraintCard(c.id, softContainer);
  });
}

// Timetable functions
// esc() (defined below) HTML-escapes text content. escAttr() safely embeds a
// JS value as a quoted string literal inside an inline onclick/onchange attribute.
function escAttr(value) {
  return esc(JSON.stringify(String(value)));
}

function createPreviewTable(schedule) {
  const container = document.getElementById('previewContainer');
  let html = '<div class="table-wrapper"><table><thead><tr><th>Day</th><th>Standard</th><th>Course</th><th>Faculty</th><th>Classroom</th><th>Time</th></tr></thead><tbody>';

  Object.entries(schedule).forEach(([day, classes]) => {
    classes.forEach((cls, idx) => {
      html += `<tr>
        ${idx === 0 ? `<td rowspan="${classes.length}"><strong>${esc(day)}</strong></td>` : ''}
        <td>${esc(cls.standard)}</td>
        <td>${esc(cls.course)}</td>
        <td>${esc(cls.faculty)}</td>
        <td>${esc(cls.classroom)}</td>
        <td>${esc(cls.startTime)} - ${esc(cls.endTime)}</td>
      </tr>`;
    });
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function toggleMoreDetails() {
  const section = document.getElementById('moreDetailsSection');
  section.style.display = section.style.display === 'none' ? 'block' : 'none';
}

function createStandardTimetables(schedule) {
  const container = document.getElementById('standardTimetablesContainer');
  let html = '';

  const allStandards = new Set();
  Object.values(schedule).forEach(dayClasses => {
    dayClasses.forEach(cls => allStandards.add(cls.standard));
  });

  Array.from(allStandards).forEach(standard => {
    const safeId = standard.replace(/[^a-zA-Z0-9_-]/g, '_');
    html += `<div class="result-card">
      <h4>${esc(standard)}</h4>
      <div class="export-btn-row" style="margin-bottom: 10px;">
        <button class="btn btn-sm" onclick="createStandardTable(${escAttr(standard)}, ${escAttr(standard)})" style="width: auto;">Generate</button>
        <button class="btn btn-sm" onclick="downloadStandardAsExcel(${escAttr(standard)})" style="width: auto;">Excel</button>
        <button class="btn btn-sm" onclick="downloadStandardAsPdf(${escAttr(safeId)}, ${escAttr(standard)})" style="width: auto;">PDF</button>
        <button class="btn btn-sm" onclick="downloadStandardAsImage(${escAttr(safeId)})" style="width: auto;">Image</button>
      </div>
      <div id="table-${safeId}"></div>
    </div>`;
  });

  container.innerHTML = html || '<p style="color:var(--muted);font-size:13px;">No standards found.</p>';
}

function createStandardTable(standard, standardLabel) {
  const containerId = `table-${standard.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const container = document.getElementById(containerId);

  if (!container) return;

  const allDays = Object.keys(currentScheduleData).sort((a, b) => {
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return dayOrder.indexOf(a) - dayOrder.indexOf(b);
  });

  const allTimes = new Set();
  Object.values(currentScheduleData).forEach(dayClasses => {
    dayClasses.forEach(cls => {
      if (cls.standard === standard) {
        allTimes.add(cls.startTime);
      }
    });
  });

  const times = Array.from(allTimes).sort();

  let html = '<div class="table-wrapper"><table style="width: 100%; border-collapse: collapse; margin-top: 10px;"><thead><tr><th style="border: 1px solid var(--border); padding: 8px; background: var(--surface-sunken); color: var(--text-secondary);">Time</th>';

  allDays.forEach(day => {
    html += `<th style="border: 1px solid var(--border); padding: 8px; background: var(--surface-sunken); color: var(--text-secondary);">${esc(day)}</th>`;
  });

  html += '</tr></thead><tbody>';

  times.forEach(time => {
    html += `<tr><td style="border: 1px solid var(--border); padding: 8px; font-weight: 600; background: var(--surface-sunken); color: var(--text);">${esc(time)}</td>`;

    allDays.forEach(day => {
      const classAtTime = currentScheduleData[day]?.find(c =>
        c.standard === standard && c.startTime === time
      );

      const cellContent = classAtTime
        ? `<strong style="color:var(--accent);">${esc(classAtTime.course)}</strong><br><span style="color:var(--text-secondary);">${esc(classAtTime.faculty)}</span><br><span style="color:var(--muted);">${esc(classAtTime.classroom)}</span>`
        : '<span style="color:var(--faint);">—</span>';

      html += `<td style="border: 1px solid var(--border); padding: 8px; background: ${classAtTime ? 'var(--accent-soft)' : 'var(--surface)'}; text-align:center;">${cellContent}</td>`;
    });

    html += '</tr>';
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

// CSV-safe cell: doubles embedded quotes, and neutralizes leading =/+/-/@
// so a name like "=HYPERLINK(...)" can't execute as a formula on open.
function csvCell(value) {
  let s = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function downloadStandardAsExcel(standard) {
  if (!currentScheduleData) {
    showAlert('No schedule generated yet', 'error');
    return;
  }

  let csv = 'Time,';
  const allDays = Object.keys(currentScheduleData).sort((a, b) => {
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return dayOrder.indexOf(a) - dayOrder.indexOf(b);
  });
  allDays.forEach(day => csv += `${csvCell(day)},`);
  csv += '\n';

  const allTimes = new Set();
  Object.values(currentScheduleData).forEach(dayClasses => {
    dayClasses.forEach(cls => {
      if (cls.standard === standard) {
        allTimes.add(cls.startTime);
      }
    });
  });

  const times = Array.from(allTimes).sort();
  times.forEach(time => {
    csv += `${csvCell(time)},`;
    allDays.forEach(day => {
      const classAtTime = currentScheduleData[day]?.find(c =>
        c.standard === standard && c.startTime === time
      );
      csv += `${csvCell(classAtTime ? `${classAtTime.course} - ${classAtTime.faculty}` : '—')},`;
    });
    csv += '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${standard.replace(/\s+/g, '_')}_timetable.csv`;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);

  showAlert(`Timetable for ${standard} downloaded`, 'success');
}

function downloadStandardAsImage(standardId) {
  const element = document.getElementById(`table-${standardId}`);
  if (!element || element.innerHTML.trim() === '') {
    showAlert('Generate the table first', 'error');
    return;
  }

  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  document.head.appendChild(script);

  script.onload = function () {
    html2canvas(element, { backgroundColor: '#ffffff' }).then(canvas => {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `${standardId}_timetable.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showAlert('Image downloaded', 'success');
    });
  };
}

// ── Faculty-wise Timetable Functions ─────────────────────────────
function populateFacultyTimetableDropdown() {
  const select = document.getElementById('facultyTimetableSelect');
  if (!select) return;
  select.innerHTML = '<option value="">Choose a teacher</option>';
  // Clear any previously shown timetables
  document.getElementById('facultyTimetablesContainer').innerHTML = '';

  // Gather unique faculty from the generated schedule
  if (!currentScheduleData) return;
  const facSet = new Map(); // facultyName → facultyCode
  Object.values(currentScheduleData).forEach(dayClasses => {
    dayClasses.forEach(cls => {
      if (cls.faculty && !facSet.has(cls.faculty)) {
        facSet.set(cls.faculty, cls.facultyCode || '');
      }
    });
  });

  facSet.forEach((code, name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = code ? `${name} (${code})` : name;
    select.appendChild(opt);
  });
}

function showFacultyTimetable() {
  const select = document.getElementById('facultyTimetableSelect');
  const facultyName = select.value;
  if (!facultyName) {
    showAlert('Choose a teacher first', 'error');
    return;
  }
  if (!currentScheduleData) {
    showAlert('No schedule generated yet', 'error');
    return;
  }

  const container = document.getElementById('facultyTimetablesContainer');
  const safeId = 'fac-' + facultyName.replace(/[^a-zA-Z0-9]/g, '_');

  // Don't duplicate — if already shown, just scroll to it
  if (document.getElementById(safeId)) {
    document.getElementById(safeId).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  // Build the card
  const card = document.createElement('div');
  card.id = safeId;
  card.className = 'result-card';
  card.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
      <h4 style="margin:0;">${esc(facultyName)}</h4>
      <div class="export-btn-row">
        <button class="btn btn-sm" onclick="downloadFacultyAsExcel(${escAttr(facultyName)})" style="width:auto;">CSV</button>
        <button class="btn btn-sm" onclick="downloadFacultyAsPdf(${escAttr(safeId)}, ${escAttr(facultyName)})" style="width:auto;">PDF</button>
        <button class="btn btn-sm" onclick="downloadFacultyAsImage(${escAttr(safeId)})" style="width:auto;">Image</button>
        <button class="btn btn-danger btn-sm" onclick="document.getElementById(${escAttr(safeId)}).remove()" style="margin:0;">Close</button>
      </div>
    </div>
    <div id="${safeId}-table"></div>`;
  container.prepend(card);

  // Build the table
  createFacultyTable(facultyName, `${safeId}-table`);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function createFacultyTable(facultyName, containerId) {
  const container = document.getElementById(containerId);
  if (!container || !currentScheduleData) return;

  const allDays = Object.keys(currentScheduleData).sort((a, b) => {
    const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    return dayOrder.indexOf(a) - dayOrder.indexOf(b);
  });

  // Collect time slots where this faculty has any class
  const allTimes = new Set();
  Object.values(currentScheduleData).forEach(dayClasses => {
    dayClasses.forEach(cls => {
      if (cls.faculty === facultyName) allTimes.add(cls.startTime);
    });
  });
  const times = Array.from(allTimes).sort();

  if (times.length === 0) {
    container.innerHTML = '<p style="color:var(--muted); font-size:13px;">No classes found for this faculty.</p>';
    return;
  }

  let html = '<div class="table-wrapper"><table style="width:100%; border-collapse:collapse; margin-top:10px;"><thead><tr>';
  html += '<th style="border:1px solid var(--border); padding:8px; background:var(--surface-sunken); color:var(--text-secondary);">Time</th>';
  allDays.forEach(day => {
    html += `<th style="border:1px solid var(--border); padding:8px; background:var(--surface-sunken); color:var(--text-secondary);">${esc(day)}</th>`;
  });
  html += '</tr></thead><tbody>';

  times.forEach(time => {
    html += `<tr><td style="border:1px solid var(--border); padding:8px; font-weight:600; background:var(--surface-sunken); color:var(--text);">${esc(time)}</td>`;
    allDays.forEach(day => {
      const cls = (currentScheduleData[day] || []).find(c =>
        c.faculty === facultyName && c.startTime === time
      );
      const cellContent = cls
        ? `<strong style="color:var(--accent);">${esc(cls.course)}</strong><br><span style="color:var(--text-secondary);">${esc(cls.standard)}</span><br><span style="color:var(--muted);">${esc(cls.classroom)}</span>`
        : '<span style="color:var(--faint);">—</span>';
      html += `<td style="border:1px solid var(--border); padding:8px; background:${cls ? 'var(--accent-soft)' : 'var(--surface)'}; text-align:center;">${cellContent}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  container.innerHTML = html;
}

function downloadFacultyAsExcel(facultyName) {
  if (!currentScheduleData) {
    showAlert('No schedule generated yet', 'error');
    return;
  }

  const allDays = Object.keys(currentScheduleData).sort((a, b) => {
    const dayOrder = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
    return dayOrder.indexOf(a) - dayOrder.indexOf(b);
  });

  let csv = 'Time,';
  allDays.forEach(day => csv += `${csvCell(day)},`);
  csv += '\n';

  const allTimes = new Set();
  Object.values(currentScheduleData).forEach(dayClasses => {
    dayClasses.forEach(cls => {
      if (cls.faculty === facultyName) allTimes.add(cls.startTime);
    });
  });

  const times = Array.from(allTimes).sort();
  times.forEach(time => {
    csv += `${csvCell(time)},`;
    allDays.forEach(day => {
      const cls = (currentScheduleData[day] || []).find(c =>
        c.faculty === facultyName && c.startTime === time
      );
      csv += `${csvCell(cls ? `${cls.course} - ${cls.standard} (${cls.classroom})` : '—')},`;
    });
    csv += '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${facultyName.replace(/\s+/g, '_')}_timetable.csv`;
  document.body.appendChild(a);
  a.click();
  window.URL.revokeObjectURL(url);
  document.body.removeChild(a);
  showAlert(`Timetable for ${facultyName} downloaded`, 'success');
}

function downloadFacultyAsImage(safeId) {
  const element = document.getElementById(`${safeId}-table`);
  if (!element || element.innerHTML.trim() === '') {
    showAlert('Open the timetable first', 'error');
    return;
  }

  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  document.head.appendChild(script);

  script.onload = function () {
    html2canvas(element, { backgroundColor: '#FFFFFF' }).then(canvas => {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `${safeId}_timetable.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showAlert('Image downloaded', 'success');
    });
  };
}

// Main timetable generation
async function generateTimetable() {
  const genBtn = document.getElementById('generateBtn');
  if (genBtn && genBtn.disabled) return; // already generating — ignore extra clicks

  if (standards.length === 0 || standards.some(s => s.courses.length === 0)) {
    showAlert('Please add at least one standard with courses', 'error'); return;
  }
  if (faculty.length === 0) { showAlert('Please add at least one faculty member', 'error'); return; }
  if (assignments.length === 0) { showAlert('Please add at least one course assignment', 'error'); return; }
  if (assignments.some(a => !a.courseId || !a.facultyId)) {
    showAlert('Every assignment needs both a course and a faculty selected — remove or complete any incomplete assignments', 'error');
    return;
  }
  const rooms = getClassrooms();
  if (rooms.length === 0) { showAlert('Please add at least one classroom', 'error'); return; }
  const roomNames = rooms.map(r => r.name.trim().toLowerCase());
  const dupIdx = roomNames.findIndex((n, i) => roomNames.indexOf(n) !== i);
  if (dupIdx !== -1) { showAlert(`Duplicate classroom "${rooms[dupIdx].name}" — classroom names must be unique`, 'error'); return; }
  if (selectedDays.length === 0) { showAlert('Please select at least one day', 'error'); return; }
  const slots = collectTimeSlots();
  if (slots.length === 0) { showAlert('Please add at least one time slot', 'error'); return; }

  setGeneratingUi(true);
  document.getElementById('outputSection').style.display = 'none';
  document.getElementById('slowPanel').style.display = 'none';

  try {
    const response = await authFetch(`${API_BASE_URL}/api/generate-timetable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJ_ID,
        standards, faculty, assignments, classrooms: rooms,
        daysOfWeek: selectedDays,
        timeSlots: slots,
        hardConstraints, softConstraints,
        breakTime
      })
    });

    const data = await response.json();

    if (!response.ok) {
      // Provably impossible — never even starts the search
      if (data.impossible && data.reasons && data.reasons.length) {
        showImpossiblePanel(data.reasons);
        return;
      }
      const msg = data.errors && data.errors.length
        ? data.errors.map((e, i) => `${i+1}. ${e}`).join('\n')
        : (data.error || 'Failed to generate timetable');
      throw new Error(msg);
    }

    activeJobId = data.jobId;
    await pollJob(data.jobId);

  } catch (error) {
    showAlert('Error: ' + error.message, 'error');
    console.error(error);
  } finally {
    setGeneratingUi(false);
  }
}

// ── Generation job: progress, escalation, cancellation ───────────────
let activeJobId = null;
let jobStartedAt = 0;

function setGeneratingUi(running) {
  const genBtn = document.getElementById('generateBtn');
  document.getElementById('loadingIndicator').classList.toggle('active', running);
  if (genBtn) {
    genBtn.disabled = running;
    genBtn.style.opacity = running ? '0.6' : '';
    genBtn.style.cursor  = running ? 'not-allowed' : '';
  }
  if (running) {
    jobStartedAt = Date.now();
    document.getElementById('loadingHeadline').textContent = 'Generating your schedule, please wait…';
    document.getElementById('generationCount').textContent = '';
  } else {
    activeJobId = null;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pollJob(jobId, { improve = false } = {}) {
  while (true) {
    await sleep(600);
    if (activeJobId !== jobId) return;   // cancelled

    const res  = await authFetch(`${API_BASE_URL}/api/jobs/${jobId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Lost track of the generation job.');

    if (data.status === 'running') { updateRunProgress(data, improve); continue; }
    if (data.status === 'cancelled') return;
    if (data.status === 'error') throw new Error(data.error || 'Generation failed.');

    if (data.status === 'done') {
      document.getElementById('slowPanel').style.display = 'none';
      if (improve) applyImprovedSchedule(data);
      else         applyGeneratedSchedule(data);
      return;
    }
  }
}

function updateRunProgress(data, improve = false) {
  const secs = Math.floor(data.elapsedMs / 1000);
  const p    = data.progress || {};
  const bits = [];
  if (p.totalGenerations) bits.push(`generation ${p.totalGenerations.toLocaleString()}`);
  if (improve) {
    // Hard constraints are already met here — the number that matters is the
    // soft penalty coming down, not clashes.
    if (p.softPenalty !== undefined && p.softPenalty !== null) bits.push(`preference score ${p.softPenalty}`);
  } else if (p.conflicts !== null && p.conflicts !== undefined) {
    bits.push(`${p.conflicts} clash${p.conflicts === 1 ? '' : 'es'} left`);
  }
  bits.push(`${secs}s`);
  document.getElementById('generationCount').textContent = bits.join(' · ');

  if (improve) return;   // an improve run is bounded; no stagnation advice needed

  // Escalate: quiet for the first minute, advice after one, firmer after two.
  const headline = document.getElementById('loadingHeadline');
  if (secs >= 120) {
    headline.textContent = 'This is taking much longer than expected.';
    showSlowPanel(data.diagnostics, 'severe');
  } else if (secs >= 60) {
    headline.textContent = 'Taking longer than usual…';
    showSlowPanel(data.diagnostics, 'warn');
  }
}

/** Advice shown during a slow run — deliberately left on screen after Cancel. */
function showSlowPanel(diagnostics, level) {
  const panel = document.getElementById('slowPanel');
  if (!diagnostics) return;
  if (panel.dataset.level === level) return;   // already rendered at this level
  panel.dataset.level = level;

  const severe = level === 'severe';
  const tight = (diagnostics.tight || []).map(t =>
    `<li style="margin-bottom:4px;"><strong>${esc(t.name)}</strong> — ${t.used} of ${t.capacity} periods used (${t.percent}%)</li>`).join('');

  panel.style.cssText = `background:var(--${severe ? 'danger' : 'warning'}-soft);border:1px solid var(--${severe ? 'danger' : 'warning'}-border);border-radius:var(--radius);padding:18px;margin:18px 0;`;
  panel.innerHTML = `
    <h3 style="color:var(--${severe ? 'danger' : 'warning'});margin:0 0 8px 0;font-size:15px;">
      ${severe ? 'Still searching — this schedule looks very tight' : 'This is taking longer than usual'}
    </h3>
    <p style="color:var(--text-secondary);font-size:13px;margin:0 0 12px 0;line-height:1.6;">
      ${severe
        ? 'The scheduler will keep trying for as long as you let it, but these inputs leave it very little room. Consider the changes below, then cancel and generate again.'
        : 'The scheduler is still working. You can let it continue, or apply one of these changes and try again.'}
    </p>
    ${tight ? `<p style="font-size:12px;font-weight:600;color:var(--text);margin:0 0 6px 0;">Under most pressure</p>
    <ul style="margin:0 0 12px 0;padding-left:20px;font-size:13px;color:var(--text-secondary);line-height:1.5;">${tight}</ul>` : ''}
    <p style="font-size:12px;font-weight:600;color:var(--text);margin:0 0 6px 0;">Suggested changes</p>
    <ul style="margin:0;padding-left:20px;font-size:13px;color:var(--text-secondary);line-height:1.6;">
      ${(diagnostics.suggestions || []).map(s => `<li style="margin-bottom:5px;">${esc(s)}</li>`).join('')}
    </ul>`;
  panel.style.display = 'block';
}

async function cancelGeneration() {
  if (!activeJobId) return;
  const jobId = activeJobId;
  activeJobId = null;                     // stops the poll loop
  setGeneratingUi(false);
  try { await authFetch(`${API_BASE_URL}/api/jobs/${jobId}`, { method: 'DELETE' }); } catch {}
  // The advice panel deliberately stays up so it can be acted on.
  showAlert('Generation cancelled.', 'info');
}

function applyGeneratedSchedule(data, { announce = true, mode = 'generate' } = {}) {
  lastRunMs = data.elapsedMs ?? (jobStartedAt ? Date.now() - jobStartedAt : null);
  generatedFilename    = data.filename;
  currentScheduleData  = data.data;
  currentSolutionGenes = data.genes || currentSolutionGenes;
  currentStats         = data.stats;

  document.getElementById('conflictCount').textContent = data.stats.conflicts;
  document.getElementById('fitnessScore').textContent  = data.stats.fitness;
  document.getElementById('classCount').textContent    = data.stats.classCount;

  renderSoftReport(data.stats.softReport || [], data.stats.conflicts);
  renderHardStatus(data.stats.conflicts);

  createPreviewTable(data.data);
  createStandardTimetables(data.data);
  populateFacultyTimetableDropdown();
  renderPreferenceSummary(data.stats);

  document.getElementById('outputSection').style.display = 'block';
  document.getElementById('impossiblePanel')?.remove();

  noteRun({ mode, stats: data.stats });
  renderReadyPanel();

  if (announce) {
    toast(`Schedule generated — ${data.stats.classCount} classes, ${data.stats.conflicts} conflicts`, { type: 'success' });
  }
}

// ── Demo data ───────────────────────────────────────────────────────
function projectHasData() {
  return standards.length > 0 || faculty.length > 0 || classrooms.length > 0 ||
         assignments.length > 0 || hardConstraints.length > 0 || softConstraints.length > 0;
}

async function fillDemoData() {
  if (projectHasData() && !(await Schedura.confirm({
    title: 'Replace everything in this project?',
    body: 'The sample school overwrites the standards, teachers, classrooms, assignments and rules already here. This cannot be undone.',
    confirmLabel: 'Replace with sample',
    danger: true
  }))) return;

  const btns = ['demoBtn', 'demoBtnEmpty'].map(id => document.getElementById(id)).filter(Boolean);
  const originals = btns.map(b => b.textContent);
  btns.forEach(b => { b.disabled = true; b.textContent = 'Loading sample school…'; });

  try {
    const res  = await authFetch(`${API_BASE_URL}/api/demo-data`);
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(body.error || 'Could not load the demo data.');
    const d = body.data;

    // Replace the in-memory model wholesale, then rebuild the UI from it
    standards       = d.standards;
    faculty         = d.faculty;
    assignments     = d.assignments;
    classrooms      = d.classrooms;
    selectedDays    = d.selectedDays;
    timeSlotValues  = d.timeSlotValues;
    hardConstraints = d.hardConstraints;
    softConstraints = d.softConstraints;
    breakTime       = d.breakTime;

    generatedFilename = null; currentScheduleData = null;
    currentSolutionGenes = null; currentStats = null; previousResult = null;

    document.getElementById('standardsContainer').innerHTML = '';
    document.getElementById('facultyContainer').innerHTML   = '';
    document.getElementById('roomContainer').innerHTML      = '';
    document.getElementById('hardConstraintsContainer').innerHTML = '';
    document.getElementById('softConstraintsContainer').innerHTML = '';
    document.getElementById('outputSection').style.display = 'none';
    document.getElementById('preferencesBlock').style.display = 'none';
    document.getElementById('slowPanel').style.display = 'none';
    document.getElementById('impossiblePanel')?.remove();

    classrooms.forEach(renderRoomCard);
    standards.forEach(renderStandardCard);
    faculty.forEach(fac => renderFacultyCard(fac));
    document.querySelectorAll('#daysCheckboxes input[type="checkbox"]').forEach(cb => {
      cb.checked = selectedDays.includes(cb.value);
    });
    renderTimeSlots();
    document.getElementById('breakStartInput').value = breakTime.start || '';
    document.getElementById('breakEndInput').value   = breakTime.end   || '';
    hardConstraints.forEach(c => renderHardConstraintCard(c.id, document.getElementById('hardConstraintsContainer')));
    softConstraints.forEach(c => renderSoftConstraintCard(c.id, document.getElementById('softConstraintsContainer')));
    renderAssignmentMatrix();

    markDirty();
    toast(`Sample school loaded — ${standards.length} standards, ${allDivisions().length} divisions, ${faculty.length} teachers`, { type: 'success' });
    goToStep('schedule');

  } catch (err) {
    showAlert('Error: ' + err.message, 'error');
  } finally {
    btns.forEach((b, i) => { b.disabled = false; b.textContent = originals[i]; });
  }
}

// ── Preferences / improve ───────────────────────────────────────────
let currentSolutionGenes = null;
let currentStats         = null;
let previousResult       = null;   // snapshot to fall back to after an improve

function softScoreText(stats) {
  if (!stats || !stats.softTotal) return 'No soft constraints defined — nothing to optimise.';
  return `${stats.softMet} of ${stats.softTotal} preference${stats.softTotal === 1 ? '' : 's'} met.`;
}

function renderPreferenceSummary(stats) {
  const block = document.getElementById('preferencesBlock');
  const hasSoft = stats && stats.softTotal > 0;
  block.style.display = 'block';

  const penalty = stats && stats.softPenalty;
  const scoreBit = (penalty !== undefined && penalty !== null)
    ? ` Preference score ${penalty} (lower is better).` : '';

  document.getElementById('preferenceSummary').textContent = hasSoft
    ? `${softScoreText(stats)}${scoreBit} Hard constraints are fully satisfied — you can spend more time trying to do better on preferences.`
    : 'No soft constraints defined. Add some above if you want the scheduler to optimise for preferences.';

  // Offer improvement whenever there is any penalty left, not only when a
  // preference is fully unmet — a run can cut the penalty substantially
  // without flipping any single constraint to "satisfied".
  const roomToImprove = penalty === undefined || penalty === null
    ? stats.softMet < stats.softTotal
    : penalty > 0;
  document.getElementById('improveBtn').style.display = hasSoft && roomToImprove ? 'inline-block' : 'none';
  document.getElementById('improveComparison').innerHTML = '';
}

async function improveSchedule() {
  if (!currentSolutionGenes) { showAlert('Generate a schedule first', 'error'); return; }
  const improveBtn = document.getElementById('improveBtn');
  if (improveBtn.disabled) return;

  // Snapshot so the user can go back if they prefer the original
  previousResult = {
    filename: generatedFilename,
    data: currentScheduleData,
    genes: currentSolutionGenes,
    stats: currentStats
  };

  improveBtn.disabled = true;
  setGeneratingUi(true);
  document.getElementById('loadingHeadline').textContent = 'Looking for a schedule that meets more preferences…';

  try {
    const res = await authFetch(`${API_BASE_URL}/api/improve-timetable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: PROJ_ID,
        genes: currentSolutionGenes,
        standards, faculty, assignments, classrooms: getClassrooms(),
        daysOfWeek: selectedDays, timeSlots: collectTimeSlots(),
        hardConstraints, softConstraints, breakTime
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start the improvement run.');

    activeJobId = data.jobId;
    await pollJob(data.jobId, { improve: true });

  } catch (err) {
    showAlert('Error: ' + err.message, 'error');
  } finally {
    setGeneratingUi(false);
    improveBtn.disabled = false;
  }
}

function applyImprovedSchedule(data) {
  const before = previousResult.stats;
  const after  = data.stats;

  applyGeneratedSchedule(data, { announce: false, mode: 'improve' });

  const panel = document.getElementById('improveComparison');

  // The penalty is the real quality measure. "Preferences met" only flips
  // when a constraint reaches zero violations, so a run can cut the penalty
  // a long way without changing it — judging by met-count alone would throw
  // a genuinely better schedule away.
  const beforePenalty = before.softPenalty;
  const afterPenalty  = after.softPenalty;
  const havePenalty   = Number.isFinite(beforePenalty) && Number.isFinite(afterPenalty);
  const better = havePenalty ? afterPenalty < beforePenalty
                             : (after.softMet || 0) > (before.softMet || 0);

  if (!better) {
    panel.innerHTML = `
      <div style="margin-top:14px;padding:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);">
        <p style="margin:0;font-size:13px;color:var(--text-secondary);">
          No further improvement found — the previous schedule was already the best this search could reach
          (${softScoreText(before)}). Your schedule is unchanged.
        </p>
      </div>`;
    keepPreviousSchedule({ silent: true });
    return;
  }

  const pct = havePenalty && beforePenalty > 0
    ? Math.round(((beforePenalty - afterPenalty) / beforePenalty) * 100) : null;

  const metLine = (after.softMet || 0) > (before.softMet || 0)
    ? `<li>Preferences fully met: <strong>${before.softMet} of ${before.softTotal}</strong> → <strong>${after.softMet} of ${after.softTotal}</strong></li>`
    : `<li>Preferences fully met: unchanged at <strong>${after.softMet} of ${after.softTotal}</strong> — but the remaining ones are broken less often</li>`;

  panel.innerHTML = `
    <div style="margin-top:14px;padding:16px;background:var(--success-soft);border:1px solid var(--success-border);border-radius:var(--radius);">
      <h4 style="margin:0 0 8px 0;font-size:14px;color:var(--success);">A better schedule was found</h4>
      <ul style="margin:0 0 12px 0;padding-left:20px;font-size:13px;color:var(--text-secondary);line-height:1.6;">
        ${havePenalty ? `<li>Preference score: <strong>${beforePenalty}</strong> → <strong>${afterPenalty}</strong>${pct !== null ? ` (${pct}% better)` : ''}</li>` : ''}
        ${metLine}
        <li>Hard constraints: still fully satisfied</li>
      </ul>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-sm" style="margin-right:0;" onclick="keepImprovedSchedule()">Keep the new one</button>
        <button class="btn btn-sm" style="margin-right:0;" onclick="keepPreviousSchedule()">Keep the previous one</button>
      </div>
    </div>`;
}

function keepImprovedSchedule() {
  previousResult = null;
  document.getElementById('improveComparison').innerHTML = '';
  renderPreferenceSummary(currentStats);
  showAlert('Improved schedule kept.', 'success');
}

async function keepPreviousSchedule({ silent = false } = {}) {
  if (!previousResult) return;
  const restore = previousResult;
  previousResult = null;
  applyGeneratedSchedule(restore, { announce: false });

  // Put the original back on the server too, so downloads and reloads match
  if (PROJ_ID) {
    try {
      await authFetch(`${API_BASE_URL}/api/projects/${PROJ_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scheduleData: restore.data,
          scheduleStats: restore.stats,
          generatedFilename: restore.filename
        })
      });
    } catch {}
  }
  if (!silent) showAlert('Kept the previous schedule.', 'info');
}

function showImpossiblePanel(reasons) {
  document.getElementById('impossiblePanel')?.remove();
  const panel = document.createElement('div');
  panel.id = 'impossiblePanel';
  panel.style.cssText = 'background:var(--danger-soft);border:1px solid var(--danger-border);border-radius:var(--radius);padding:18px;margin:18px 0;';
  panel.innerHTML = `
    <h3 style="color:var(--danger);margin:0 0 10px 0;font-size:15px;">This schedule is not possible</h3>
    <p style="color:var(--text-secondary);font-size:13px;margin:0 0 10px 0;">The current inputs cannot produce a valid schedule. Please resolve the following:</p>
    <ul style="margin:0;padding-left:20px;color:var(--danger);font-size:13px;line-height:1.6;">
      ${reasons.map(r => `<li style="margin-bottom:6px;">${esc(r)}</li>`).join('')}
    </ul>`;
  document.getElementById('alertContainer').after(panel);
}

function renderSoftReport(report, conflicts) {
  const section = document.getElementById('softReportSection');
  const list    = document.getElementById('softReportList');
  if (!report || report.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = report.map(r => {
    const color = r.satisfied ? 'var(--success)' : 'var(--danger)';
    return `<div style="padding:10px 14px;margin-bottom:8px;background:var(--surface);border:1px solid ${r.satisfied ? 'var(--success-border)' : 'var(--danger-border)'};border-radius:var(--radius);">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:${color};font-size:13px;font-weight:600;">${esc(r.label || r.type)}</span>
        <span style="color:var(--muted);font-size:11px;">weight: ${r.weight}</span>
      </div>
      <div style="color:var(--text-secondary);font-size:12px;margin-top:4px;">${esc(r.detail)}</div>
      ${r.violations > 0 ? `<div style="color:var(--warning);font-size:11px;margin-top:2px;">${r.violations} violation(s)</div>` : ''}
    </div>`;
  }).join('');
}

function renderHardStatus(conflicts) {
  const el = document.getElementById('hardConstraintStatus');
  if (!hardConstraints.length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:13px;">No hard rules defined.</span>';
    return;
  }
  const typeLabels = {
    faculty_unavailability:  'Teacher unavailable',
    faculty_first_half_only: 'Teacher available first half only'
  };
  el.innerHTML = hardConstraints.map(hc => {
    const ok    = conflicts === 0;
    const color = ok ? 'var(--success)' : 'var(--danger)';
    return `<div style="padding:8px 12px;margin-bottom:6px;background:var(--surface);border:1px solid ${ok ? 'var(--success-border)' : 'var(--danger-border)'};border-radius:var(--radius);font-size:13px;color:${color};">
      ${esc(typeLabels[hc.type] || hc.type)}
      ${conflicts > 0 ? '<span style="color:var(--muted);font-size:11px;"> — check for conflicts above</span>' : ' — satisfied'}
    </div>`;
  }).join('') || '<span style="color:var(--muted);font-size:13px;">No hard rules.</span>';
}

/**
 * /output/:filename sits behind requireAuth, and a plain <a href> sends no
 * Authorization header — so this has to fetch the file with the session token
 * and hand the browser a blob.
 */
async function downloadExcel() {
  if (!generatedFilename) {
    showAlert('No schedule to download', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/output/${generatedFilename}`, {
      credentials: 'same-origin',
      headers: Schedura.auth.token ? { Authorization: `Bearer ${Schedura.auth.token}` } : {}
    });
    if (!res.ok) throw new Error(res.status === 404 ? 'That file is no longer on the server — generate again.' : 'Download failed.');

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = generatedFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast('Excel file downloaded', { type: 'success' });
  } catch (error) {
    showAlert('Could not download: ' + error.message, 'error');
  }
}

function downloadAsImage() {
  const element = document.getElementById('previewContainer');
  if (!element) {
    showAlert('No schedule to download', 'error');
    return;
  }

  const script = document.createElement('script');
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  document.head.appendChild(script);

  script.onload = function () {
    html2canvas(element, { backgroundColor: '#ffffff' }).then(canvas => {
      const link = document.createElement('a');
      link.href = canvas.toDataURL('image/png');
      link.download = `spacetime_timetable_${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showAlert('Image downloaded', 'success');
    });
  };
}

// ── PDF Export Helpers ───────────────────────────────────────────
function _loadHtml2Pdf() {
  return new Promise((resolve, reject) => {
    if (window.html2pdf) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load html2pdf library'));
    document.head.appendChild(s);
  });
}

async function _exportElementAsPdf(element, filename) {
  try {
    await _loadHtml2Pdf();
    // temporarily remove scroll clipping so the full table is captured
    const wrappers = element.querySelectorAll('.table-wrapper');
    wrappers.forEach(w => { w.style.overflow = 'visible'; });

    await html2pdf().set({
      margin:      [8, 6, 8, 6],
      filename:    filename,
      image:       { type: 'jpeg', quality: 0.95 },
      html2canvas: { scale: 2, backgroundColor: '#FFFFFF', useCORS: true, scrollX: 0, scrollY: 0 },
      jsPDF:       { unit: 'mm', format: 'a4', orientation: 'landscape' },
      pagebreak:   { mode: ['avoid-all', 'css', 'legacy'] }
    }).from(element).save();

    wrappers.forEach(w => { w.style.overflow = ''; });
    showAlert('PDF downloaded', 'success');
  } catch (err) {
    console.error('PDF export error:', err);
    showAlert('Error generating PDF: ' + err.message, 'error');
  }
}

function downloadAsPdf() {
  const element = document.getElementById('previewContainer');
  if (!element || !element.innerHTML.trim()) {
    showAlert('No schedule to download', 'error');
    return;
  }
  _exportElementAsPdf(element, `spacetime_timetable_${Date.now()}.pdf`);
}

function downloadStandardAsPdf(standardId, standardName) {
  const element = document.getElementById(`table-${standardId}`);
  if (!element || !element.innerHTML.trim()) {
    showAlert('Generate the table first', 'error');
    return;
  }
  const safeName = (standardName || standardId).replace(/[^a-zA-Z0-9_ -]/g, '');
  _exportElementAsPdf(element, `${safeName}_timetable.pdf`);
}

function downloadFacultyAsPdf(safeId, facultyName) {
  const element = document.getElementById(`${safeId}-table`);
  if (!element || !element.innerHTML.trim()) {
    showAlert('Open the timetable first', 'error');
    return;
  }
  const safeName = (facultyName || safeId).replace(/[^a-zA-Z0-9_ -]/g, '');
  _exportElementAsPdf(element, `${safeName}_timetable.pdf`);
}

async function resetForm() {
  if (await Schedura.confirm({
    title: 'Clear everything in this project?',
    body: 'Every standard, teacher, classroom, assignment and rule is removed, along with the generated schedule. This cannot be undone.',
    confirmLabel: 'Clear project',
    danger: true
  })) {
    standards = []; faculty = []; assignments = []; classrooms = []; selectedDays = [];
    generatedFilename = null; timeSlotValues = [{ startTime: '', endTime: '' }];
    hardConstraints = []; softConstraints = [];
    breakTime = { start: '', end: '' };
    document.getElementById('breakStartInput').value = '';
    document.getElementById('breakEndInput').value   = '';
    document.getElementById('standardsContainer').innerHTML  = '';
    document.getElementById('facultyContainer').innerHTML    = '';
    document.getElementById('roomContainer').innerHTML       = '';
    document.getElementById('hardConstraintsContainer').innerHTML = '';
    document.getElementById('softConstraintsContainer').innerHTML = '';
    document.querySelectorAll('#daysCheckboxes input').forEach(cb => cb.checked = false);
    renderTimeSlots();
    renderAssignmentMatrix();
    document.getElementById('outputSection').style.display = 'none';
    document.getElementById('impossiblePanel')?.remove();
    currentScheduleData = null; currentSolutionGenes = null; currentStats = null;
    projectRuns = [];
    markDirty();
    toast('Project cleared');
    goToStep('standards');
  }
}

// ── Project load: restores all saved inputs + timetable on open ──
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function loadProjectData() {
  renderTimeSlots(); // default empty slot first

  if (!PROJ_ID) return; // no project = just blank form

  try {
    const data = await Schedura.api(`${API_BASE_URL}/api/projects/${PROJ_ID}`);

    if (!data.ok || !data.project) {
      showProjectMissing(data.status === 404
        ? 'This project no longer exists — it may have been deleted.'
        : (data.error || 'That project could not be loaded.'));
      return;
    }
    const p = data.project;

    setProjectName(p.name);
    projectRuns  = p.runs || [];
    projectShare = p.share || null;

    // Classrooms first — divisions reference rooms by id
    (p.classrooms||[]).forEach(room => {
      classrooms.push({ id: room.id, name: room.name });
      renderRoomCard(room);
    });

    // Standards, divisions & courses — same renderer the add buttons use
    (p.standards||[]).forEach(std => {
      standards.push({
        id: std.id,
        name: std.name,
        courses: (std.courses || []).map(c => ({ id: c.id, name: c.name, courseCode: c.courseCode })),
        divisions: (std.divisions || []).map(d => ({ id: d.id, label: d.label, roomId: d.roomId ?? null }))
      });
      renderStandardCard(standards[standards.length - 1]);
    });

    // Faculty
    (p.faculty||[]).forEach(fac => {
      faculty.push({ id: fac.id, name: fac.name, facultyCode: fac.facultyCode });
      renderFacultyCard(faculty[faculty.length - 1]);
    });

    // Days
    if (p.selectedDays && p.selectedDays.length) {
      selectedDays = [...p.selectedDays];
      document.querySelectorAll('#daysCheckboxes input[type="checkbox"]').forEach(cb => {
        cb.checked = selectedDays.includes(cb.value);
      });
    }

    // Time slots
    if (p.timeSlotValues && p.timeSlotValues.length) {
      timeSlotValues = JSON.parse(JSON.stringify(p.timeSlotValues));
      renderTimeSlots();
    }

    // Assignments (must be after standards + faculty)
    (p.assignments||[]).forEach(asgn => {
      assignments.push({
        id: asgn.id, divisionId: asgn.divisionId ?? null,
        courseId: asgn.courseId, facultyId: asgn.facultyId, timesPerWeek: asgn.timesPerWeek
      });
    });
    renderAssignmentMatrix();

    // Break time
    if (p.breakTime) {
      breakTime = p.breakTime;
      if (p.breakTime.start) document.getElementById('breakStartInput').value = p.breakTime.start;
      if (p.breakTime.end)   document.getElementById('breakEndInput').value   = p.breakTime.end;
    }

    // Hard constraints
    (p.hardConstraints||[]).forEach(c => {
      hardConstraints.push({ id: c.id, type: c.type, facultyId: c.facultyId||'', day: c.day||'', timeslot: c.timeslot||'', courseId: c.courseId||'', classroom: c.classroom||'' });
      renderHardConstraintCard(c.id, document.getElementById('hardConstraintsContainer'));
    });

    // Soft constraints
    (p.softConstraints||[]).forEach(c => {
      softConstraints.push({ id: c.id, type: c.type, facultyId: c.facultyId||'', courseId: c.courseId||'', preference: c.preference||'morning', weight: c.weight||50, label: c.label||'' });
      renderSoftConstraintCard(c.id, document.getElementById('softConstraintsContainer'));
    });

    // Restore generated timetable output
    if (p.scheduleData) {
      generatedFilename    = p.generatedFilename;
      currentScheduleData  = p.scheduleData;
      currentSolutionGenes = p.scheduleGenes || null;  // lets Improve reseed after a reload
      currentStats         = p.scheduleStats || null;
      if (p.scheduleStats) {
        document.getElementById('conflictCount').textContent = p.scheduleStats.conflicts;
        document.getElementById('fitnessScore').textContent  = p.scheduleStats.fitness;
        document.getElementById('classCount').textContent    = p.scheduleStats.classCount;
        renderSoftReport(p.scheduleStats.softReport || [], p.scheduleStats.conflicts);
        renderHardStatus(p.scheduleStats.conflicts);
        renderPreferenceSummary(p.scheduleStats);
      }
      createPreviewTable(p.scheduleData);
      createStandardTimetables(p.scheduleData);
      populateFacultyTimetableDropdown();
      document.getElementById('outputSection').style.display = 'block';
    }

  } catch(err) {
    console.error('Failed to load project:', err);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   STEPS
   ----------------------------------------------------------------------
   The editor used to be one long scroll through eight stacked sections with
   the results appended underneath. Now each stage is its own screen with its
   own URL, so the browser's back and forward buttons move between them and a
   step can be linked to directly.
   ══════════════════════════════════════════════════════════════════════ */

const STEPS = [
  { slug: 'standards',   label: 'Standards',  title: 'Standards and divisions' },
  { slug: 'classrooms',  label: 'Classrooms', title: 'Classrooms' },
  { slug: 'teachers',    label: 'Teachers',   title: 'Teachers' },
  { slug: 'timetable',   label: 'The week',   title: 'The school week' },
  { slug: 'assignments', label: 'Assign',     title: 'Who teaches what' },
  { slug: 'rules',       label: 'Rules',      title: 'Rules and preferences' },
  { slug: 'schedule',    label: 'Schedule',   title: 'Schedule' }
];

let currentStep  = 0;
let projectRuns  = [];
let projectShare = null;
let lastRunMs    = null;

function stepIndex(slug) {
  const i = STEPS.findIndex(s => s.slug === slug);
  return i === -1 ? 0 : i;
}

/**
 * What a step is still missing, or null when it is done. One source of truth for
 * the tick marks on the stepper, the hint beside Next, and the readiness list on
 * the schedule step — so those three can never disagree with each other.
 */
function stepGap(slug) {
  switch (slug) {
    case 'standards': {
      if (!standards.length) return 'Add at least one standard';
      const unnamed = standards.filter(s => !(s.name || '').trim()).length;
      if (unnamed) return `${unnamed} standard${unnamed === 1 ? '' : 's'} still ${unnamed === 1 ? 'needs' : 'need'} a name`;
      const noCourses = standards.filter(s => !(s.courses || []).length).length;
      if (noCourses) return `${noCourses} standard${noCourses === 1 ? ' has' : 's have'} no courses yet`;
      if (standards.some(s => (s.courses || []).some(c => !(c.name || '').trim()))) return 'Every course needs a name';
      return null;
    }
    case 'classrooms': {
      const divisions = allDivisions();
      if (!divisions.length) return 'Add a standard with divisions first';
      const unnamed = classrooms.filter(r => !(r.name || '').trim()).length;
      if (unnamed) return `${unnamed} classroom${unnamed === 1 ? '' : 's'} still ${unnamed === 1 ? 'needs' : 'need'} a name`;
      const roomless = divisions.filter(d => !d.roomId).length;
      if (roomless) return `${roomless} division${roomless === 1 ? ' has' : 's have'} no classroom`;
      return null;
    }
    case 'teachers': {
      if (!faculty.length) return 'Add at least one teacher';
      const bad = faculty.filter(f => !(f.name || '').trim() || !(f.facultyCode || '').trim()).length;
      if (bad) return `${bad} teacher${bad === 1 ? '' : 's'} ${bad === 1 ? 'needs' : 'need'} a name and a code`;
      return null;
    }
    case 'timetable': {
      if (!selectedDays.length) return 'Pick at least one working day';
      if (!collectTimeSlots().length) return 'Add a period with both a start and an end time';
      return null;
    }
    case 'assignments': {
      if (!assignments.length) return 'Give at least one course a teacher';
      const incomplete = assignments.filter(a => !a.courseId || !a.facultyId || !a.divisionId).length;
      if (incomplete) return `${incomplete} assignment${incomplete === 1 ? ' is' : 's are'} incomplete`;
      return null;
    }
    case 'rules':    return null;   // optional by design
    case 'schedule': return currentScheduleData ? null : 'Not generated yet';
  }
  return null;
}

/**
 * Whether a step has been *done*, which is not the same as whether it is
 * blocking. Rules are optional, so an empty rules step never blocks anything —
 * but ticking it on a brand-new project, above five empty steps, reads as a
 * lie. It earns its tick by having a rule in it.
 */
function stepDone(slug) {
  if (slug === 'rules') return hardConstraints.length > 0 || softConstraints.length > 0;
  return !stepGap(slug);
}

const ICON_TICK  = '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_ALERT = '<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>';

function renderStepper() {
  const nav = document.getElementById('stepper');
  if (!nav) return;

  nav.innerHTML = STEPS.map((s, i) => {
    const done      = stepDone(s.slug);
    const fillLeft  = i > 0 && i <= currentStep;
    const fillRight = i < currentStep;
    const fill = fillLeft && fillRight ? 'both' : fillLeft ? 'left' : fillRight ? 'right' : 'none';
    return `
      <button type="button" class="step" data-slug="${s.slug}" data-done="${done}" data-fill="${fill}"
              ${i === currentStep ? 'aria-current="step"' : ''}
              aria-label="Step ${i + 1} of ${STEPS.length}: ${esc(s.title)}${done ? ', done' : ''}">
        <span class="step-dot">
          <span class="step-num">${i + 1}</span>
          <svg class="step-check" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
        </span>
        <span class="step-label">${esc(s.label)}</span>
      </button>`;
  }).join('');

  nav.querySelectorAll('.step').forEach(b => { b.onclick = () => goToStep(b.dataset.slug); });

  const active = nav.querySelector('[aria-current="step"]');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

function renderStepNav() {
  STEPS.forEach((s, i) => {
    const panel = document.querySelector(`.step-panel[data-step="${s.slug}"]`);
    const host  = panel && panel.querySelector('[data-nav]');
    if (!host) return;

    const gap  = stepGap(s.slug);
    const prev = STEPS[i - 1];
    const next = STEPS[i + 1];

    host.innerHTML = `
      ${prev ? `<button type="button" class="btn" data-back>
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          ${esc(prev.label)}</button>` : '<span></span>'}
      <span class="spacer"></span>
      ${gap && s.slug !== 'schedule' ? `<span class="step-nav-hint warn">${esc(gap)}</span>` : ''}
      ${next ? `<button type="button" class="btn btn-primary" data-next>${esc(next.label)}
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </button>` : ''}`;

    const back = host.querySelector('[data-back]');
    if (back) back.onclick = () => goToStep(prev.slug);
    const fwd = host.querySelector('[data-next]');
    if (fwd) fwd.onclick = () => goToStep(next.slug);
  });
}

/** Move to a step. Slides in from whichever side you came from. */
function goToStep(slug, { push = true } = {}) {
  const target = stepIndex(slug);
  const step   = STEPS[target];
  const back   = target < currentStep;
  currentStep  = target;

  document.querySelectorAll('.step-panel').forEach(p => {
    p.classList.remove('is-active', 'slide-in-left', 'slide-in-right');
  });
  const panel = document.querySelector(`.step-panel[data-step="${step.slug}"]`);
  if (panel) panel.classList.add('is-active', back ? 'slide-in-left' : 'slide-in-right');

  if (push && PROJ_ID) {
    const url = `/projects/${encodeURIComponent(PROJ_ID)}/${step.slug}`;
    if (location.pathname !== url) history.pushState({ step: step.slug }, '', url);
  }
  document.title = `${projectName ? projectName + ' · ' : ''}${step.title} · Schedura`;

  // Steps built from earlier answers are rebuilt on entry rather than kept in
  // sync from a dozen call sites.
  if (step.slug === 'classrooms')  { refreshDivisionRoomPickers(); renderRoomAllocation(); }
  if (step.slug === 'assignments') renderAssignmentMatrix();
  if (step.slug === 'schedule')    { renderReadyPanel(); renderRunHistory(); }

  renderStepper();
  renderStepNav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.addEventListener('popstate', () => {
  const parts = location.pathname.split('/').filter(Boolean);
  goToStep(parts[2] || 'standards', { push: false });
});

/** Everything that depends on the current data, refreshed in one place. */
function refreshStepState() {
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.style.display = on ? '' : 'none';
  };
  show('standardsEmpty', !standards.length);
  show('facultyEmpty',   !faculty.length);
  show('roomsEmpty',     !classrooms.length);
  // The sample-data offer belongs on an empty project and nowhere else.
  show('demoPanel',      !projectHasData());

  renderRoomAllocation();
  renderStepper();
  renderStepNav();
  if (STEPS[currentStep] && STEPS[currentStep].slug === 'schedule') renderReadyPanel();
}

function renderRoomAllocation() {
  const host = document.getElementById('roomAllocation');
  if (!host) return;

  const divisions = allDivisions();
  const named     = getClassrooms();
  const pinned    = divisions.filter(d => d.roomId).length;
  const shortfall = divisions.length - named.length;

  let note = '';
  if (shortfall > 0) {
    note = `<p style="margin:10px 0 0;font-size:12.5px;color:var(--danger)">${shortfall} more classroom${shortfall === 1 ? '' : 's'} needed — each division keeps its own room all week.</p>`;
  } else if (divisions.length && pinned === divisions.length) {
    note = `<p style="margin:10px 0 0;font-size:12.5px;color:var(--success)">Every division has its own classroom.</p>`;
  }

  host.innerHTML = `
    <h3>Allocation</h3>
    <p class="hint" style="margin:0">${divisions.length} division${divisions.length === 1 ? '' : 's'} · ${named.length} classroom${named.length === 1 ? '' : 's'} · ${pinned} pinned</p>
    ${note}`;
}

/** The pre-flight list on the schedule step: what is ready, what is not, and a
 *  way straight to whichever step can fix it. */
function renderReadyPanel() {
  const host = document.getElementById('readyPanel');
  if (!host) return;

  const checks   = STEPS.slice(0, 6).map(s => ({ step: s, gap: stepGap(s.slug) }));
  const blocking = checks.filter(c => c.gap);

  const last = projectRuns[0];
  const lastLine = last
    ? `<p class="hint" style="margin:0 0 15px">Last generated ${esc(relTime(last.at))} — ${last.classCount} classes, ${last.conflicts} conflict${last.conflicts === 1 ? '' : 's'}, in ${esc(Schedura.duration(last.durationMs))}.</p>`
    : currentScheduleData ? '<p class="hint" style="margin:0 0 15px">A schedule is saved for this project.</p>' : '';

  host.className = 'panel';
  host.innerHTML = `
    <h3>${blocking.length ? 'Not ready yet' : 'Ready to generate'}</h3>
    ${lastLine}
    <ul class="ready-list">
      ${checks.map(c => `
        <li class="ready-item ${c.gap ? 'bad' : 'ok'}">
          ${c.gap ? ICON_ALERT : ICON_TICK}
          <span>${esc(c.step.title)}${c.gap ? ' — ' + esc(c.gap) : ''}
            ${c.gap ? `<button type="button" data-goto="${c.step.slug}">Fix this</button>` : ''}
          </span>
        </li>`).join('')}
    </ul>`;

  host.querySelectorAll('[data-goto]').forEach(b => { b.onclick = () => goToStep(b.dataset.goto); });

  const gen = document.getElementById('generateBtn');
  if (gen) {
    gen.disabled    = blocking.length > 0;
    gen.textContent = currentScheduleData ? 'Generate again' : 'Generate schedule';
  }
}

function renderRunHistory() {
  const host = document.getElementById('runHistory');
  if (!host) return;

  if (!projectRuns.length) {
    host.innerHTML = '<p class="hint" style="margin:0">No runs yet. Each generated schedule is recorded here.</p>';
    return;
  }

  host.innerHTML = projectRuns.map((r, i) => `
    <div class="run-row">
      <span class="run-when">${esc(relTime(r.at))}</span>
      <span class="run-mode">${r.mode === 'improve' ? 'Improved' : 'Generated'}</span>
      <span class="run-detail">${r.classCount} classes · ${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'}${r.softTotal ? ` · ${r.softMet}/${r.softTotal} preferences met` : ''} · ${esc(Schedura.duration(r.durationMs))}</span>
      ${i === 0 ? '<span class="badge badge-info">Current</span>' : ''}
    </div>`).join('');
}

/** Record a run locally so the history updates without another round trip. The
 *  server wrote the authoritative copy; a reload reconciles the two. */
function noteRun({ mode, stats }) {
  if (!stats) return;
  projectRuns = [{
    id: uid('run'), at: new Date().toISOString(), mode,
    durationMs: lastRunMs, classCount: stats.classCount, conflicts: stats.conflicts,
    fitness: stats.fitness, softMet: stats.softMet, softTotal: stats.softTotal
  }, ...projectRuns].slice(0, 12);
  renderRunHistory();
}

/* ── Project name ────────────────────────────────────────────────────── */

function setProjectName(name) {
  projectName = name;
  const el = document.getElementById('projectBarName');
  if (el) el.textContent = name;
  const step = STEPS[currentStep];
  document.title = `${name} · ${step ? step.title : 'Editor'} · Schedura`;
}

async function renameProject() {
  const before = projectName;
  const name = await Schedura.promptText({
    title: 'Rename project', label: 'Project name', value: before, confirmLabel: 'Rename', maxLength: 60
  });
  if (!name || name === before) return;

  const res = await Schedura.api(`${API_BASE_URL}/api/projects/${PROJ_ID}`, {
    method: 'PUT', body: JSON.stringify({ name })
  });
  if (!res.ok) { toast(res.error || 'Could not rename', { type: 'error' }); return; }
  setProjectName(name);

  toast('Project renamed', {
    action: 'Undo',
    onAction: async () => {
      await Schedura.api(`${API_BASE_URL}/api/projects/${PROJ_ID}`, { method: 'PUT', body: JSON.stringify({ name: before }) });
      setProjectName(before);
    }
  });
}

function showProjectMissing(message) {
  document.getElementById('bootSkeleton')?.remove();
  const host = document.querySelector('.container');
  host.innerHTML = `
    <div class="empty" style="margin-top:40px">
      <svg width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>
      <h3>Project unavailable</h3>
      <p>${esc(message)}</p>
      <div class="empty-actions"><a class="btn btn-primary" href="/projects">Back to projects</a></div>
    </div>`;
}

/* ── Sharing ─────────────────────────────────────────────────────────── */

async function openShareDialog() {
  if (!currentScheduleData) {
    toast('Generate a schedule first — there is nothing to share yet', { type: 'error' });
    goToStep('schedule');
    return;
  }

  const on   = !!(projectShare && projectShare.enabled);
  const link = projectShare ? `${location.origin}/s/${projectShare.id}` : '';

  const m = Schedura.modal({
    title: 'Share schedule',
    html: `
      <p style="font-size:13.5px;color:var(--muted);margin:0 0 18px;line-height:1.55">
        Anyone with the link can view this timetable — read-only, no sign-in needed.
        Your inputs, teachers and rules stay private.
      </p>
      ${on ? `
        <label for="shareInput">Public link</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="shareInput" type="text" readonly value="${esc(link)}" style="font-family:'IBM Plex Mono',monospace;font-size:12px">
          <button type="button" class="btn btn-sm" id="copyShare">Copy</button>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-danger" id="offShare">Turn off</button>
          <button type="button" class="btn btn-primary" id="doneShare">Done</button>
        </div>` : `
        <div class="modal-actions">
          <button type="button" class="btn" id="cancelShare">Cancel</button>
          <button type="button" class="btn btn-primary" id="onShare">Create link</button>
        </div>`}`
  });

  const q = sel => m.root.querySelector(sel);

  if (on) {
    q('#copyShare').onclick = async () => {
      const input = q('#shareInput');
      input.select();
      try { await navigator.clipboard.writeText(input.value); } catch { document.execCommand('copy'); }
      toast('Link copied', { type: 'success' });
    };
    q('#offShare').onclick = async () => {
      const r = await Schedura.api(`${API_BASE_URL}/api/projects/${PROJ_ID}/share`, { method: 'DELETE' });
      if (!r.ok) { toast('Could not turn the link off', { type: 'error' }); return; }
      projectShare = r.share || null;
      m.close();
      toast('Share link turned off');
    };
    q('#doneShare').onclick = () => m.close();
  } else {
    q('#cancelShare').onclick = () => m.close();
    q('#onShare').onclick = async () => {
      const r = await Schedura.api(`${API_BASE_URL}/api/projects/${PROJ_ID}/share`, { method: 'POST' });
      if (!r.ok) { toast('Could not create the link', { type: 'error' }); return; }
      projectShare = r.share;
      m.close();
      openShareDialog();
    };
  }
}

/* ── Keyboard and touch ──────────────────────────────────────────────── */

document.addEventListener('keydown', e => {
  const key = (e.key || '').toLowerCase();

  if ((e.metaKey || e.ctrlKey) && key === 's') {
    e.preventDefault();
    autoSave({ force: true }).then(() => toast('Saved'));
    return;
  }
  // Alt + arrows walk the steps, the same pair the Back/Next buttons use.
  if (e.altKey && e.key === 'ArrowRight') {
    const next = STEPS[currentStep + 1];
    if (next) { e.preventDefault(); goToStep(next.slug); }
  }
  if (e.altKey && e.key === 'ArrowLeft') {
    const prev = STEPS[currentStep - 1];
    if (prev) { e.preventDefault(); goToStep(prev.slug); }
  }
});

// Swipe between steps on touch devices.
let _touchX = null, _touchY = null;

document.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) { _touchX = null; return; }
  // A swipe that begins inside a horizontally scrollable timetable, or on a
  // control, belongs to that element and not to the page.
  if (e.target.closest('.table-wrapper, input, select, textarea, .stepper')) { _touchX = null; return; }
  _touchX = e.touches[0].clientX;
  _touchY = e.touches[0].clientY;
}, { passive: true });

document.addEventListener('touchend', e => {
  if (_touchX === null) return;
  const dx = e.changedTouches[0].clientX - _touchX;
  const dy = e.changedTouches[0].clientY - _touchY;
  _touchX = null;
  if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6) return;
  const next = STEPS[currentStep + (dx < 0 ? 1 : -1)];
  if (next) goToStep(next.slug);
}, { passive: true });

/* ── Boot ────────────────────────────────────────────────────────────── */

async function boot() {
  if (!(await Schedura.auth.require())) return;
  Schedura.paintUser();

  if (!PROJ_ID) { location.replace('/projects'); return; }

  document.getElementById('renameBtn').onclick    = renameProject;
  document.getElementById('shareBtn').onclick     = openShareDialog;
  document.getElementById('signOutBtn').onclick   = () => Schedura.auth.signOut();
  document.getElementById('demoBtn').onclick      = fillDemoData;
  document.getElementById('demoBtnEmpty').onclick = fillDemoData;

  await loadProjectData();
  if (!document.getElementById('stepsViewport')) return;   // project missing

  document.getElementById('bootSkeleton')?.remove();
  document.getElementById('stepsViewport').hidden = false;

  renderAssignmentMatrix();
  refreshStepState();
  setSaveState('idle');

  const slug = STEPS.some(s => s.slug === PATH_PARTS[2]) ? PATH_PARTS[2] : 'standards';
  goToStep(slug, { push: false });
  history.replaceState({ step: slug }, '', `/projects/${encodeURIComponent(PROJ_ID)}/${slug}`);
}

boot();
