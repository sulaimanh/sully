import { execFile } from 'child_process'
import { promisify } from 'util'
import { binaryPath, spawnEnv } from '../env'
import { getGhToken } from '../credentials'

const pexecFile = promisify(execFile)

function ghEnv(): NodeJS.ProcessEnv {
  const token = getGhToken()
  return spawnEnv(token ? { GH_TOKEN: token } : {})
}

async function gh(args: string[], cwd?: string): Promise<string> {
  const bin = binaryPath('gh')
  if (!bin) throw new Error('gh CLI not found — install it with `brew install gh`')
  const { stdout } = await pexecFile(bin, args, {
    env: ghEnv(),
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000
  })
  return stdout
}

let cachedUser: string | null = null

export async function currentGhUser(): Promise<string> {
  if (cachedUser) return cachedUser
  cachedUser = (await gh(['api', 'user', '--jq', '.login'])).trim()
  return cachedUser
}

export async function ghAuthStatus(): Promise<{ ok: boolean; detail: string }> {
  try {
    const user = await currentGhUser()
    return { ok: true, detail: `authenticated as @${user}` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message.split('\n')[0] }
  }
}

export interface PrCandidate {
  number: number
  title: string
  url: string
  nameWithOwner: string
  author: string
  isDraft: boolean
}

async function searchPrs(flag: string): Promise<PrCandidate[]> {
  try {
    const out = await gh([
      'search',
      'prs',
      flag,
      '--state=open',
      '--json',
      'number,title,url,repository,author,isDraft'
    ])
    const rows = JSON.parse(out) as Array<{
      number: number
      title: string
      url: string
      repository: { nameWithOwner: string }
      author: { login: string }
      isDraft: boolean
    }>
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      url: r.url,
      nameWithOwner: r.repository.nameWithOwner,
      author: r.author?.login ?? '',
      isDraft: r.isDraft
    }))
  } catch {
    return []
  }
}

/** Union of review-requested + assigned, deduped by URL, drafts and own PRs excluded. */
export async function findReviewCandidates(): Promise<PrCandidate[]> {
  const me = await currentGhUser()
  const [requested, assigned] = await Promise.all([
    searchPrs('--review-requested=@me'),
    searchPrs('--assignee=@me')
  ])
  const seen = new Set<string>()
  const out: PrCandidate[] = []
  for (const pr of [...requested, ...assigned]) {
    if (!pr.url || pr.isDraft || pr.author === me || seen.has(pr.url)) continue
    seen.add(pr.url)
    out.push(pr)
  }
  return out
}

export interface PrStatus {
  myReviewState: string // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING | NONE
  /** submittedAt of my latest review, ISO — lets a re-review distinguish new from old */
  myReviewSubmittedAt?: string
  merged: boolean
  title: string
  /** current head commit SHA — undefined when the API call failed */
  headRefOid?: string
  /** added + deleted lines — undefined when the API call failed */
  changedLines?: number
}

export async function prStatus(owner: string, repo: string, num: number): Promise<PrStatus> {
  const me = await currentGhUser()
  try {
    const out = await gh([
      'api',
      'graphql',
      '-f',
      'query=query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){title merged headRefOid additions deletions reviews(last:100){nodes{author{login} state submittedAt}}}}}',
      '-f',
      `o=${owner}`,
      '-f',
      `r=${repo}`,
      '-F',
      `n=${num}`
    ])
    const pr = JSON.parse(out)?.data?.repository?.pullRequest
    const mine = (pr?.reviews?.nodes ?? []).filter(
      (n: { author?: { login: string } }) => n.author?.login === me
    )
    const latest = mine.length ? mine[mine.length - 1] : null
    return {
      myReviewState: latest ? latest.state : 'NONE',
      myReviewSubmittedAt: latest?.submittedAt ?? undefined,
      merged: Boolean(pr?.merged),
      title: pr?.title ?? '',
      headRefOid: pr?.headRefOid ?? undefined,
      changedLines:
        typeof pr?.additions === 'number' && typeof pr?.deletions === 'number'
          ? pr.additions + pr.deletions
          : undefined
    }
  } catch {
    return { myReviewState: 'NONE', merged: false, title: '' }
  }
}

export async function prForBranch(
  repoPath: string,
  branch: string
): Promise<{ url: string; number: number; state: string } | null> {
  try {
    const out = await gh(['pr', 'view', branch, '--json', 'url,number,state'], repoPath)
    const pr = JSON.parse(out)
    return pr?.url ? pr : null
  } catch {
    return null
  }
}

export async function createPr(
  repoPath: string,
  branch: string,
  title: string,
  body: string,
  draft = false,
  base?: string
): Promise<string> {
  const args = ['pr', 'create', '--head', branch, '--title', title, '--body', body]
  if (base) args.push('--base', base)
  if (draft) args.push('--draft')
  const out = await gh(args, repoPath)
  const url = out.trim().split('\n').pop() ?? ''
  if (!url.startsWith('http')) throw new Error(`gh pr create returned no URL: ${out}`)
  return url
}

/** Map owner/repo -> local path for configured repos (parsed from git origin). */
export async function buildRepoMap(repoPaths: string[]): Promise<Map<string, string>> {
  const git = binaryPath('git')
  const map = new Map<string, string>()
  if (!git) return map
  await Promise.all(
    repoPaths.map(async (p) => {
      try {
        const { stdout } = await pexecFile(git, ['-C', p, 'remote', 'get-url', 'origin'], {
          env: spawnEnv(),
          timeout: 10_000
        })
        const nwo = stdout
          .trim()
          .replace(/^git@github\.com:/, '')
          .replace(/^https:\/\/github\.com\//, '')
          .replace(/\.git$/, '')
          .replace(/\/$/, '')
        if (nwo) map.set(nwo, p)
      } catch {
        // repo missing or no origin — skip
      }
    })
  )
  return map
}
