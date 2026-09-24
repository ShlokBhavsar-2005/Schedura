/**
 * Demo school generator.
 *
 * Built BACKWARDS on purpose: it first lays out a complete, valid week — every
 * division in its own room, no teacher ever in two places at once — and only
 * then derives the standards, teachers and assignments that produce it. So a
 * solution provably exists before the scheduler is ever asked to find one.
 *
 * Generating plausible-looking numbers and hoping would risk the demo landing
 * on an unsolvable configuration in front of whoever is being shown it.
 */

const SUBJECTS = [
  { name: 'Mathematics',    code: 'MATH' },
  { name: 'English',        code: 'ENG'  },
  { name: 'Hindi',          code: 'HIN'  },
  { name: 'Science',        code: 'SCI'  },
  { name: 'Social Studies', code: 'SST'  },
  { name: 'Physical Education', code: 'PE' }
];

const TEACHER_NAMES = [
  'Anjali Sharma', 'Rajesh Nair', 'Priya Menon', 'Vikram Rao', 'Sunita Iyer',
  'Arun Kulkarni', 'Meera Joshi', 'Sanjay Gupta', 'Kavita Reddy', 'Deepak Verma',
  'Lakshmi Pillai', 'Rohit Desai', 'Neha Bhat', 'Manish Agarwal', 'Shalini Chopra',
  'Ganesh Murthy', 'Divya Krishnan', 'Amit Patel', 'Rekha Naidu', 'Suresh Bose',
  'Pooja Malhotra', 'Harish Shetty', 'Anita Dubey', 'Kiran Mehta', 'Vijay Saxena',
  'Nandini Rao', 'Prakash Jain', 'Sneha Kapoor', 'Ravi Chandran', 'Geeta Mishra',
  'Mohan Bhatt', 'Asha Varma', 'Naveen Kumar', 'Swati Ghosh', 'Ramesh Pai',
  'Jyoti Sinha', 'Ashok Rane', 'Preeti Salunke', 'Vinod Thakur', 'Madhuri Kale'
];

const STANDARD_NAMES = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

// 8 teaching periods with a break after the 4th — "first half" is before 11:00
const TIME_SLOTS = [
  { startTime: '08:00', endTime: '08:45' },
  { startTime: '08:45', endTime: '09:30' },
  { startTime: '09:30', endTime: '10:15' },
  { startTime: '10:15', endTime: '11:00' },
  { startTime: '11:30', endTime: '12:15' },
  { startTime: '12:15', endTime: '13:00' },
  { startTime: '13:00', endTime: '13:45' },
  { startTime: '13:45', endTime: '14:30' }
];
const BREAK_TIME = { start: '11:00', end: '11:30' };
const FIRST_HALF_SLOTS = 4;          // indices 0-3 start before 11:00

const DIVISIONS_PER_STANDARD = 3;
const PERIODS_PER_SUBJECT    = 5;

function uid(prefix, n) { return `${prefix}-demo-${n}`; }

