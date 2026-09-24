/**
 * Genetic Algorithm worker.
 *
 * The GA is a long, tight, synchronous loop with no time limit — running it on
 * the main thread froze the whole server for the duration, which meant no
 * progress updates and no way to honour a cancel request (the cancel HTTP call
 * could not even be read until the loop finished).
 *
 * Running it here keeps the server responsive, lets progress stream out while
 * the search is still going, and makes cancellation instant: the main thread
 * just calls worker.terminate(), which kills the thread mid-loop. Cooperative
 * cancellation checks inside the loop would not be enough on their own.
 */
const { parentPort, workerData } = require('worker_threads');
const GeneticAlgorithm = require('./ga');

try {
  const ga = new GeneticAlgorithm({
    ...workerData,
    quiet: true,                    // keep the server log clean
    progressEvery: 25,
    onProgress: p => parentPort.postMessage({ type: 'progress', ...p })
  });

  // 'improve' keeps an already-valid schedule valid while cutting its soft
  // penalty; 'generate' searches from scratch until zero clashes.
  const solution = workerData.mode === 'improve'
    ? ga.improve(workerData.seedGenes || [])
    : ga.run();

  parentPort.postMessage({
    type: 'done',
    solution: {
      genes:       solution.genes,
      fitness:     solution.fitness,
      conflicts:   solution.conflicts,
      softReport:  solution.softReport || [],
      softPenalty: solution.softPenalty,
      seedPenalty: solution.seedPenalty
    }
  });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
}
