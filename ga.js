/**
 * Genetic Algorithm for Timetable Generation
 * Supports hard and soft constraints
 *
 * KEY GUARANTEE: The GA will NEVER return a timetable with hard constraint violations.
 * It runs indefinitely (with restarts and adaptive strategies) until a zero-conflict
 * solution is found. The server should call this in a worker thread if needed.
 *
 * FIXES applied:
 *  F1 – countHardConflicts was called twice per individual per generation (double work).
 *       Now evaluateIndividual() returns {fitness, conflicts} together.
 *  F2 – crossover always used the fixed midpoint. Now uses a random cut-point.
 *  F3 – room_restriction used Array.indexOf (case-sensitive, fragile).
 *       Now uses a pre-built Map for safe lookup.
 *  F4 – evaluateFitness called countHardConflicts internally AND run() called
 *       it again. Inner call removed; single pass via evaluateIndividual().
 *  F5 – elites were preserved without repairing their conflicting genes.
 *       repairConflicts() does targeted re-assignment before preservation.
 *  F6 – mutateWithRate picked only one field per gene.
 *       Under conflict pressure: multi-field mutation allowed.
 *  F7 – crossover silently corrupted genes on length mismatch. Guard added.
 *  F8 – [CORE FIX] GA returned after TIME_LIMIT_MS even with conflicts > 0.
 *       Now it NEVER returns until conflicts === 0. Infinite restart loop.
 *  F9 – [NEW] Constraint-aware slot/room assignment in init, repair, and mutation.
 *       Respects faculty_unavailability, faculty_first/second_half_only, room_restriction
 *       directly during gene creation — dramatically reduces starting conflict count.
 *  F10 – [NEW] First individual per restart is built greedily (no-clash slot assignment)
 *        to give the GA a strong starting point.
 *  F11 – [DIVISIONS] The scheduling unit is now a division (e.g. "1st-A"), not a
 *        standard. Genes carry `divisionId`, and the "one class at a time" rule is
 *        keyed on it — previously the group was derived from courseId -> standard,
 *        which made divisions sharing a standard's courses look like one group and
 *        wrongly blocked them from being taught in parallel.
 *  F12 – [DIVISIONS] Each division owns one classroom, so the room is no longer a
 *        searched dimension: `classroomIdx` is gone from the gene, the separate
 *        classroom-clash check is deleted (a room clash is now by definition a
 *        division clash), and `room_restriction` is retired.
 */

class GeneticAlgorithm {
  static _cloneGene(g) {
    return {
      assignmentId: g.assignmentId,
      divisionId:   g.divisionId,
      courseId:     g.courseId,
      facultyId:    g.facultyId,
      dayIdx:       g.dayIdx,
      timeSlotIdx:  g.timeSlotIdx,
      instance:     g.instance
    };
  }

  // Carry fitness/conflicts across the clone. They used to be reset to 0, which
  // made `globalBest` permanently report "0 conflicts" — harmless while nothing
  // read it, but it fed the progress display a phantom zero. Every caller
  // re-evaluates before use, so preserving the values is safe.
  static _cloneInd(ind) {
    return {
      genes:     ind.genes.map(GeneticAlgorithm._cloneGene),
      fitness:   ind.fitness   || 0,
      conflicts: ind.conflicts || 0
    };
  }

  constructor(constraints) {
    this.constraints = constraints;
    this.populationSize = 100;
    this.mutationRate   = 0.15;
    this.crossoverRate  = 0.85;
    this.eliteSize      = 8;
    this.tournamentSize = 4;

    this.standards   = constraints.standards   || [];
    this.faculty     = constraints.faculty     || [];
    this.assignments = constraints.assignments || [];
    this.classrooms  = constraints.classrooms  || [];
    this.daysOfWeek  = constraints.daysOfWeek  || [];
    this.timeSlots   = constraints.timeSlots   || [];

    this.hardConstraints = constraints.hardConstraints || [];
    this.softConstraints = constraints.softConstraints || [];
    this.breakTime       = constraints.breakTime || null;

    // Called every `progressEvery` generations with {attempt, generation,
    // totalGenerations, conflicts, fitness}. Lets the worker stream progress to
    // the UI; harmless no-op when running standalone.
    this.onProgress    = typeof constraints.onProgress === 'function' ? constraints.onProgress : null;
    this.progressEvery = constraints.progressEvery || 25;
    this.quiet         = !!constraints.quiet;

    // ELITE_REPAIR — repairConflicts() on elite individuals (the "F5" note above).
    // It never actually ran: _cloneInd() used to reset `conflicts` to 0, so the
    // `elite.conflicts > 0` guard was always false. Fixing the clone switched it
    // on and measurably made things WORSE — 80 repair passes x O(genes) per elite
    // per generation cut throughput ~20x:
    //   easy/medium schools : no difference (both ~25ms)
    //   tight school        : off = solved 1/3 within 25s, on = solved 0/3
    // So it stays off by default, now as a deliberate choice rather than a bug.
    this.eliteRepair = !!constraints.eliteRepair;

    this.firstHalfSlotIndices = this._computeFirstHalfSlots();

    // O(1) course/standard lookups
    this._courseCache   = {};
    this._standardCache = {};
    this.standards.forEach(std => {
      (std.courses || []).forEach(c => {
        this._courseCache[c.id]   = c;
        this._standardCache[c.id] = std;
      });
    });

    // divisionId -> { division, standard }. A division is the scheduling unit:
    // its students move together, so it can hold exactly one class per slot.
    this._divisionCache = {};
    this.standards.forEach(std => {
      (std.divisions || []).forEach(d => {
        this._divisionCache[d.id] = { division: d, standard: std };
      });
    });

    // [FIX F9] Pre-compute constraint lookup structures
    this._buildConstraintIndex();
  }