function buildDemoSchool() {
  const slotsPerWeek = DAYS.length * TIME_SLOTS.length;   // 40
  const periodsPerDivision = SUBJECTS.length * PERIODS_PER_SUBJECT; // 30 -> 75% full, leaves slack

  // ── Standards, divisions, rooms ──
  const classrooms = [];
  const standards  = [];
  let roomN = 0;

  STANDARD_NAMES.forEach((name, si) => {
    const std = { id: uid('std', si), name, courses: [], divisions: [] };
    SUBJECTS.forEach((s, ci) => std.courses.push({
      id: uid('course', `${si}-${ci}`), name: s.name, courseCode: `${s.code}${si + 1}`
    }));
    for (let d = 0; d < DIVISIONS_PER_STANDARD; d++) {
      const room = { id: uid('room', roomN), name: `Room ${101 + roomN}` };
      classrooms.push(room);
      std.divisions.push({ id: uid('div', `${si}-${d}`), label: 'ABC'[d], roomId: room.id });
      roomN++;
    }
    standards.push(std);
  });

  const allDivisions = standards.flatMap(s => s.divisions.map(d => ({ ...d, standard: s })));

  // ── Lay out a valid week per division ──
  // Every (day, slot) cell, minus a few left free so the scheduler has room to
  // move things around rather than being handed a 100%-full week.
  const cells = [];
  for (let day = 0; day < DAYS.length; day++) {
    for (let slot = 0; slot < TIME_SLOTS.length; slot++) cells.push({ day, slot });
  }

  // divisionId -> [{ day, slot, courseId }]
  const placement = new Map();

  const FRIDAY = DAYS.indexOf('Friday');

  allDivisions.forEach((div, di) => {
    const courses = div.standard.courses;
    // Rotate the starting point per division so they don't all mirror each other
    const rotated = cells.slice(di % cells.length).concat(cells.slice(0, di % cells.length));
    const chosen = [];
    for (let i = 0; i < rotated.length && chosen.length < periodsPerDivision; i++) {
      if (i % 4 === 3) continue;                 // skip every 4th cell -> free periods
      chosen.push(rotated[i]);
    }

    // Two subjects are deliberately confined: one to mornings, one to Mon-Thu.
    // Left to a plain round-robin every subject spreads across all five days and
    // the whole timetable, so no (division, course) pair is ever all-morning or
    // Friday-free — and the two part-time teachers can never be given any work,
    // which silently dropped both constraints from the demo.
    const pool = [...chosen];
    const take = (pred, n) => {
      const out = [];
      for (let i = 0; i < pool.length && out.length < n; ) {
        if (pred(pool[i])) out.push(pool.splice(i, 1)[0]); else i++;
      }
      return out;
    };

    const morningCells   = take(c => c.slot < FIRST_HALF_SLOTS, PERIODS_PER_SUBJECT);
    const fridayFreeCell = take(c => c.day !== FRIDAY,          PERIODS_PER_SUBJECT);

    const morningCourse    = courses[courses.length - 2];
    const fridayFreeCourse = courses[courses.length - 1];
    const otherCourses     = courses.slice(0, courses.length - 2);

    const placed = [];
    morningCells.forEach(cell   => placed.push({ ...cell, courseId: morningCourse.id }));
    fridayFreeCell.forEach(cell => placed.push({ ...cell, courseId: fridayFreeCourse.id }));
    pool.forEach((cell, i)      => placed.push({ ...cell, courseId: otherCourses[i % otherCourses.length].id }));

    placement.set(div.id, placed);
  });

  // ── Derive teachers from the layout ──
  // Each (division, course) pair occupies a fixed set of cells. Two pairs can
  // share a teacher only if their cells never overlap, so a greedy pass over
  // the pairs yields a teacher roster that cannot double-book by construction.
  const pairs = [];
  allDivisions.forEach(div => {
    const byCourse = new Map();
    placement.get(div.id).forEach(p => {
      if (!byCourse.has(p.courseId)) byCourse.set(p.courseId, []);
      byCourse.get(p.courseId).push(p);
    });
    byCourse.forEach((cellList, courseId) => {
      pairs.push({
        divisionId: div.id,
        courseId,
        cells: cellList,
        allMorning: cellList.every(c => c.slot < FIRST_HALF_SLOTS),
        noFriday:   cellList.every(c => c.day !== 4)
      });
    });
  });

  // Teacher 0 only ever takes all-morning work, teacher 1 never works Friday —
  // so the part-time constraints we attach later are already true of this
  // layout, and therefore cannot make it unsolvable.
  const teachers = [];           // { id, name, code, busy:Set<"d-s">, rule }
  const newTeacher = rule => {
    const i = teachers.length;
    const t = {
      id: uid('fac', i),
      name: TEACHER_NAMES[i % TEACHER_NAMES.length],
      code: `T${String(i + 1).padStart(2, '0')}`,
      busy: new Set(),
      rule: rule || null
    };
    teachers.push(t);
    return t;
  };
  newTeacher('morning-only');
  newTeacher('no-friday');

  const fits = (t, pair) => {
    if (t.rule === 'morning-only' && !pair.allMorning) return false;
    if (t.rule === 'no-friday'    && !pair.noFriday)   return false;
    return pair.cells.every(c => !t.busy.has(`${c.day}-${c.slot}`));
  };

  // Constrained pairs first, so the part-time teachers actually pick up work
  pairs.sort((a, b) => (b.allMorning + b.noFriday) - (a.allMorning + a.noFriday));

  // Keep every teacher comfortably below a full week. Packing each teacher to
  // capacity before opening the next one produced teachers at 40/40, which is
  // precisely the zero-slack situation that makes the search grind.
  const MAX_TEACHER_LOAD = Math.floor(slotsPerWeek * 0.65);   // 26 of 40

  const assignments = [];
  pairs.forEach((pair, idx) => {
    const eligible = teachers.filter(t => fits(t, pair) && t.busy.size + pair.cells.length <= MAX_TEACHER_LOAD);
    // Spread the work: least-loaded eligible teacher, not simply the first
    let teacher = eligible.sort((a, b) => a.busy.size - b.busy.size)[0];
    if (!teacher) {
      teacher = newTeacher(null);
      if (!fits(teacher, pair)) throw new Error('demo generator: fresh teacher could not take a pair');
    }
    pair.cells.forEach(c => teacher.busy.add(`${c.day}-${c.slot}`));
    assignments.push({
      id: uid('asgn', idx),
      divisionId: pair.divisionId,
      courseId: pair.courseId,
      facultyId: teacher.id,
      timesPerWeek: pair.cells.length
    });
  });

  const faculty = teachers.map(t => ({ id: t.id, name: t.name, facultyCode: t.code }));

  // ── Constraints that the layout above already satisfies ──
  const hardConstraints = [];
  const morningTeacher = teachers[0];
  const fridayOffTeacher = teachers[1];

  if (morningTeacher.busy.size > 0) {
    hardConstraints.push({
      id: uid('hard', 0), type: 'faculty_first_half_only',
      facultyId: morningTeacher.id, day: '', timeslot: '', courseId: '', classroom: ''
    });
  }
  if (fridayOffTeacher.busy.size > 0) {
    hardConstraints.push({
      id: uid('hard', 1), type: 'faculty_unavailability',
      facultyId: fridayOffTeacher.id, day: 'Friday', timeslot: '', courseId: '', classroom: ''
    });
  }

  // Preferences — these never affect solvability, only the quality score, and
  // give the "Improve schedule" button something real to work on.
  const softConstraints = [
    { id: uid('soft', 0), type: 'faculty_prefers_first_half',
      facultyId: (teachers[2] || teachers[0]).id, courseId: '', preference: 'morning', weight: 60, label: '' },
    { id: uid('soft', 1), type: 'faculty_prefers_second_half',
      facultyId: (teachers[3] || teachers[0]).id, courseId: '', preference: 'afternoon', weight: 50, label: '' },
    { id: uid('soft', 2), type: 'no_back_to_back_course',
      facultyId: '', courseId: '', preference: 'morning', weight: 40, label: '' },
    { id: uid('soft', 3), type: 'balanced_daily_load',
      facultyId: '', courseId: '', preference: 'morning', weight: 30, label: '' }
  ];

  return {
    standards,
    faculty,
    assignments,
    classrooms,
    selectedDays: [...DAYS],
    timeSlotValues: TIME_SLOTS.map(s => ({ ...s })),
    hardConstraints,
    softConstraints,
    breakTime: { ...BREAK_TIME },
    // The layout this was derived from — used by the self-check below and by
    // tests, never sent to the scheduler.
    _layout: { placement, slotsPerWeek, periodsPerDivision }
  };
}

