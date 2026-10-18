// Bayesian (Beta-Bernoulli) stats per (scope, fingerprint, action), with
// hierarchical partial pooling: org is the prior for a group, group (or org,
// if no group) is the prior for a user. A new scope is never cold -- it
// starts at its parent's current belief and only drifts away as its OWN
// evidence accumulates enough to justify diverging.

export interface Who {
  group?: string
  user?: string
}

export interface StatJSON {
  alpha: number
  beta: number
}

export interface ActionDetail {
  mean: number
  sourceLevel: string
  sourceN: number
  sourceCredibleWidth: number
}

export interface DecideResult {
  action: string
  detail: Record<string, ActionDetail>
}

export class BetaStat {
  alpha: number
  beta: number

  constructor(alpha = 1, beta = 1) {
    this.alpha = alpha
    this.beta = beta
  }

  update(outcome: boolean | 0 | 1): void {
    if (outcome) this.alpha += 1
    else this.beta += 1
  }

  get n(): number {
    return this.alpha + this.beta - 2 // real observations only (prior pseudo-count removed)
  }

  mean(): number {
    return this.alpha / (this.alpha + this.beta)
  }

  credibleWidth(): number {
    const total = this.alpha + this.beta
    const variance = (this.alpha * this.beta) / (total ** 2 * (total + 1))
    return 4 * Math.sqrt(variance) // ~95% width, normal approximation
  }

  toJSON(): StatJSON {
    return { alpha: this.alpha, beta: this.beta }
  }

  static fromJSON(j: StatJSON): BetaStat {
    return new BetaStat(j.alpha, j.beta)
  }
}

// Shrinkage toward a parent mean, weighted by how much real evidence this
// scope has of its own. priorStrength is "how many observations of its own
// a scope needs before it starts to outweigh its parent's belief."
function pooledMean(stat: BetaStat, parentMean: number, priorStrength: number): number {
  const n = stat.n
  const weight = n / (n + priorStrength)
  return weight * stat.mean() + (1 - weight) * parentMean
}

export class AttractorTree {
  // scopeKey -> fingerprint -> action -> BetaStat
  private levels = new Map<string, Map<string, Map<string, BetaStat>>>()

  private statsFor(scopeKey: string, fingerprint: string): Map<string, BetaStat> {
    if (!this.levels.has(scopeKey)) this.levels.set(scopeKey, new Map())
    const byFingerprint = this.levels.get(scopeKey)!
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, new Map())
    return byFingerprint.get(fingerprint)!
  }

  private stat(scopeKey: string, fingerprint: string, action: string): BetaStat {
    const stats = this.statsFor(scopeKey, fingerprint)
    if (!stats.has(action)) stats.set(action, new BetaStat())
    return stats.get(action)!
  }

  /** What has been learned for an action — read only: an action never seen reads as the prior, and nothing is created. */
  private peek(scopeKey: string, fingerprint: string, action: string): BetaStat {
    return this.levels.get(scopeKey)?.get(fingerprint)?.get(action) ?? new BetaStat()
  }

  record(scopeKey: string, fingerprint: string, action: string, outcome: boolean | 0 | 1): void {
    this.stat(scopeKey, fingerprint, action).update(outcome)
  }

  // Returns per-action pooled means at the most specific available level,
  // plus which level actually had real (n>0) evidence for each action.
  decide(fingerprint: string, actions: string[], who: Who = {}, priorStrength = 4): DecideResult {
    const chain = [who.group, who.user].filter((x): x is string => Boolean(x))
    const detail: Record<string, ActionDetail> = {}
    for (const action of actions) {
      const orgStat = this.peek('org', fingerprint, action)
      let mean = orgStat.mean()
      let sourceLevel = 'org'
      let sourceN = orgStat.n
      let sourceCredibleWidth = orgStat.credibleWidth()
      for (const scopeKey of chain) {
        const stat = this.peek(scopeKey, fingerprint, action)
        mean = pooledMean(stat, mean, priorStrength)
        if (stat.n > 0) {
          sourceLevel = scopeKey
          sourceN = stat.n
          sourceCredibleWidth = stat.credibleWidth()
        }
      }
      detail[action] = { mean, sourceLevel, sourceN, sourceCredibleWidth }
    }
    const best = actions.reduce((a, b) => (detail[a].mean >= detail[b].mean ? a : b))
    return { action: best, detail }
  }

  toJSON(): Record<string, Record<string, Record<string, StatJSON>>> {
    const out: Record<string, Record<string, Record<string, StatJSON>>> = {}
    for (const [scopeKey, byFp] of this.levels) {
      out[scopeKey] = {}
      for (const [fp, byAction] of byFp) {
        out[scopeKey][fp] = {}
        for (const [action, stat] of byAction) out[scopeKey][fp][action] = stat.toJSON()
      }
    }
    return out
  }

  static fromJSON(json: Record<string, Record<string, Record<string, StatJSON>>> | undefined): AttractorTree {
    const tree = new AttractorTree()
    for (const [scopeKey, byFp] of Object.entries(json ?? {})) {
      for (const [fp, byAction] of Object.entries(byFp)) {
        for (const [action, statJSON] of Object.entries(byAction)) {
          tree.statsFor(scopeKey, fp).set(action, BetaStat.fromJSON(statJSON))
        }
      }
    }
    return tree
  }
}
