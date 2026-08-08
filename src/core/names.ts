/**
 * Random agent names, hive-flavored. Used when a spawn omits the name; also
 * available to callers who want the whole brood named this way.
 */

const PREFIXES = [
  'vex', 'skarn', 'ichor', 'ryza', 'krell', 'thorn', 'zaal', 'morg', 'nyx',
  'ghor', 'saur', 'tyx', 'vral', 'chit', 'husk', 'rend', 'spyr', 'kry',
  'phae', 'drov', 'quil', 'mand', 'ossk', 'terg', 'ulth', 'brood',
]

const SUFFIXES = ['ix', 'ar', 'eth', 'ul', 'os', 'ra', 'ion', 'ak', 'ys', 'un', 'or', 'ith']

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

export function generateAgentName(taken: Iterable<string> = []): string {
  const used = new Set<string>()
  for (const name of taken) used.add(name.toLowerCase())

  for (let attempt = 0; attempt < 64; attempt++) {
    const base = pick(PREFIXES) + pick(SUFFIXES)
    const name = attempt < 16 ? base : `${base}-${Math.floor(Math.random() * 90) + 10}`
    if (!used.has(name)) return name
  }
  // Astronomically unlikely with numeric suffixes, but never loop forever.
  let n = used.size + 1
  while (used.has(`drone-${n}`)) n++
  return `drone-${n}`
}