  // ─────────────────────────────────────────────
  // PRE-COMPUTE CONSTRAINT INDEX
  // ─────────────────────────────────────────────

  _buildConstraintIndex() {
    this._facultyHalfRestriction = new Map(); // facultyId -> 'first' | 'second'
    this._blockedFacultySlots    = new Map(); // facultyId -> Set<"di-si">

    this.hardConstraints.forEach(hc => {
      switch (hc.type) {
        case 'faculty_unavailability': {
          const dayIdx = this.daysOfWeek.indexOf(hc.day);
          if (dayIdx === -1) break;
          if (!this._blockedFacultySlots.has(hc.facultyId))
            this._blockedFacultySlots.set(hc.facultyId, new Set());
          const blocked = this._blockedFacultySlots.get(hc.facultyId);
          if (hc.timeslot) {
            const si = this.timeSlots.findIndex(s => s.startTime === hc.timeslot);
            // [FIX] A stale hc.timeslot (no longer matching any current time
            // slot, e.g. after slots were edited) must be ignored the same
            // way here as in _findConflictingGeneIndices/checkHardConstraintViolations
            // below — otherwise construction thinks the day is open while
            // scoring blocks it entirely, producing an unrepairable conflict.
            if (si !== -1) blocked.add(`${dayIdx}-${si}`);
            else console.warn(`[faculty_unavailability] Timeslot "${hc.timeslot}" not found among current time slots — constraint ignored.`);
          } else {
            this.timeSlots.forEach((_, si) => blocked.add(`${dayIdx}-${si}`));
          }
          break;
        }
        case 'faculty_first_half_only':
          this._facultyHalfRestriction.set(hc.facultyId, 'first');
          break;
        case 'faculty_second_half_only':
          this._facultyHalfRestriction.set(hc.facultyId, 'second');
          break;
      }
    });

    // Pre-compute valid {dayIdx, timeSlotIdx} pairs per faculty
    this._validSlotsForFaculty = new Map();
    const allFacIds = [...new Set(this.assignments.map(a => a.facultyId))];
    allFacIds.forEach(fid => {
      const half    = this._facultyHalfRestriction.get(fid) || null;
      const blocked = this._blockedFacultySlots.get(fid) || new Set();
      const valid   = [];
      this.daysOfWeek.forEach((_, di) => {
        this.timeSlots.forEach((_, si) => {
          if (blocked.has(`${di}-${si}`)) return;
          const inFirst = this.firstHalfSlotIndices.has(si);
          if (half === 'first'  && !inFirst) return;
          if (half === 'second' && inFirst)  return;
          valid.push({ dayIdx: di, timeSlotIdx: si });
        });
      });
      this._validSlotsForFaculty.set(fid, valid);
    });
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────

  _computeFirstHalfSlots() {
    if (!this.breakTime || !this.breakTime.start)
      return new Set(this.timeSlots.map((_, i) => i));
    const breakStart = this.breakTime.start;
    const indices = new Set();
    this.timeSlots.forEach((slot, i) => {
      if (slot.startTime < breakStart) indices.add(i);
    });
    return indices;
  }

  findStandardByCourseId(courseId) { return this._standardCache[courseId] || null; }
  findCourseByCourseId(courseId)   { return this._courseCache[courseId]   || null; }

  // ─────────────────────────────────────────────
  // MAIN RUN — [FIX F8] NEVER returns with conflicts > 0
  // ─────────────────────────────────────────────

  run() {
    const log = this.quiet ? () => {} : console.log;
    log('Starting GA — will run until ALL hard constraints are satisfied.');
    log(`Population: ${this.populationSize}, Assignments: ${this.assignments.length}`);

    const GENS_PER_ATTEMPT = 500;
    const STAGNATION_LIMIT = 80;
    // `conflicts` comes from the separately tracked best-so-far count rather
    // than from a cloned individual, so it can never drift from reality.
    const report = (attempt, generation, totalGenerations, bestConflicts, bestFitness) => {
      if (!this.onProgress) return;
      this.onProgress({
        attempt, generation, totalGenerations,
        conflicts: Number.isFinite(bestConflicts) ? bestConflicts : null,
        fitness:   Number.isFinite(bestFitness)   ? bestFitness   : null
      });
    };

    let globalBest          = null;
    let globalBestConflicts = Infinity;
    let attempt             = 0;
    let totalGenerations    = 0;

    // Infinite loop — only exits when conflicts === 0
    while (true) {
      attempt++;
      if (attempt > 1) {
        log(`↻ Restart ${attempt} — best: ${globalBestConflicts} conflict(s) remaining...`);
      }

      let population         = this.initializePopulation();
      let bestSolution       = null;
      let bestFitness        = -Infinity;
      let noImprovementCount = 0;

      for (let generation = 0; generation < GENS_PER_ATTEMPT; generation++) {
        totalGenerations++;

        // Single-pass evaluation
        population.forEach(ind => {
          const r   = this.evaluateIndividual(ind);
          ind.fitness   = r.fitness;
          ind.conflicts = r.conflicts;
        });

        population.sort((a, b) => b.fitness - a.fitness);

        if (population[0].fitness > bestFitness) {
          bestFitness  = population[0].fitness;
          bestSolution = GeneticAlgorithm._cloneInd(population[0]);
          bestSolution.fitness   = population[0].fitness;
          bestSolution.conflicts = population[0].conflicts;
          noImprovementCount = 0;

          if (bestSolution.conflicts < globalBestConflicts) {
            globalBestConflicts = bestSolution.conflicts;
            globalBest          = GeneticAlgorithm._cloneInd(bestSolution);
          }

          if (generation % 50 === 0 || bestSolution.conflicts === 0) {
            log(
              `Attempt ${attempt} Gen ${generation} (total ${totalGenerations}): ` +
              `Fitness=${bestFitness.toFixed(2)}, Conflicts=${bestSolution.conflicts}`
            );
          }
        } else {
          noImprovementCount++;
        }

        if (totalGenerations % this.progressEvery === 0) {
          report(attempt, generation, totalGenerations,
                 Math.min(globalBestConflicts, bestSolution.conflicts), bestFitness);
        }

        // ── SUCCESS: only exit when zero conflicts ──
        if (bestSolution.conflicts === 0) {
          log(
            `✓ Zero-conflict solution found! Attempt ${attempt}, Gen ${generation} ` +
            `(total generations: ${totalGenerations})`
          );
          bestSolution.softReport  = this.evaluateSoftConstraints(bestSolution);
          // Reported for both modes so an improve run has a baseline to beat.
          bestSolution.softPenalty = this.computeSoftPenalty(bestSolution);
          report(attempt, generation, totalGenerations, 0, bestFitness);
          return bestSolution;
        }

        // Stagnation → break inner loop and restart
        if (noImprovementCount > STAGNATION_LIMIT) {
          log(
            `  Stagnated at ${bestSolution.conflicts} conflict(s) after gen ${generation}. Restarting...`
          );
          break;
        }

        // ── Build next generation ──
        const stuckWithConflicts = bestSolution.conflicts > 0 && noImprovementCount > 40;
        const effectiveMutation  = stuckWithConflicts
          ? Math.min(this.mutationRate * 4, 0.6)
          : this.mutationRate;

        const newPop = [];

        // Keep elites. Elite repair stays off by default — see ELITE_REPAIR note
        // on the class: it never actually ran historically, and measured worse.
        for (let i = 0; i < this.eliteSize && i < population.length; i++) {
          const elite = GeneticAlgorithm._cloneInd(population[i]);
          if (this.eliteRepair && elite.conflicts > 0) this.repairConflicts(elite);
          newPop.push(elite);
        }

        // Inject fresh seeds when deeply stuck
        if (stuckWithConflicts) {
          const greedy = this._createGreedyIndividual();
          if (greedy) newPop.push(greedy);

          const freshCount = Math.floor(this.populationSize * 0.4);
          for (let i = 0; i < freshCount && newPop.length < this.populationSize; i++) {
            newPop.push(this._createSmartRandomIndividual());
          }
        }

        while (newPop.length < this.populationSize) {
          const p1  = this.tournamentSelection(population);
          const p2  = this.tournamentSelection(population);
          let child = Math.random() < this.crossoverRate
            ? this.crossover(p1, p2)
            : GeneticAlgorithm._cloneInd(p1);
          child = this.mutateWithRate(child, effectiveMutation, stuckWithConflicts);
          newPop.push(child);
        }

        population = newPop;
      }
      // End of inner generation loop — restart
    }
    // Unreachable, but satisfies linter
  }

  // ─────────────────────────────────────────────
  // POPULATION INIT
  // ─────────────────────────────────────────────

  initializePopulation() {
    const population = [];
    // First individual: greedy (best possible start)
    const greedy = this._createGreedyIndividual();
    population.push(greedy || this._createSmartRandomIndividual());
    // Rest: smart-random (constraint-aware slot selection)
    while (population.length < this.populationSize) {
      population.push(this._createSmartRandomIndividual());
    }
    return population;
  }

  // [FIX F10] Greedy individual: assigns each gene to a valid slot with no clashes
  _createGreedyIndividual() {
    try {
      const individual = { genes: [], fitness: 0, conflicts: 0 };
      const usedFacSlot = new Set(); // "facultyId-di-si"
      const usedDivSlot = new Set(); // "divisionId-di-si"

      this.assignments.forEach(assignment => {
        const timesPerWeek = parseInt(assignment.timesPerWeek);
        const validSlots   = this._validSlotsForFaculty.get(assignment.facultyId) || [];

        for (let instance = 0; instance < timesPerWeek; instance++) {
          // Shuffle to avoid always placing in same order
          const shuffled = [...validSlots].sort(() => Math.random() - 0.5);
          let placed = false;

          for (const { dayIdx, timeSlotIdx } of shuffled) {
            const facKey = `${assignment.facultyId}-${dayIdx}-${timeSlotIdx}`;
            const divKey = `${assignment.divisionId}-${dayIdx}-${timeSlotIdx}`;
            if (usedFacSlot.has(facKey)) continue;
            if (usedDivSlot.has(divKey)) continue;

            usedFacSlot.add(facKey);
            usedDivSlot.add(divKey);

            individual.genes.push({
              assignmentId: assignment.id,
              divisionId:   assignment.divisionId,
              courseId:     assignment.courseId,
              facultyId:    assignment.facultyId,
              dayIdx,
              timeSlotIdx,
              instance
            });
            placed = true;
            break;
          }

          if (!placed) {
            // Fallback: constraint-aware but may clash
            const fallback = validSlots.length > 0
              ? validSlots[Math.floor(Math.random() * validSlots.length)]
              : { dayIdx: Math.floor(Math.random() * this.daysOfWeek.length),
                  timeSlotIdx: Math.floor(Math.random() * this.timeSlots.length) };
            individual.genes.push({
              assignmentId: assignment.id,
              divisionId:   assignment.divisionId,
              courseId:     assignment.courseId,
              facultyId:    assignment.facultyId,
              dayIdx:       fallback.dayIdx,
              timeSlotIdx:  fallback.timeSlotIdx,
              instance
            });
          }
        }
      });
      return individual;
    } catch (e) {
      console.warn('Greedy init failed, falling back to smart-random:', e.message);
      return null;
    }
  }

  // [FIX F9] Smart random: picks day+slot from the faculty's valid set
  _createSmartRandomIndividual() {
    const individual = { genes: [], fitness: 0, conflicts: 0 };
    this.assignments.forEach(assignment => {
      const timesPerWeek = parseInt(assignment.timesPerWeek);
      const validSlots   = this._validSlotsForFaculty.get(assignment.facultyId) || [];

      for (let instance = 0; instance < timesPerWeek; instance++) {
        let dayIdx, timeSlotIdx;
        if (validSlots.length > 0) {
          const pick = validSlots[Math.floor(Math.random() * validSlots.length)];
          dayIdx      = pick.dayIdx;
          timeSlotIdx = pick.timeSlotIdx;
        } else {
          dayIdx      = Math.floor(Math.random() * this.daysOfWeek.length);
          timeSlotIdx = Math.floor(Math.random() * this.timeSlots.length);
        }

        individual.genes.push({
          assignmentId: assignment.id,
          divisionId:   assignment.divisionId,
          courseId:     assignment.courseId,
          facultyId:    assignment.facultyId,
          dayIdx,
          timeSlotIdx,
          instance
        });
      }
    });
    return individual;
  }

  _createRandomIndividual() {
    return this._createSmartRandomIndividual();
  }

  // ─────────────────────────────────────────────
  // [FIX F5 + F9] CONFLICT REPAIR — constraint-aware re-assignment
  // ─────────────────────────────────────────────

  repairConflicts(individual) {
    const MAX_REPAIR_PASSES = 80;

    for (let pass = 0; pass < MAX_REPAIR_PASSES; pass++) {
      const conflictSet = this._findConflictingGeneIndices(individual);
      if (conflictSet.size === 0) break;

      const indices  = Array.from(conflictSet);
      const idxToFix = indices[Math.floor(Math.random() * indices.length)];
      const gene     = individual.genes[idxToFix];

      // Pick a valid (day, slot) for this faculty
      const validSlots = this._validSlotsForFaculty.get(gene.facultyId) || [];
      if (validSlots.length > 0) {
        const pick       = validSlots[Math.floor(Math.random() * validSlots.length)];
        gene.dayIdx      = pick.dayIdx;
        gene.timeSlotIdx = pick.timeSlotIdx;
      } else {
        gene.dayIdx      = Math.floor(Math.random() * this.daysOfWeek.length);
        gene.timeSlotIdx = Math.floor(Math.random() * this.timeSlots.length);
      }
      // Room needs no repair: it is fixed by the gene's division.
    }
  }

  _findConflictingGeneIndices(individual) {
    const conflicting = new Set();

    // Faculty clashes
    const facMap = {};
    individual.genes.forEach((g, i) => {
      const key = `${g.facultyId}-${g.dayIdx}-${g.timeSlotIdx}`;
      if (!facMap[key]) facMap[key] = [];
      facMap[key].push(i);
    });
    Object.values(facMap).forEach(list => {
      if (list.length > 1) list.forEach(i => conflicting.add(i));
    });

    // Division clashes. Each division owns exactly one room, so a room double
    // booking is by definition a division double booking — no separate check.
    const divMap = {};
    individual.genes.forEach((g, i) => {
      const key = `${g.divisionId}-${g.dayIdx}-${g.timeSlotIdx}`;
      if (!divMap[key]) divMap[key] = [];
      divMap[key].push(i);
    });
    Object.values(divMap).forEach(list => {
      if (list.length > 1) list.forEach(i => conflicting.add(i));
    });

    // Custom hard constraint violations
    this.hardConstraints.forEach(hc => {
      switch (hc.type) {

        case 'faculty_unavailability': {
          const dayIdx = this.daysOfWeek.indexOf(hc.day);
          // A timeslot is only "no restriction" (whole day blocked) when the
          // constraint genuinely has none. A timeslot that was set but no
          // longer matches any current slot must be ignored, not treated as
          // "whole day" — see the matching note in _buildConstraintIndex.
          let slotIdx = -1, staleSlot = false;
          if (hc.timeslot) {
            slotIdx = this.timeSlots.findIndex(s => s.startTime === hc.timeslot);
            if (slotIdx === -1) staleSlot = true;
          }
          if (staleSlot) break;
          individual.genes.forEach((g, i) => {
            if (g.facultyId !== hc.facultyId || g.dayIdx !== dayIdx) return;
            if (slotIdx === -1 || g.timeSlotIdx === slotIdx) conflicting.add(i);
          });
          break;
        }

        case 'faculty_first_half_only': {
          individual.genes.forEach((g, i) => {
            if (g.facultyId === hc.facultyId && !this.firstHalfSlotIndices.has(g.timeSlotIdx))
              conflicting.add(i);
          });
          break;
        }

        case 'faculty_second_half_only': {
          individual.genes.forEach((g, i) => {
            if (g.facultyId === hc.facultyId && this.firstHalfSlotIndices.has(g.timeSlotIdx))
              conflicting.add(i);
          });
          break;
        }
      }
    });

    return conflicting;
  }

  // ─────────────────────────────────────────────
  // FITNESS
  // ─────────────────────────────────────────────

  evaluateIndividual(individual) {
    const conflicts   = this.countHardConflicts(individual);
    const softPenalty = this.computeSoftPenalty(individual);
    const distScore   = this.evaluateDistribution(individual);
    const maxScore    = individual.genes.length * 200;
    const hardPenalty = conflicts * (maxScore + 10000);
    return { conflicts, fitness: distScore - softPenalty - hardPenalty };
  }

  evaluateFitness(individual) {
    return this.evaluateIndividual(individual).fitness;
  }

  // ─────────────────────────────────────────────
  // HARD CONSTRAINTS
  // ─────────────────────────────────────────────

  countHardConflicts(individual) {
    return (
      this.checkFacultyConflicts(individual) +
      this.checkDivisionConflicts(individual) +
      this.checkHardConstraintViolations(individual)
    );
  }

  checkFacultyConflicts(individual) {
    const map = {};
    individual.genes.forEach(g => {
      const key = `${g.facultyId}-${g.dayIdx}-${g.timeSlotIdx}`;
      map[key] = (map[key] || 0) + 1;
    });
    return Object.values(map).reduce((s, v) => s + Math.max(0, v - 1), 0);
  }

  /**
   * A division can attend one class at a time. Because a division owns exactly
   * one classroom, this also covers room double-booking — there is deliberately
   * no separate classroom check any more.
   */
  checkDivisionConflicts(individual) {
    const map = {};
    individual.genes.forEach(g => {
      const key = `${g.divisionId}-${g.dayIdx}-${g.timeSlotIdx}`;
      map[key] = (map[key] || 0) + 1;
    });
    return Object.values(map).reduce((s, v) => s + Math.max(0, v - 1), 0);
  }

  checkHardConstraintViolations(individual) {
    let violations = 0;

    this.hardConstraints.forEach(hc => {
      switch (hc.type) {

        case 'faculty_unavailability': {
          const dayIdx = this.daysOfWeek.indexOf(hc.day);
          let slotIdx = -1, staleSlot = false;
          if (hc.timeslot) {
            slotIdx = this.timeSlots.findIndex(s => s.startTime === hc.timeslot);
            if (slotIdx === -1) staleSlot = true;
          }
          if (staleSlot) break;
          individual.genes.forEach(g => {
            if (g.facultyId !== hc.facultyId || g.dayIdx !== dayIdx) return;
            if (slotIdx === -1 || g.timeSlotIdx === slotIdx) violations++;
          });
          break;
        }

        case 'faculty_first_half_only': {
          individual.genes.forEach(g => {
            if (g.facultyId === hc.facultyId && !this.firstHalfSlotIndices.has(g.timeSlotIdx))
              violations++;
          });
          break;
        }

        case 'faculty_second_half_only': {
          individual.genes.forEach(g => {
            if (g.facultyId === hc.facultyId && this.firstHalfSlotIndices.has(g.timeSlotIdx))
              violations++;
          });
          break;
        }
      }
    });

    return violations;
  }

  // ─────────────────────────────────────────────
  // SOFT CONSTRAINTS
  // ─────────────────────────────────────────────

  computeSoftPenalty(individual) {
    let penalty = 0;

    this.softConstraints.forEach(sc => {
      const weight = sc.weight || 50;
      switch (sc.type) {

        case 'faculty_prefers_first_half':
          individual.genes.forEach(g => {
            if (g.facultyId === sc.facultyId && !this.firstHalfSlotIndices.has(g.timeSlotIdx))
              penalty += weight;
          });
          break;

        case 'faculty_prefers_second_half':
          individual.genes.forEach(g => {
            if (g.facultyId === sc.facultyId && this.firstHalfSlotIndices.has(g.timeSlotIdx))
              penalty += weight;
          });
          break;

        case 'no_back_to_back_course': {
          // Grouped per division: 1-A having double Maths is the thing to avoid,
          // and is unrelated to what 1-B is doing.
          const groups = {};
          individual.genes.forEach(g => {
            if (sc.courseId && g.courseId !== sc.courseId) return;
            const key = `${g.divisionId}-${g.courseId}-${g.dayIdx}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(g.timeSlotIdx);
          });
          Object.values(groups).forEach(slots => {
            if (slots.length < 2) return;
            const sorted = [...slots].sort((a, b) => a - b);
            for (let i = 1; i < sorted.length; i++) {
              if (sorted[i] - sorted[i - 1] === 1) penalty += weight;
            }
          });
          break;
        }

        case 'balanced_daily_load': {
          const loadMap = {};
          individual.genes.forEach(g => {
            const key = `${g.facultyId}-${g.dayIdx}`;
            loadMap[key] = (loadMap[key] || 0) + 1;
          });
          const facIds = [...new Set(individual.genes.map(g => g.facultyId))];
          facIds.forEach(fid => {
            const dayLoads   = this.daysOfWeek.map((_, di) => loadMap[`${fid}-${di}`] || 0);
            const total      = dayLoads.reduce((s, v) => s + v, 0);
            const activeDays = dayLoads.filter(v => v > 0).length || 1;
            const avg        = total / activeDays;
            dayLoads.forEach(load => { if (load > avg + 1) penalty += weight; });
          });
          break;
        }

        case 'course_preferred_slot': {
          const lastSlotIdx = this.timeSlots.length - 1;
          individual.genes.forEach(g => {
            if (g.courseId !== sc.courseId) return;
            const inFirst = this.firstHalfSlotIndices.has(g.timeSlotIdx);
            if (sc.preference === 'morning'   && !inFirst)                  penalty += weight;
            if (sc.preference === 'afternoon' && inFirst)                    penalty += weight;
            if (sc.preference === 'last'      && g.timeSlotIdx !== lastSlotIdx) penalty += weight;
          });
          break;
        }
      }
    });

    return penalty;
  }

  evaluateSoftConstraints(individual) {
    const report = [];

    this.softConstraints.forEach(sc => {
      let violations = 0, total = 0, detail = '';

      switch (sc.type) {

        case 'faculty_prefers_first_half': {
          const fac = this.faculty.find(f => f.id === sc.facultyId);
          individual.genes.forEach(g => {
            if (g.facultyId !== sc.facultyId) return;
            total++;
            if (!this.firstHalfSlotIndices.has(g.timeSlotIdx)) violations++;
          });
          detail = `${fac ? fac.name : sc.facultyId}: ${total - violations}/${total} classes in first half`;
          break;
        }

        case 'faculty_prefers_second_half': {
          const fac = this.faculty.find(f => f.id === sc.facultyId);
          individual.genes.forEach(g => {
            if (g.facultyId !== sc.facultyId) return;
            total++;
            if (this.firstHalfSlotIndices.has(g.timeSlotIdx)) violations++;
          });
          detail = `${fac ? fac.name : sc.facultyId}: ${total - violations}/${total} classes in second half`;
          break;
        }

        case 'no_back_to_back_course': {
          const groups = {};
          individual.genes.forEach(g => {
            if (sc.courseId && g.courseId !== sc.courseId) return;
            const key = `${g.divisionId}-${g.courseId}-${g.dayIdx}`;
            if (!groups[key]) groups[key] = [];
            groups[key].push(g.timeSlotIdx);
          });
          Object.values(groups).forEach(slots => {
            if (slots.length < 2) return;
            const sorted = [...slots].sort((a, b) => a - b);
            for (let i = 1; i < sorted.length; i++) {
              total++;
              if (sorted[i] - sorted[i - 1] === 1) violations++;
            }
          });
          detail = violations === 0
            ? 'No back-to-back same course pairs found'
            : `${violations} back-to-back occurrence(s) found`;
          break;
        }

        case 'balanced_daily_load': {
          const loadMap = {};
          individual.genes.forEach(g => {
            const key = `${g.facultyId}-${g.dayIdx}`;
            loadMap[key] = (loadMap[key] || 0) + 1;
          });
          const facIds = [...new Set(individual.genes.map(g => g.facultyId))];
          facIds.forEach(fid => {
            const dayLoads   = this.daysOfWeek.map((_, di) => loadMap[`${fid}-${di}`] || 0);
            const activeDays = dayLoads.filter(v => v > 0).length || 1;
            const avg        = dayLoads.reduce((s, v) => s + v, 0) / activeDays;
            dayLoads.forEach(load => { total++; if (load > avg + 1) violations++; });
          });
          detail = violations === 0 ? 'Faculty load is well balanced' : `${violations} day(s) with unbalanced load`;
          break;
        }

        case 'course_preferred_slot': {
          const course      = this.findCourseByCourseId(sc.courseId);
          const lastSlotIdx = this.timeSlots.length - 1;
          individual.genes.forEach(g => {
            if (g.courseId !== sc.courseId) return;
            total++;
            const inFirst = this.firstHalfSlotIndices.has(g.timeSlotIdx);
            let ok = true;
            if (sc.preference === 'morning'   && !inFirst)                  ok = false;
            if (sc.preference === 'afternoon' && inFirst)                    ok = false;
            if (sc.preference === 'last'      && g.timeSlotIdx !== lastSlotIdx) ok = false;
            if (!ok) violations++;
          });
          detail = `${course ? course.name : sc.courseId}: ${total - violations}/${total} classes in preferred slot (${sc.preference})`;
          break;
        }
      }

      report.push({
        id:        sc.id,
        type:      sc.type,
        label:     sc.label || sc.type,
        weight:    sc.weight,
        violations,
        total,
        satisfied: violations === 0,
        detail
      });
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // IMPROVE — optimise soft constraints on an already-valid schedule
  // ─────────────────────────────────────────────

  /**
   * Take a schedule that already satisfies every hard constraint and spend more
   * time reducing its soft-constraint penalty, never accepting a candidate that
   * reintroduces a clash.
   *
   * Unlike run(), this has no success condition to stop on — soft constraints
   * are preferences, not requirements — so it is bounded by a generation budget
   * and a stagnation limit, and can only ever return something at least as good
   * as the seed it was given.
   */
  improve(seedGenes, options = {}) {
    const log = this.quiet ? () => {} : console.log;
    const maxGenerations = options.maxGenerations || 2000;
    const stagnationLimit = options.stagnationLimit || 400;

    const seed = { genes: seedGenes.map(GeneticAlgorithm._cloneGene), fitness: 0, conflicts: 0 };
    const seedEval = this.evaluateIndividual(seed);
    seed.fitness   = seedEval.fitness;
    seed.conflicts = seedEval.conflicts;

    if (seed.conflicts > 0) {
      // Refuse to "improve" something that was never valid — the caller would
      // otherwise get back a schedule with clashes and no warning.
      throw new Error('Cannot improve a schedule that still has hard-constraint clashes.');
    }

    const seedPenalty = this.computeSoftPenalty(seed);

    let best        = GeneticAlgorithm._cloneInd(seed);
    let bestPenalty = seedPenalty;

    // Seed the population with the current solution plus mutated copies of it,
    // so the search starts from a known-good point rather than scratch.
    let population = [GeneticAlgorithm._cloneInd(seed)];
    while (population.length < this.populationSize) {
      population.push(this.mutateWithRate(seed, 0.08));
    }

    let noImprovement = 0;

    for (let generation = 0; generation < maxGenerations; generation++) {
      population.forEach(ind => {
        const r = this.evaluateIndividual(ind);
        ind.fitness   = r.fitness;
        ind.conflicts = r.conflicts;
      });
      population.sort((a, b) => b.fitness - a.fitness);

      // Only clash-free candidates may ever become the new best
      const top = population.find(ind => ind.conflicts === 0);
      if (top) {
        const penalty = this.computeSoftPenalty(top);
        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          best = GeneticAlgorithm._cloneInd(top);
          best.fitness = top.fitness;
          best.conflicts = 0;
          noImprovement = 0;
          log(`  improve gen ${generation}: soft penalty ${penalty}`);
        } else noImprovement++;
      } else noImprovement++;

      if (this.onProgress && generation % this.progressEvery === 0) {
        this.onProgress({
          attempt: 1, generation, totalGenerations: generation,
          conflicts: 0, fitness: best.fitness,
          softPenalty: bestPenalty, seedPenalty
        });
      }

      if (bestPenalty === 0) { log('  improve: all preferences satisfied'); break; }
      if (noImprovement > stagnationLimit) { log(`  improve: no gain for ${stagnationLimit} generations`); break; }

      // Next generation — elitism plus mutated offspring of the best
      const next = [GeneticAlgorithm._cloneInd(best)];
      for (let i = 0; i < this.eliteSize && i < population.length; i++) {
        next.push(GeneticAlgorithm._cloneInd(population[i]));
      }
      while (next.length < this.populationSize) {
        const p1 = this.tournamentSelection(population);
        const p2 = this.tournamentSelection(population);
        const child = Math.random() < this.crossoverRate ? this.crossover(p1, p2) : GeneticAlgorithm._cloneInd(p1);
        next.push(this.mutateWithRate(child, this.mutationRate));
      }
      population = next;
    }

    best.softReport  = this.evaluateSoftConstraints(best);
    best.softPenalty = bestPenalty;
    best.seedPenalty = seedPenalty;
    return best;
  }

  // ─────────────────────────────────────────────
  // DISTRIBUTION SCORE
  // ─────────────────────────────────────────────

  evaluateDistribution(individual) {
    let score = 0;
    const groups = {};
    individual.genes.forEach(g => {
      if (!groups[g.assignmentId]) groups[g.assignmentId] = [];
      groups[g.assignmentId].push(g);
    });
    Object.values(groups).forEach(genes => {
      const uniqueDays = new Set(genes.map(g => g.dayIdx));
      score += uniqueDays.size * 15;
      const sorted = Array.from(uniqueDays).sort((a, b) => a - b);
      if (sorted.length > 1) score += (sorted[sorted.length - 1] - sorted[0]) * 5;
    });
    return score;
  }

  // ─────────────────────────────────────────────
  // SELECTION / CROSSOVER / MUTATION
  // ─────────────────────────────────────────────

  tournamentSelection(population) {
    let best = null;
    for (let i = 0; i < this.tournamentSize; i++) {
      const c = population[Math.floor(Math.random() * population.length)];
      if (!best || c.fitness > best.fitness) best = c;
    }
    return best;
  }

  crossover(p1, p2) {
    const len = p1.genes.length;
    if (len !== p2.genes.length) {
      console.warn('[crossover] gene length mismatch — cloning p1');
      return GeneticAlgorithm._cloneInd(p1);
    }
    const point = 1 + Math.floor(Math.random() * (len - 1));
    return {
      genes: p1.genes.map((g, i) => GeneticAlgorithm._cloneGene(i < point ? g : p2.genes[i])),
      fitness: 0,
      conflicts: 0
    };
  }

  mutate(individual) {
    return this.mutateWithRate(individual, this.mutationRate, false);
  }

  // [FIX F6 + F9] Constraint-aware mutation
  mutateWithRate(individual, rate, stuckWithConflicts = false) {
    const mutant = {
      genes: individual.genes.map(GeneticAlgorithm._cloneGene),
      fitness: 0,
      conflicts: 0
    };

    mutant.genes.forEach(gene => {
      if (Math.random() >= rate) return;

      const validSlots = this._validSlotsForFaculty.get(gene.facultyId) || [];

      // Only day+slot are searchable now — the room is fixed by the division.
      if (validSlots.length > 0 && (stuckWithConflicts ? Math.random() < 0.7 : true)) {
        const pick       = validSlots[Math.floor(Math.random() * validSlots.length)];
        gene.dayIdx      = pick.dayIdx;
        gene.timeSlotIdx = pick.timeSlotIdx;
      } else if (stuckWithConflicts) {
        if (Math.random() < 0.5) gene.dayIdx      = Math.floor(Math.random() * this.daysOfWeek.length);
        if (Math.random() < 0.5) gene.timeSlotIdx = Math.floor(Math.random() * this.timeSlots.length);
      } else {
        if (Math.random() < 0.5) gene.dayIdx      = Math.floor(Math.random() * this.daysOfWeek.length);
        else                     gene.timeSlotIdx = Math.floor(Math.random() * this.timeSlots.length);
      }
    });

    return mutant;
  }
}

module.exports = GeneticAlgorithm;