/**
 * Prove the generated dataset really is solvable by validating the layout it
 * was derived from: no division double-booked, no teacher double-booked, and
 * the part-time rules respected.
 */
function verifyDemoSchool(school) {
  const problems = [];
  const { placement } = school._layout;
  const teacherOf = new Map();
  school.assignments.forEach(a => teacherOf.set(`${a.divisionId}|${a.courseId}`, a.facultyId));

  const divSeen = new Set();
  const facSeen = new Map();

  placement.forEach((slots, divisionId) => {
    slots.forEach(p => {
      const cell = `${p.day}-${p.slot}`;

      const dKey = `${divisionId}@${cell}`;
      if (divSeen.has(dKey)) problems.push(`division ${divisionId} double-booked at ${cell}`);
      divSeen.add(dKey);

      const facId = teacherOf.get(`${divisionId}|${p.courseId}`);
      const fKey = `${facId}@${cell}`;
      if (facSeen.has(fKey)) problems.push(`teacher ${facId} double-booked at ${cell}`);
      facSeen.set(fKey, true);
    });
  });

  // Hard constraints must hold for the constructed layout
  school.hardConstraints.forEach(hc => {
    placement.forEach((slots, divisionId) => {
      slots.forEach(p => {
        const facId = teacherOf.get(`${divisionId}|${p.courseId}`);
        if (facId !== hc.facultyId) return;
        if (hc.type === 'faculty_first_half_only' && p.slot >= FIRST_HALF_SLOTS)
          problems.push(`morning-only teacher scheduled in the afternoon at ${p.day}-${p.slot}`);
        if (hc.type === 'faculty_unavailability' && DAYS[p.day] === hc.day)
          problems.push(`unavailable teacher scheduled on ${hc.day}`);
      });
    });
  });

  // Every division needs its own room
  const roomIds = school.standards.flatMap(s => s.divisions.map(d => d.roomId));
  if (new Set(roomIds).size !== roomIds.length) problems.push('a classroom is shared by two divisions');

  return problems;
}

module.exports = { buildDemoSchool, verifyDemoSchool };
