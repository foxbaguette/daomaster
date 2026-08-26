// DAO Master — every Alien Worlds DAO and the custodians currently seated on it.
//
// Two reads:
//
//   index.worlds / dacs                 the directory of DAOs
//   <CUSTODIAN> / custodians1 @ dac_id  the council seated on one of them
//
// The custodian contract is not hardcoded. Each directory row carries an
// `accounts` map keyed by role, and role 2 is CUSTODIAN — today every DAO points
// at dao.worlds, but the directory is what decides that.
//
// Connecting a wallet is optional and, for now, does nothing but identify you:
// nothing on this page signs a transaction. It is here so the actions that will
// need it have a session to use.

// The inner action of a multisig proposal is carried as raw `bytes`, so it has
// to be serialized here. `abi_json_to_bin` used to do this server-side and is
// now removed or disabled on every node in the list.
import { ABI, Serializer } from '@wharfkit/antelope'
import { SessionKit, Chains } from '@wharfkit/session'
import WebRenderer from '@wharfkit/web-renderer'
import { WalletPluginAnchor } from '@wharfkit/wallet-plugin-anchor'
import { WalletPluginCloudWallet } from '@wharfkit/wallet-plugin-cloudwallet'

// ── Config ────────────────────────────────────────────────────────────────

// Carried over from the Very Serious Space War site, where each of these was
// verified from a browser with the exact request this app makes: POST
// /v1/chain/get_table_rows with `Content-Type: application/json`, which triggers
// a CORS preflight. That distinction matters — several nodes answer GET with
// `access-control-allow-origin: *` but do not handle the OPTIONS preflight, so a
// server-side probe passes them and the browser still refuses.
//
// Known-good from curl but REJECTED by the browser, do not re-add without
// retesting in a browser: wax.greymass.com, wax.eu.eosamsterdam.net,
// hyperion.wax.eosrio.io, wax-public.neftyblocks.com, api.wax.greeneosio.com.
const ENDPOINTS = [
    'https://wax.blacklusion.io',
    'https://api.waxsweden.org',
    'https://wax.eosdac.io',
    'https://wax.api.eosnation.io',
    'https://waxapi.ledgerwise.io',
    'https://api.wax.bountyblok.io',
    'https://api.hivebp.io',
    'https://wax.eosphere.io',
    'https://wax.eosusa.io',
    'https://api.wax.detroitledger.tech',
]

const DIRECTORY = 'index.worlds'
const EXPLORER  = 'https://waxblock.io/account/'
const APP_NAME  = 'DAO Master'

// Trilium is the game's own token and belongs to no single DAO, so it is read
// straight from its contract and shown beside the account rather than on a card.
const TLM_CONTRACT = 'alien.worlds'
const TLM_SYMBOL   = 'TLM'

// dacdir::account_type. TREASURY is what separates the two groups (see
// classify); CUSTODIAN is the contract each DAO's council lives in.
const TREASURY  = 1
const CUSTODIAN = 2

// Accounts to watch, and how many seats on one council it takes before that
// council is marked. Nothing on chain says these accounts are related — this is
// a hand-supplied list, and the marker means "these accounts hold this many
// seats", not anything the contracts assert.
const WATCHED = new Set([
    '5thba.wam',
    '42lra.wam',
    't1dbe.wam',
    'fgaqa.c.wam',
    'im24u.c.wam',
])
const CONTROL_THRESHOLD = 3

// Test A and Test B are registered in the directory exactly like any other DAO
// — treasury, refs, a seated council — so nothing in the data marks them as
// scratch. Hiding them is a curation choice, which is why this is a list of ids
// and not a rule.
const HIDDEN = new Set(['testa', 'testb'])

// Every read is spread across all healthy nodes, and no single node is asked for
// more than RATE_LIMIT calls in any RATE_WINDOW. Leaning on one node does not
// just risk an HTTP 429 — it gets answered with an empty `rows` array, which is
// indistinguishable from "nothing staked" and silently renders as a holder
// having nothing. Pacing this is a correctness measure, not just politeness.
const RATE_LIMIT = 3
const RATE_WINDOW = 3000

// The scheduler is the real throttle, so the worker count only has to be high
// enough to keep every node busy.
const CONCURRENCY = 6
// A first pass short enough to pick a genuinely fast node, and a second pass
// long enough that nothing healthy can miss it.
const PROBE_TIMEOUT = 6000
const PROBE_RETRY_TIMEOUT = 15000

// A read that fails gets re-issued against a different node before giving up.
const MAX_ATTEMPTS = 3

// ── State ─────────────────────────────────────────────────────────────────

// Every healthy node, each carrying the timestamps of its own recent calls.
let pool = [{ url: ENDPOINTS[0], recent: [], fails: 0 }]
let apiUrl = ENDPOINTS[0]      // the fastest one, used for signing
let daos = []
let group = 'syndicate'
let session = null
let position = new Map()   // dac_id -> what the signed-in account holds there
let votes = new Map()      // dac_id -> the signed-in account's `votes` row, if any

const $ = (id) => document.getElementById(id)
const daosEl    = $('daos')
const statusEl  = $('status')
const barEl     = $('progress')
const barFill   = $('progressFill')

// The status line stays out of the way unless something needs saying. A
// running count of how many nodes answered is not news; a failed read is.
function setStatus(text, kind = '', { retry = false } = {}) {
    statusEl.textContent = text ?? ''
    statusEl.classList.toggle('is-error', kind === 'error')
    statusEl.hidden = !text
    // A failure the reader can act on beats one that tells them to reload. The
    // button restarts the whole boot, session and all.
    if (retry && text) {
        const b = document.createElement('button')
        b.className = 'act-mini'
        b.type = 'button'
        b.textContent = 'try again'
        b.style.marginLeft = '10px'
        b.addEventListener('click', () => { b.disabled = true; boot() })
        statusEl.appendChild(b)
    }
}


// ── Progress ──────────────────────────────────────────────────────────────
//
// Paced reads take seconds rather than milliseconds, so the wait needs to be
// visible. Counted in requests, which is the unit the scheduler actually meters.

let progress = null

function startPhase(total) {
    progress = { done: 0, total: Math.max(1, total) }
    barFill.style.width = '0%'
    barEl.hidden = false
}

function noteRequest() {
    if (!progress) return
    progress.done++
    // Conditional follow-up reads can push past the estimate; the bar tracks
    // toward full rather than overshooting it.
    barFill.style.width = `${Math.min(100, (progress.done / progress.total) * 100)}%`
}

function endPhase() {
    progress = null
    barEl.hidden = true
}

// ── Session ───────────────────────────────────────────────────────────────

// The chain url here is a starting point only; whichever node the probe settles
// on is pushed in with setEndpoint, so signing follows reads rather than talking
// to some other node.
const sessionKit = new SessionKit({
    appName: APP_NAME,
    chains: [{ id: Chains.WAX.id, url: ENDPOINTS[0] }],
    ui: new WebRenderer(),
    walletPlugins: [new WalletPluginCloudWallet(), new WalletPluginAnchor()],
})

// ── Chain reads ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rawPost(body, url, timeout, path = 'get_table_rows') {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    try {
        const res = await fetch(`${url}/v1/chain/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json()
    } finally {
        clearTimeout(timer)
    }
}

// Hands out the least-recently-loaded node that still has room in its window,
// waiting rather than overspending when every node is at its limit. Each node
// keeps its own timestamps, so one slow node cannot hold up the others' budget.
// `count` reserves that many slots on ONE node at once. Reads that have to agree
// with each other must come from the same node: spread across the pool they can
// straddle a block boundary and return figures from two different chain states,
// which is subtly wrong rather than visibly broken.
async function acquireNode(count = 1) {
    for (;;) {
        const now = Date.now()
        let best = null
        let soonest = Infinity

        for (const node of pool) {
            while (node.recent.length && now - node.recent[0] >= RATE_WINDOW) node.recent.shift()
            if (node.recent.length + count <= RATE_LIMIT) {
                if (!best || node.recent.length < best.recent.length) best = node
            } else if (node.recent.length) {
                soonest = Math.min(soonest, node.recent[0] + RATE_WINDOW - now)
            }
        }

        if (best) {
            for (let i = 0; i < count; i++) best.recent.push(now)
            return best
        }
        // Every node is spent; wait for the earliest window to roll over.
        await sleep(Math.max(60, Math.min(soonest === Infinity ? 400 : soonest, 400)))
    }
}

// `url` bypasses the scheduler entirely — that path is the probe, which is
// deliberately one call to one named node.
async function post(body, { timeout = 15000, url = null } = {}) {
    // A named node has already had its budget charged by whoever pinned it (or
    // is the probe, which is metering itself). It still counts toward progress.
    if (url) {
        try {
            return await rawPost(body, url, timeout)
        } finally {
            noteRequest()
        }
    }

    let lastErr
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const node = await acquireNode()
        try {
            const data = await rawPost(body, node.url, timeout)
            node.fails = 0
            return data
        } catch (err) {
            lastErr = err
            node.fails = (node.fails ?? 0) + 1
        } finally {
            noteRequest()
        }
    }
    throw lastErr
}

// Follows `more` rather than trusting one page. Both tables here are small, but
// a council is bounded by the DAO's own `numelected` and nothing should assume
// that stays at five.
// `extra` carries anything get_table_rows accepts — bounds, a secondary index —
// so a single-account lookup is one bounded read rather than a table scan. A
// bounded query comes back with `more: false`, so the paging below is a no-op
// for those and only does work for the open-ended reads.
async function getRows(code, scope, table, extra = {}) {
    // `url` pins the read to one node; it is a transport option, not a query
    // parameter, so it must not reach the request body.
    const { limit = 100, url, ...rest } = extra
    const out = []
    let lower_bound = rest.lower_bound
    for (let page = 0; page < 10; page++) {
        const data = await post({ json: true, code, scope, table, limit, ...rest, lower_bound }, { url })
        if (!Array.isArray(data.rows)) throw new Error(`no rows for ${code}/${scope}/${table}`)
        out.push(...data.rows)
        if (!data.more) break
        lower_bound = data.next_key
    }
    return out
}

// Contract ABIs, fetched once each. Needed only to serialize the inner action of
// a proposal, so this is a cold path — but it goes through the same node pool as
// everything else rather than picking a node of its own.
const abiCache = new Map()

async function getAbi(account) {
    if (abiCache.has(account)) return abiCache.get(account)
    let lastErr
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const node = await acquireNode()
        try {
            const res = await rawPost({ account_name: account }, node.url, 15000, 'get_abi')
            if (!res?.abi) throw new Error(`no ABI for ${account}`)
            const abi = ABI.from(res.abi)
            abiCache.set(account, abi)
            return abi
        } catch (err) {
            lastErr = err
        } finally {
            noteRequest()
        }
    }
    throw lastErr
}

// A single page, no `more` following. For reads off a sorted index where only
// the head matters, paging would drag in the whole table.
async function postRows(code, scope, table, extra = {}) {
    const { limit = 100, url, ...rest } = extra
    const data = await post({ json: true, code, scope, table, limit, ...rest }, { url })
    if (!Array.isArray(data.rows)) throw new Error(`no rows for ${code}/${scope}/${table}`)
    return data.rows
}

// Probe with the exact request the app makes — POST + application/json, which
// forces a CORS preflight. A bare GET would pass on nodes the browser later
// refuses.
async function probe(url, timeout = PROBE_TIMEOUT) {
    const t0 = performance.now()
    try {
        const data = await post(
            { json: true, code: DIRECTORY, scope: DIRECTORY, table: 'dacs', limit: 1 },
            { timeout, url })
        // `at` is when this node served the probe, so its budget can start from
        // there rather than from zero.
        return Array.isArray(data.rows) ? { url, ms: performance.now() - t0, at: Date.now() } : null
    } catch {
        return null
    }
}

// Runs `fn` over `items` a few at a time. Workers pull from a shared cursor, so
// a slow DAO holds up only itself.
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length)
    let cursor = 0
    const worker = async () => {
        while (cursor < items.length) {
            const i = cursor++
            out[i] = await fn(items[i])
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
    return out
}

// ── Loading ───────────────────────────────────────────────────────────────

// Syndicates hold a treasury; unions do not. That is a real functional
// difference the directory encodes, rather than a naming convention — and it
// agrees exactly with the titles, which end in "Union" on the same six rows.
// The structural signal is the one used here because it is what the contracts
// actually mean by the distinction.
//
// Test A and Test B have treasuries, so they sit with the syndicates.
const classify = (accountKeys) => accountKeys.includes(TREASURY) ? 'syndicate' : 'union'

async function loadDao(row) {
    const accounts = Object.fromEntries(row.accounts.map((a) => [a.key, a.value]))
    const [precision, code] = String(row.symbol?.sym ?? '').split(',')
    const dao = {
        id: row.dac_id,
        title: row.title || row.dac_id,
        // setperiodlen requires this account's authority, and it is what a msig
        // proposal has to request approval from.
        owner: row.owner ?? null,
        group: classify(row.accounts.map((a) => a.key)),
        // Which token this DAO runs on, and where it lives. Both come from the
        // directory rather than being assumed, the same as the custodian
        // contract does.
        symbol: code ?? '',
        precision: Number(precision) || 0,
        tokenContract: row.symbol?.contract ?? null,
        custodianContract: accounts[CUSTODIAN] ?? null,
        council: [],       // the seated rows, in the order the chain seats them
        custodians: [],    // just their names, which is all a card needs
        error: null,
    }

    if (!dao.custodianContract) {
        dao.error = 'no custodian contract registered'
        return dao
    }

    try {
        // Who sits now, and who would sit if a period ran this second. The two
        // are compared against each other, so they come from one node: split
        // across a block boundary they can disagree and invent an at-risk seat.
        const node = await acquireNode(3).catch(() => null)
        const opts = node ? { url: node.url } : {}

        const [seated, ranked, globals] = await Promise.all([
            getRows(dao.custodianContract, dao.id, 'custodians1', { limit: 100, ...opts }),
            // `bydecayed` is the fifth secondary index — index_position 6. It
            // sorts on `UINT64_MAX - rank`, so ascending on it IS descending by
            // rank, which is exactly the order newperiod walks. One page only:
            // the whole candidates table runs to hundreds of mostly-dead rows.
            postRows(dao.custodianContract, dao.id, 'candidates', {
                index_position: 6, key_type: 'i64', limit: 40, ...opts,
            }),
            // Carries `lastperiodtime` and `periodlength`, which together are the
            // only statement of when the next election is due.
            postRows(dao.custodianContract, dao.id, 'dacglobals', { limit: 1, ...opts }),
        ])

        const g = {}
        for (const kv of globals[0]?.data ?? []) g[kv.key] = kv.value?.[1]
        const last = Date.parse(`${g.lastperiodtime}Z`)
        const length = Number(g.periodlength)
        dao.nextElection = Number.isFinite(last) && Number.isFinite(length) && length > 0
            ? last + length * 1000
            : null
        dao.periodLength = Number.isFinite(length) ? length : null
        // The contract refuses a period shorter than any pending-period delay that
        // has been set. Absent from every DAO today, so it defaults to nothing.
        dao.pendingPeriodDelay = Number(g.pending_period_delay) || 0

        // The contract seats candidates off that same index, so leaving these in
        // primary-key order would print a council in an order the chain does not
        // use.
        dao.council = seated.sort((a, b) => Number(b.rank) - Number(a.rank))
        dao.custodians = dao.council.map((c) => c.cust_name)

        // newperiod walks the ranked index, skips inactive candidates, requires
        // vote power above zero, and stops at `numelected`. `custodians1` holds
        // exactly numelected rows once a period has run, so the seat count is
        // the seated count — no extra dacglobals read to learn it.
        const contenders = ranked.filter((c) => c.is_active && Number(c.total_vote_power) > 0)
        dao.wouldSeat = contenders.slice(0, dao.council.length).map((c) => c.candidate_name)
        dao.nextInLine = contenders[dao.council.length]?.candidate_name ?? null
        dao.rankOf = new Map(contenders.map((c, i) => [c.candidate_name, i + 1]))

        // Only meaningful if the ranked read actually returned something.
        dao.atRisk = contenders.length
            ? new Set(dao.custodians.filter((n) => !dao.wouldSeat.includes(n)))
            : new Set()
    } catch (err) {
        dao.error = err.message ?? String(err)
    }
    return dao
}

// Settles on the fastest node that answers. Everything downstream reads the
// chain, so there is no point loading DAOs — or restoring a session — against a
// node that is not there.
async function pickEndpoint() {
    setStatus('Finding a node…')

    // Ten TLS handshakes to ten cold hosts, all at once, on a slow connection is
    // enough to blow a short deadline on every one of them — and the page then
    // dead-ends claiming the whole chain is unreachable. So a first round that
    // comes back empty is treated as "too slow", not as "nothing is there", and
    // gets one more round with a deadline nothing healthy should ever miss.
    let healthy = (await Promise.all(ENDPOINTS.map((u) => probe(u, PROBE_TIMEOUT))))
        .filter(Boolean)

    if (!healthy.length) {
        setStatus('Nothing answered in time — trying again more patiently…')
        healthy = (await Promise.all(ENDPOINTS.map((u) => probe(u, PROBE_RETRY_TIMEOUT))))
            .filter(Boolean)
    }

    healthy.sort((a, b) => a.ms - b.ms)

    if (!healthy.length) {
        setStatus('No WAX node answered.', 'error', { retry: true })
        return false
    }

    // Every node that answered carries reads from here on. More nodes is a
    // bigger budget: the per-node limit is fixed, so the aggregate rate is
    // simply how many of them are up.
    //
    // Each node's window opens already holding its probe. The probe bypasses the
    // scheduler by design — it is one deliberate call to one named node — but it
    // is still a call that node just served, and starting the budget at zero
    // would let the first burst put four on it inside the window.
    pool = healthy.map(({ url, at }) => ({ url, recent: [at], fails: 0 }))
    apiUrl = healthy[0].url
    sessionKit.setEndpoint(Chains.WAX.id, apiUrl)   // signing follows reads
    return true
}

async function loadDaos() {
    let directory
    try {
        setStatus('Reading the directory…')
        startPhase(1)
        directory = await getRows(DIRECTORY, DIRECTORY, 'dacs', { limit: 200 })
    } catch (err) {
        endPhase()
        setStatus(`Could not read ${DIRECTORY}: ${err.message}`, 'error')
        return
    }

    const shown = directory.filter((row) => !HIDDEN.has(row.dac_id))

    setStatus(`${shown.length} DAOs — reading councils…`)
    startPhase(shown.length)
    daos = await mapLimit(shown, CONCURRENCY, loadDao)
    endPhase()
    daos.sort((a, b) => a.title.localeCompare(b.title))

    $('countSyndicates').textContent = daos.filter((d) => d.group === 'syndicate').length
    $('countUnions').textContent     = daos.filter((d) => d.group === 'union').length

    const failed = daos.filter((d) => d.error)
    setStatus(failed.length
        ? `${failed.length} council${failed.length === 1 ? '' : 's'} unavailable — ` +
          `${failed.map((d) => d.id).join(', ')}`
        : null, failed.length ? 'error' : '')

    render()
}

// ── Your position ─────────────────────────────────────────────────────────
//
// Four things, per DAO, for whoever is signed in. All of them live on the DAO's
// own token contract, and all of them are scoped by dac_id rather than by the
// token symbol — which is not what `get_table_by_scope` reports, so they have to
// be read directly:
//
//   accounts   scope = the holder    what they hold liquid
//   stakes     scope = dac_id        what they have staked, keyed by account
//   staketime  scope = dac_id        their chosen unstake delay, keyed by account
//   unstakes   scope = dac_id        releases in flight, via the `byaccount` index
//
// `staketime` has no row until someone sets one; the contract then falls back to
// `stakeconfig.min_stake_time`, so a missing row means the minimum, not zero.

const assetAmount = (a) => Number(String(a ?? '0').split(' ')[0]) || 0
const assetCode   = (a) => String(a ?? '').split(' ')[1] ?? ''

// Assets are fixed-point, so the arithmetic below is done in minor units and
// never in floats — 600292.4900 minus 600000.0000 has to come out as exactly
// 292.4900, and binary floating point does not promise that. WAX supplies are
// far inside Number's safe integer range at four decimals.
const assetPrecision = (a) => (String(a ?? '').split(' ')[0].split('.')[1] ?? '').length

function assetUnits(a) {
    if (!a) return 0
    const [whole, frac = ''] = String(a).split(' ')[0].split('.')
    return Number(whole) * 10 ** frac.length + Number(frac || 0)
}

function unitsToAsset(units, precision, code) {
    const s = String(Math.max(0, Math.round(units))).padStart(precision + 1, '0')
    const whole = s.slice(0, s.length - precision)
    const frac = precision ? `.${s.slice(s.length - precision)}` : ''
    return `${whole}${frac} ${code}`
}

// Whole tokens only. The fractional part is dropped rather than rounded, and
// the symbol goes with it — the card these figures sit in is already the DAO
// whose token it is. Both survive in the row's tooltip, so the exact asset is
// never more than a hover away.
function fmtAmount(a) {
    const [whole] = String(a).split(' ')[0].split('.')
    return Number(whole).toLocaleString('en-US')
}

// Whole days, for ages. 'voted 341d ago' is the question being answered; a
// decimal place on it is noise.
const fmtAge = (ms) => `${Math.max(0, Math.floor(ms / 86400000))}d`

// `new Date(NaN).toISOString()` THROWS rather than returning anything useful, so
// every date printed from chain data goes through here. One unparseable
// timestamp was enough to take a whole screen down with it.
function isoDay(ms) {
    if (!Number.isFinite(ms)) return '—'
    try { return new Date(ms).toISOString().slice(0, 10) } catch { return '—' }
}

function isoMinute(ms) {
    if (!Number.isFinite(ms)) return '—'
    try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) } catch { return '—' }
}

// Time to the next election. `newperiod` is permissionless but somebody still
// has to send it, so a due date in the past means nobody has — which is a real
// state, not an error, and says "pending" rather than counting up.
//
// Seconds only appear inside the last hour: above that they change nothing a
// reader cares about and just make the whole card twitch every second.
function fmtCountdown(ms) {
    if (!Number.isFinite(ms)) return '—'
    if (ms <= 0) return 'pending'

    const total = Math.floor(ms / 1000)
    const d = Math.floor(total / 86400)
    const h = Math.floor((total % 86400) / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60

    if (total < 3600) return `${m}m ${s}s`
    if (d > 0) return `${d}d ${h}h ${m}m`
    return `${h}h ${m}m`
}

// Repaints just the countdown text in place. A full re-render every second would
// throw away scroll position, checkbox state and any half-typed amount.
function tickCountdowns() {
    const now = Date.now()
    for (const el of document.querySelectorAll('[data-due]')) {
        const due = Number(el.dataset.due)
        const text = fmtCountdown(due - now)
        if (el.textContent !== text) el.textContent = text
        el.classList.toggle('is-pending', due - now <= 0)
        el.classList.toggle('is-soon', due - now > 0 && due - now < 3600000)
    }
}

function fmtDays(seconds) {
    const days = seconds / 86400
    const shown = days >= 10 ? Math.round(days) : Math.round(days * 10) / 10
    return `${shown} day${shown === 1 ? '' : 's'}`
}

// One DAO's three staking tables, pinned to a single node so they agree with
// each other. If that node fails the reads go back through the scheduler, where
// a retry can land anywhere — a consistent answer is preferred, but no answer is
// worse than a possibly-skewed one.
async function readStakeTables(dao, actor, bounded) {
    const unstakeQuery = {
        // `unstakes` is keyed by an auto-incrementing id, so finding one
        // account's releases means the byaccount secondary index.
        index_position: 2, key_type: 'name',
        lower_bound: actor, upper_bound: actor, limit: 100,
    }

    const read = (opts) => Promise.all([
        getRows(dao.tokenContract, dao.id, 'stakes', { ...bounded, ...opts }),
        getRows(dao.tokenContract, dao.id, 'staketime', { ...bounded, ...opts }),
        getRows(dao.tokenContract, dao.id, 'unstakes', { ...unstakeQuery, ...opts }),
    ])

    let rows
    try {
        const node = await acquireNode(3)
        rows = await read({ url: node.url })
    } catch {
        rows = await read({})
    }
    const [stakeRows, timeRows, unstakeRows] = rows
    return { stakeRows, timeRows, unstakeRows }
}

async function loadPosition() {
    if (!session || !daos.length) {
        position = new Map()
        votes = new Map()
        setTlm(null)
        render()
        return
    }

    const actor = String(session.actor)
    const bounded = { lower_bound: actor, upper_bound: actor, limit: 1 }
    const next = new Map()
    const nextVotes = new Map()

    // One balances read per token contract, one for TLM, then three per DAO. Any
    // stakeconfig follow-ups land on top of this, which the bar clamps rather
    // than overruns.
    const contractCount = new Set(daos.map((d) => d.tokenContract).filter(Boolean)).size
    setStatus(`Reading your holdings across ${daos.length} DAOs…`)
    startPhase(contractCount + 1 + daos.length * 3)

    try {
        // Trilium first: it is one read and it is the figure sitting next to the
        // account name, so it should not wait behind twelve DAOs.
        const [tlmRow] = await getRows(TLM_CONTRACT, actor, 'accounts', { limit: 20 })
            .then((rows) => rows.filter((r) => assetCode(r.balance) === TLM_SYMBOL))
            .catch(() => [])
        setTlm(tlmRow?.balance ?? null)

        // One read per token contract gets every balance that holder has, so
        // this does not have to be asked per DAO.
        const contracts = [...new Set(daos.map((d) => d.tokenContract).filter(Boolean))]
        const balances = new Map()
        for (const contract of contracts) {
            for (const row of await getRows(contract, actor, 'accounts', { limit: 200 })) {
                balances.set(`${contract}:${assetCode(row.balance)}`, row.balance)
            }
        }

        await mapLimit(daos, CONCURRENCY, async (dao) => {
            if (!dao.tokenContract) return

            // All three from one node, in one window. `unstake` moves tokens out
            // of `stakes` and into `unstakes` in a single transaction, so reading
            // the two from nodes at different heights can show the same tokens
            // twice — once as staked and once as unstaking.
            const { stakeRows, timeRows, unstakeRows } = await readStakeTables(dao, actor, bounded)

            // The vote lives on the custodian contract, not the token contract,
            // and has to agree with nothing else — so it goes back through the
            // scheduler rather than eating a slot on the pinned node.
            if (dao.custodianContract) {
                try {
                    const [row] = await getRows(dao.custodianContract, dao.id, 'votes', bounded)
                    if (row) nextVotes.set(dao.id, row)
                } catch (err) {
                    // Leaving this DAO out of the map is what disables the
                    // refresh-all button, which is the intended behaviour: it
                    // must never fire a partial slate.
                    console.error(`Could not read your vote in ${dao.id}:`, err)
                }
            }

            const balance = balances.get(`${dao.tokenContract}:${dao.symbol}`) ?? null
            const staked  = stakeRows[0]?.stake ?? null

            const unstakes = unstakeRows
                .filter((u) => assetAmount(u.stake) > 0)
                .map((u) => ({ key: u.key, stake: u.stake, release: Date.parse(`${u.release_time}Z`) }))
                .sort((a, b) => a.release - b.release)

            // `accounts.balance` is the TOTAL held, not the free part. What is
            // actually spendable is the contract's own `get_liquid`:
            //
            //     liquid = balance - stake - unstakes not yet released
            //
            // A released unstake is deliberately not subtracted — the contract
            // erases those rows on sight, so they are back in hand.
            const now = Date.now()
            const lockedUnits = unstakes
                .filter((u) => u.release > now)
                .reduce((n, u) => n + assetUnits(u.stake), 0)
            const freeUnits = assetUnits(balance) - assetUnits(staked) - lockedUnits

            const entry = {
                total:     assetAmount(balance) > 0 ? balance : null,
                // Always a real asset string, zero included. Whether the line is
                // worth printing is a rendering question, not a data one — and
                // the answer there is yes, so cards with a position all share a
                // shape instead of the first row appearing and disappearing.
                notStaked: unitsToAsset(freeUnits, dao.precision, dao.symbol),
                hasFree:   freeUnits > 0,
                staked:    assetAmount(staked) > 0 ? staked : null,
                delay:     timeRows[0] ? Number(timeRows[0].delay) : null,
                delayIsMinimum: false,
                unstakes,
            }

            if (entry.hasFree || entry.staked || entry.unstakes.length) next.set(dao.id, entry)
        })

        // Only the DAOs actually holding a stake without an explicit delay need
        // the config read, which is usually none of them.
        const needConfig = daos.filter((d) => {
            const e = next.get(d.id)
            return e?.staked && e.delay == null
        })
        await mapLimit(needConfig, CONCURRENCY, async (dao) => {
            const [config] = await getRows(dao.tokenContract, dao.id, 'stakeconfig', { limit: 1 })
            if (!config) return
            Object.assign(next.get(dao.id), {
                delay: Number(config.min_stake_time),
                delayIsMinimum: true,
            })
        })

        position = next
        votes = nextVotes
        setStatus(null)
    } catch (err) {
        console.error('Could not read your position:', err)
        setNote('Could not read your balances', { sticky: true })
        setStatus('Could not read your holdings — reload to retry', 'error')
        position = new Map()
        votes = new Map()
    } finally {
        endPhase()
    }

    render()
}

// ── Render ────────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Every line here is dropped when it would read as a zero, so a DAO you have
// nothing in shows nothing at all rather than four empty rows.
function positionHtml(dao) {
    const p = position.get(dao.id)
    if (!p) return ''

    const lines = []

    // Shown even at zero: every DAO you hold a position in then has the same
    // first row, rather than the block starting on a different line depending on
    // whether anything happens to be free.
    //
    // The free figure is derived, not read, so its tooltip shows the sum it came
    // from — otherwise a number that matches no single table row looks invented.
    {
        const parts = [`${p.notStaked} free`]
        if (p.total) parts.push(`${p.total} held`)
        if (p.staked) parts.push(`${p.staked} staked`)
        lines.push(['Not staked', esc(fmtAmount(p.notStaked)), parts.join(' · ')])
    }
    if (p.staked) lines.push(['Staked', esc(fmtAmount(p.staked)), p.staked])

    // The delay governs a future unstake, so it is only worth saying while
    // there is a stake for it to apply to.
    if (p.staked && p.delay > 0) {
        lines.push([
            'Stake time',
            esc(fmtDays(p.delay)),
            p.delayIsMinimum ? "this DAO's minimum — no delay set" : '',
        ])
    }

    // Every release collapses into ONE row here, however many there are. The
    // card has to stay the same height as every other card, and the per-release
    // detail — with its own cancel — is what the panel is for.
    const now = Date.now()
    if (p.unstakes.length) {
        const totalUnits = p.unstakes.reduce((n, u) => n + assetUnits(u.stake), 0)
        const total = unitsToAsset(totalUnits, dao.precision, dao.symbol)
        const soonest = p.unstakes[0]           // sorted by release when built
        const done = soonest.release <= now
        const when = done ? 'claimable' : `in ${fmtDays((soonest.release - now) / 1000)}`

        const detail = p.unstakes.map((u) => `${u.stake} ${u.release <= now
            ? 'claimable'
            : `on ${isoDay(u.release)}`}`).join(' · ')

        lines.push([
            p.unstakes.length > 1 ? `Unstaking ×${p.unstakes.length}` : 'Unstaking',
            `${esc(fmtAmount(total))} <i class="${done ? 'is-ready' : ''}">${esc(when)}</i>`,
            detail,
        ])
    }

    if (!lines.length) return ''

    return `<dl class="mine">${lines.map(([label, value, title]) => `
        <div${title ? ` title="${esc(title)}"` : ''}>
            <dt>${esc(label)}</dt><dd>${value}</dd>
        </div>`).join('')}</dl>`
}

function daoHtml(dao) {
    const held = dao.custodians.filter((name) => WATCHED.has(name)).length

    const council = dao.error
        ? `<li class="none">Unavailable — ${esc(dao.error)}</li>`
        : dao.custodians.length === 0
            ? '<li class="none">No custodians seated</li>'
            : dao.custodians.map((name) => {
                // Seated today, but below the cut on today's ranking — they lose
                // the seat if a period runs before the votes move.
                const risk = dao.atRisk?.has(name)
                const place = dao.rankOf?.get(name)
                return `<li${risk ? ' class="is-risk"' : ''}>
                    <a class="${WATCHED.has(name) ? 'is-watched' : ''}"
                       href="${EXPLORER}${encodeURIComponent(name)}" target="_blank"
                       rel="noopener">${esc(name)}</a>
                    ${risk ? `<span class="risk" title="Ranked ${
                        place ? `${place}${place === 1 ? 'st' : place === 2 ? 'nd' : place === 3 ? 'rd' : 'th'}`
                              : 'below'} of the standing candidates, for ${dao.council.length} seats — ` +
                        `would lose this seat if a period ran now">at risk</span>` : ''}
                </li>`
            }).join('')

    // The marker states the count it is derived from, so it never has to be
    // taken on trust — the seats it counts are the blue ones directly below it.
    const marker = held >= CONTROL_THRESHOLD
        ? `<span class="mc" title="${held} of ${dao.custodians.length} seats held by the watched accounts">MC controlled</span>`
        : ''

    // When your vote here was last cast. Sits with the id rather than in the
    // corner now that the election clock has the title line.
    const vote = votes.get(dao.id)
    const voted = vote ? Date.parse(`${vote.vote_time_stamp}Z`) : NaN
    const age = Number.isFinite(voted)
        ? `<span class="vote-age" title="You voted ${isoDay(voted)} for ${
              esc((vote.candidates ?? []).join(', ') || 'nobody')}">voted ${
              esc(fmtAge(Date.now() - voted))} ago</span>`
        : ''

    // The clock is painted once here and then only its text is rewritten, once a
    // second, by tickCountdowns.
    const due = dao.nextElection
    const clock = due
        ? `<span class="election" data-due="${due}"
                 title="Next election due ${isoMinute(due)} UTC${
                     dao.periodLength ? ` · period is ${fmtDays(dao.periodLength)}` : ''}">${
                 esc(fmtCountdown(due - Date.now()))}</span>`
        : ''

    // The holdings sit beside the council rather than above it. With no session,
    // or nothing held here, the aside is absent and the council takes the full
    // card — so an empty column never has to be reserved for it.
    return `
    <article class="dao" data-id="${esc(dao.id)}">
        <div class="dao-top">
            <h2>${esc(dao.title)}</h2>
            ${clock}
        </div>
        <p class="dao-id">${esc(dao.id)}${marker}${age}</p>
        <div class="dao-body">
            <ul class="council">${council}</ul>
            ${positionHtml(dao)}
        </div>
        <div class="dao-btns">
            <button class="card-btn" data-details="${esc(dao.id)}" type="button">Details</button>
            <button class="card-btn is-primary" data-actions="${esc(dao.id)}" type="button">Actions</button>
        </div>
    </article>`
}

function render() {
    daosEl.innerHTML = daos.filter((d) => d.group === group).map(daoHtml).join('')
    refreshVotesChrome()
    const open = daosEl.querySelector(`.dao[data-id="${selectedId}"]`)
    if (open) open.classList.add('is-selected')
    // The panel reads the same `position` map the cards do, so anything that
    // re-renders one has to re-render the other.
    if (selectedId) renderPanel()
}

// ── Wallet ────────────────────────────────────────────────────────────────

const connectBtn = $('connectWalletBtn')
const walletEl   = $('wallet')
const walletMenu = $('walletMenu')
const walletWho  = $('walletWho')
const walletNote = $('walletNote')

let noteTimer

// The one place beside the button that says what just happened. Cancelling a
// wallet dialog is a decision, not a failure, so it clears itself; a real error
// stays until the next attempt.
function setNote(text, { sticky = false } = {}) {
    clearTimeout(noteTimer)
    walletNote.textContent = text ?? ''
    walletNote.hidden = !text
    if (text && !sticky) noteTimer = setTimeout(() => { walletNote.hidden = true }, 4000)
}

function setMenuOpen(open) {
    walletMenu.hidden = !open
    connectBtn.setAttribute('aria-expanded', String(open))
}

// Trilium sits beside the account name, not on a card: it is the one balance
// that belongs to the player rather than to any single DAO.
function setTlm(asset) {
    const el = $('tlm')
    if (!asset || assetAmount(asset) <= 0) {
        el.hidden = true
        el.textContent = ''
        return
    }
    el.textContent = `${fmtAmount(asset)} TLM`
    el.title = asset
    el.hidden = false
}

function setWalletChrome() {
    const label = connectBtn.querySelector('.btn-label')
    connectBtn.classList.toggle('is-connected', !!session)
    label.textContent = session ? String(session.actor) : 'Connect Wallet'
    connectBtn.title = session
        ? `Signed in as ${session.permissionLevel}`
        : 'Connect a WAX wallet — optional, nothing here signs anything'
    walletWho.textContent = session ? String(session.permissionLevel) : ''

    // A menu left standing open across a change of session would be offering to
    // sign out of one that has already gone.
    setMenuOpen(false)
}

// Antelope buries the useful text a few levels down.
const readableError = (error) =>
    String(error?.details?.[0]?.message ?? error?.message ?? 'Unknown error')
        .replace(/^assertion failure with message:\s*/i, '')

const isUserCancel = (error) => {
    const m = String(error?.message ?? '').toLowerCase()
    return m.includes('cancel') || m.includes('rejected') || m.includes('closed')
}

async function connect() {
    connectBtn.disabled = true
    connectBtn.querySelector('.btn-label').textContent = 'Connecting…'
    setNote('')

    try {
        // No walletPlugin argument, so WharfKit shows its own picker — Cloud
        // Wallet and Anchor, in the order the plugins were registered.
        const result = await sessionKit.login()
        session = result.session
        setWalletChrome()
        await loadPosition()
    } catch (error) {
        if (isUserCancel(error)) {
            setNote('Cancelled')
        } else {
            console.error('Login failed:', error)
            setNote(readableError(error), { sticky: true })
        }
        session = null
    } finally {
        connectBtn.disabled = false
        setWalletChrome()
    }
}

async function disconnect() {
    setMenuOpen(false)
    try {
        if (session) await sessionKit.logout(session)
    } catch (error) {
        // The local session is dropped either way — leaving someone stuck signed
        // in because a wallet would not acknowledge the logout is worse than a
        // stale record on the wallet's side.
        console.error('Logout failed:', error)
    }
    session = null
    setWalletChrome()
    await loadPosition()
    setNote('Signed out')
}

// A session in storage is one the browser already holds; restoring it needs no
// wallet dialog, so it must not open one if the wallet has since forgotten us.
async function restoreSession() {
    try {
        const restored = await sessionKit.restore()
        if (!restored) return
        session = restored
        setWalletChrome()
        await loadPosition()
    } catch (error) {
        console.error('Session restore failed:', error)
    }
}

connectBtn.addEventListener('click', () => {
    if (session) {
        setMenuOpen(walletMenu.hidden)
        return
    }
    setMenuOpen(false)
    connect()
})

$('logoutBtn').addEventListener('click', disconnect)

// Anywhere else shuts the menu, which is what an open menu is expected to do.
// Tested against the wrapper rather than the button, or a click landing on the
// menu itself would close it before the item could act.
document.addEventListener('click', (e) => {
    if (walletMenu.hidden || walletEl.contains(e.target)) return
    setMenuOpen(false)
})

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenuOpen(false)
})

// ── Actions ───────────────────────────────────────────────────────────────
//
// Everything below signs. The exact shapes were read off the contracts and then
// confirmed against live mainnet traces:
//
//   stake        token.worlds::stake(account, quantity)
//   unstake      token.worlds::unstake(account, quantity)
//   claim        token.worlds::claimunstkes(account, token_symbol)
//   cancel       token.worlds::cancel(unstake_id, token_symbol)
//   TLM -> token alien.worlds::transfer(-> stake.worlds, memo "staking")
//                + stake.worlds::stake(account, planet_name, quantity)   [one trx]
//   token -> TLM token.worlds::transfer(-> stake.worlds, memo "Unstaking")
//
// `planet_name` is not uniform: syndicates are addressed by their planet account
// (`eyeke.world`, from plnts.worlds) and unions by their dac_id (`kavianunn`,
// from stake.worlds/stakedaos). Both branches were confirmed on chain.

const STAKE_CONTRACT = 'stake.worlds'
const PLANETS_CONTRACT = 'plnts.worlds'

let selectedId = null
let swapTargets = new Map()   // symbol code -> the name stake.worlds wants
let stakeConfigs = new Map()  // dac_id -> { min, max }
let busy = false

const panelEl = $('panel')
const panelInner = $('panelInner')

const daoById = (id) => daos.find((d) => d.id === id)

// A number typed by a person into the fixed-point string the chain requires.
// Truncates rather than rounds: rounding up could ask to move more than is held.
function toAsset(input, precision, code) {
    const n = Number(String(input).trim().replace(/,/g, ''))
    if (!Number.isFinite(n) || n <= 0) return null
    const units = Math.floor(n * 10 ** precision + 1e-6)
    if (units <= 0) return null
    return unitsToAsset(units, precision, code)
}

// The two lookups stake.worlds needs, read once. Syndicates come from the planet
// registry keyed by symbol; unions are listed on stake.worlds itself.
async function loadSwapTargets() {
    const next = new Map()
    try {
        for (const p of await getRows(PLANETS_CONTRACT, PLANETS_CONTRACT, 'planets', { limit: 100 })) {
            const code = String(p.dac_symbol ?? '').split(',')[1]
            if (code && p.active) next.set(code, p.planet_name)
        }
    } catch (err) {
        console.error('Could not read the planet registry:', err)
    }
    try {
        for (const d of await getRows(STAKE_CONTRACT, STAKE_CONTRACT, 'stakedaos', { limit: 100 })) {
            const code = String(d.dac_symbol ?? '').split(',')[1]
            if (code) next.set(code, d.dac_id)
        }
    } catch (err) {
        console.error('Could not read the union swap list:', err)
    }
    swapTargets = next
}

async function stakeConfigFor(dao) {
    if (stakeConfigs.has(dao.id)) return stakeConfigs.get(dao.id)
    const [row] = await getRows(dao.tokenContract, dao.id, 'stakeconfig', { limit: 1 })
    const cfg = row
        ? { min: Number(row.min_stake_time), max: Number(row.max_stake_time), enabled: !!row.enabled }
        : null
    stakeConfigs.set(dao.id, cfg)
    return cfg
}

// Held in a variable rather than only in the DOM. A successful action re-reads
// the position, which re-renders the panel — so a note written straight to the
// element would be wiped by the very refresh it was reporting.
let panelMessage = null
let panelAction = null   // which action the modal is showing a form for

function panelNote(text, kind = '') {
    panelMessage = text ? { text, kind } : null
    paintNote()
}

function paintNote() {
    const el = $('panelNote')
    if (!el) return
    el.textContent = panelMessage?.text ?? ''
    el.className = `panel-note${panelMessage?.kind ? ` is-${panelMessage.kind}` : ''}`
    el.hidden = !panelMessage
}

// A cheap fingerprint of what an action is about to change, so the wait
// afterwards can watch for it rather than guessing at a duration.
async function stakeSnapshot(dao) {
    if (!dao?.tokenContract || !session) return null
    try {
        const actor = String(session.actor)
        const { stakeRows, unstakeRows } = await readStakeTables(dao, actor, {
            lower_bound: actor, upper_bound: actor, limit: 1,
        })
        return JSON.stringify([stakeRows, unstakeRows])
    } catch {
        return null
    }
}

// Polls the affected DAO until its staking tables differ from `before`. Bounded,
// because not every action changes them — a conversion touches balances only —
// and the caller re-reads regardless once this returns.
async function waitForChange(dao, before) {
    if (before == null) return sleep(2000)
    for (let i = 0; i < 8; i++) {
        await sleep(1000)
        if (await stakeSnapshot(dao) !== before) return
    }
}

// One place where every signature is sent, so the busy-lock, the error text and
// the re-read afterwards cannot be forgotten by an individual handler.
async function submit(actions, describe) {
    if (!session || busy) return
    const dao = daoById(selectedId)
    busy = true
    renderPanel()
    panelNote(`${describe} — check your wallet…`, 'work')

    const before = await stakeSnapshot(dao)

    try {
        const result = await session.transact({ actions }, { broadcast: true })
        const id = String(result?.resolved?.transaction?.id ?? result?.response?.transaction_id ?? '')
        panelNote(`${describe} sent${id ? ` · ${id.slice(0, 8)}` : ''} — re-reading…`, 'ok')

        // An accepted transaction is not a row you can read yet — the block has
        // to land. A fixed wait is a guess that gets it wrong on a slow block, so
        // this watches the two tables the actions touch until they actually move,
        // and only then re-reads everything.
        await waitForChange(dao, before)
        await loadPosition()
        panelNote(`${describe} done.`, 'ok')
    } catch (err) {
        if (isUserCancel(err)) panelNote('Cancelled.')
        else {
            console.error(`${describe} failed:`, err)
            panelNote(readableError(err), 'error')
        }
    } finally {
        busy = false
        renderPanel()
    }
}

const auth = () => [session.permissionLevel]

function actStake(dao, amount) {
    const q = toAsset(amount, dao.precision, dao.symbol)
    if (!q) return panelNote('Enter an amount above zero.', 'error')
    return submit([{
        account: dao.tokenContract, name: 'stake', authorization: auth(),
        data: { account: String(session.actor), quantity: q },
    }], `Stake ${q}`)
}

function actUnstake(dao, amount) {
    const q = toAsset(amount, dao.precision, dao.symbol)
    if (!q) return panelNote('Enter an amount above zero.', 'error')
    return submit([{
        account: dao.tokenContract, name: 'unstake', authorization: auth(),
        data: { account: String(session.actor), quantity: q },
    }], `Unstake ${q}`)
}

function actClaim(dao) {
    return submit([{
        account: dao.tokenContract, name: 'claimunstkes', authorization: auth(),
        data: { account: String(session.actor), token_symbol: `${dao.precision},${dao.symbol}` },
    }], 'Claim')
}

function actCancel(dao, key) {
    return submit([{
        account: dao.tokenContract, name: 'cancel', authorization: auth(),
        data: { unstake_id: String(key), token_symbol: `${dao.precision},${dao.symbol}` },
    }], 'Cancel unstake')
}

function actSetStakeTime(dao, days, cfg) {
    const n = Number(String(days).trim())
    if (!Number.isFinite(n) || n <= 0) return panelNote('Enter a number of days.', 'error')
    const seconds = Math.round(n * 86400)
    if (cfg && (seconds < cfg.min || seconds > cfg.max)) {
        return panelNote(`Must be between ${fmtDays(cfg.min)} and ${fmtDays(cfg.max)}.`, 'error')
    }
    return submit([{
        account: dao.tokenContract, name: 'staketime', authorization: auth(),
        data: {
            account: String(session.actor),
            unstake_time: seconds,
            token_symbol: `${dao.precision},${dao.symbol}`,
        },
    }], `Stake time ${fmtDays(seconds)}`)
}

// TLM in. Both actions ride in one transaction — the transfer alone would just
// park TLM on stake.worlds with nothing to claim it.
function actBuy(dao, amount) {
    const target = swapTargets.get(dao.symbol)
    if (!target) return panelNote('This DAO is not listed for TLM swaps.', 'error')
    const q = toAsset(amount, 4, TLM_SYMBOL)
    if (!q) return panelNote('Enter an amount above zero.', 'error')
    const actor = String(session.actor)
    return submit([
        {
            account: TLM_CONTRACT, name: 'transfer', authorization: auth(),
            data: { from: actor, to: STAKE_CONTRACT, quantity: q, memo: 'staking' },
        },
        {
            account: STAKE_CONTRACT, name: 'stake', authorization: auth(),
            data: { account: actor, planet_name: target, quantity: q },
        },
    ], `Convert ${q} to ${dao.symbol}`)
}

// Token out. stake.worlds burns what it receives and refunds TLM 1:1.
function actSell(dao, amount) {
    const q = toAsset(amount, dao.precision, dao.symbol)
    if (!q) return panelNote('Enter an amount above zero.', 'error')
    return submit([{
        account: dao.tokenContract, name: 'transfer', authorization: auth(),
        data: { from: String(session.actor), to: STAKE_CONTRACT, quantity: q, memo: 'Unstaking' },
    }], `Convert ${q} to TLM`)
}

// Re-casting the same slate is what "refreshing" a vote is: `votecust` rewrites
// `vote_time_stamp`, which feeds each candidate's `avg_vote_time_stamp` and so
// their `rank`. The candidate list is unchanged — only its age is.
function voteAction(dao, candidates) {
    return {
        account: dao.custodianContract, name: 'votecust', authorization: auth(),
        data: { voter: String(session.actor), newvotes: candidates, dac_id: dao.id },
    }
}

// The whole group in one transaction, or not at all. `eligible` is every DAO in
// the group that has a vote row AND candidates in it; the button is only offered
// when that set covers the group completely.
function groupVoteState() {
    const inGroup = daos.filter((d) => d.group === group)
    const eligible = inGroup.filter((d) => (votes.get(d.id)?.candidates ?? []).length > 0)
    const missing = inGroup.filter((d) => !votes.has(d.id))
    return { inGroup, eligible, missing, complete: inGroup.length > 0 && missing.length === 0 }
}

function refreshVotesChrome() {
    const btn = $('refreshVotesBtn')
    if (!session || !daos.length) {
        btn.hidden = true
        return
    }
    const { inGroup, eligible, missing, complete } = groupVoteState()
    const label = group === 'syndicate' ? 'syndicates' : 'unions'

    btn.hidden = false
    btn.disabled = busy || !complete || eligible.length === 0
    btn.textContent = complete
        ? `Refresh votes · ${eligible.length} ${label}`
        : `Refresh votes · ${inGroup.length - missing.length}/${inGroup.length} read`
    btn.title = complete
        ? (eligible.length
            ? `Re-cast your existing slate in ${eligible.map((d) => d.title).join(', ')}`
            : `No votes cast in any ${label} yet`)
        : `Votes could not be read for ${missing.map((d) => d.id).join(', ')} — ` +
          `refreshing part of the group would leave those behind`
}

async function refreshGroupVotes() {
    const { eligible, complete } = groupVoteState()
    if (!session || busy || !complete || !eligible.length) return

    const actions = eligible.map((d) => voteAction(d, votes.get(d.id).candidates))
    busy = true
    refreshVotesChrome()
    setStatus(`Refreshing ${eligible.length} votes — check your wallet…`)

    try {
        await session.transact({ actions }, { broadcast: true })
        await sleep(2500)
        await loadPosition()
        setStatus(`Refreshed votes in ${eligible.length} DAOs.`)
    } catch (err) {
        if (isUserCancel(err)) setStatus('Vote refresh cancelled.')
        else {
            console.error('Vote refresh failed:', err)
            setStatus(readableError(err), 'error')
        }
    } finally {
        busy = false
        refreshVotesChrome()
        renderPanel()
    }
}

// ── Panel ─────────────────────────────────────────────────────────────────

function form(id, label, { hint, unit, max, cta, disabled }) {
    return `
    <div class="act">
        <div class="act-head">
            <span class="act-label">${esc(label)}</span>
            ${hint ? `<span class="act-hint">${esc(hint)}</span>` : ''}
        </div>
        <div class="act-row">
            <input id="${id}-in" type="text" inputmode="decimal" placeholder="0"
                   autocomplete="off" ${disabled ? 'disabled' : ''}>
            ${unit ? `<span class="act-unit">${esc(unit)}</span>` : ''}
            ${max ? `<button class="act-max" data-max="${id}" data-value="${esc(max)}"
                             type="button" ${disabled ? 'disabled' : ''}>max</button>` : ''}
            <button class="act-go" data-act="${id}" type="button" ${disabled ? 'disabled' : ''}>${esc(cta)}</button>
        </div>
    </div>`
}

// Same contract as renderDetails: the overlay is only revealed once there is
// something in it, and a failed build closes rather than stranding the reader
// behind a blank sheet.
function renderPanel() {
    if (!selectedId) {
        panelEl.hidden = true
        document.body.classList.remove('is-modal')
        return
    }
    const dao = daoById(selectedId)
    if (!dao) return closePanel()

    try {
        panelInner.innerHTML = buildPanel(dao)
    } catch (err) {
        console.error('Could not render the actions panel:', err)
        panelInner.innerHTML = `
            <header class="panel-head">
                <div><h2>${esc(dao.title)}</h2></div>
                <button class="panel-close" id="panelClose" type="button" aria-label="Close">×</button>
            </header>
            <p class="panel-note is-error">These actions could not be drawn: ${
                esc(String(err.message ?? err))}</p>`
    }
    paintNote()
}

function buildPanel(dao) {
    const p = position.get(dao.id)
    const cfg = stakeConfigs.get(dao.id)
    const now = Date.now()
    const released = (p?.unstakes ?? []).filter((u) => u.release <= now)
    const swappable = swapTargets.has(dao.symbol)

    const head = `
        <header class="panel-head">
            <div>
                <h2>${esc(dao.title)}</h2>
                <p class="panel-sub">${esc(dao.id)} · ${esc(dao.symbol)}</p>
            </div>
            <button class="panel-close" id="panelClose" type="button" aria-label="Close">×</button>
        </header>`

    if (!session) {
        return `${head}
            <p class="panel-empty">Connect a wallet to stake, unstake or convert here.</p>`
    }

    const rows = []
    if (p) {
        rows.push(['Not staked', fmtAmount(p.notStaked), p.notStaked])
        if (p.staked) rows.push(['Staked', fmtAmount(p.staked), p.staked])
        if (p.delay) {
            rows.push(['Stake time', fmtDays(p.delay),
                p.delayIsMinimum ? "this DAO's minimum — none set" : ''])
        }
    }

    const unstakeRows = (p?.unstakes ?? []).map((u) => `
        <div class="panel-row is-unstake">
            <span class="panel-k">Unstaking</span>
            <span class="panel-v">${esc(fmtAmount(u.stake))}
                <i class="${u.release <= now ? 'is-ready' : ''}">${
                    u.release <= now ? 'claimable' : `in ${esc(fmtDays((u.release - now) / 1000))}`
                }</i></span>
            <button class="act-mini" data-cancel="${u.key}" type="button"
                    title="Return this to your stake">cancel</button>
        </div>`).join('')

    const free = p?.notStaked ? assetAmount(p.notStaked) : 0
    const staked = p?.staked ? assetAmount(p.staked) : 0

    // Every action, with what it needs and whether it can run at all. Building
    // this as data rather than as six inline forms is what lets the chooser and
    // the form be two views of the same list.
    const menu = [
        {
            id: 'stake', label: 'Stake', blurb: 'Lock tokens to give them voting power',
            unit: dao.symbol, max: free > 0 ? String(free) : '', cta: 'Stake',
            ready: free > 0, why: 'nothing free to stake',
            hint: free > 0 ? `${fmtAmount(p.notStaked)} ${dao.symbol} free` : '',
        },
        {
            id: 'unstake', label: 'Unstake', blurb: 'Start releasing staked tokens',
            unit: dao.symbol, max: staked > 0 ? String(staked) : '', cta: 'Unstake',
            ready: staked > 0, why: 'nothing staked',
            hint: staked > 0
                ? `${fmtAmount(p.staked)} staked · releases after ${fmtDays(p?.delay ?? cfg?.min ?? 0)}`
                : '',
        },
        {
            id: 'staketime', label: 'Change stake time', blurb: 'Set how long unstaking takes',
            unit: 'days', cta: 'Set', ready: !!cfg, why: 'reading limits…',
            hint: cfg ? `${fmtDays(cfg.min)} – ${fmtDays(cfg.max)} · cannot be reduced while staked` : '',
        },
        {
            id: 'claim', label: 'Claim unstake', blurb: 'Free up releases that have matured',
            cta: 'Claim', noInput: true,
            ready: released.length > 0, why: 'nothing released yet',
            hint: released.length ? `${released.length} release${released.length === 1 ? '' : 's'} ready` : '',
        },
        {
            id: 'buy', label: `Get ${dao.symbol}`, blurb: `Convert TLM into ${dao.symbol}, 1:1`,
            unit: 'TLM', cta: 'Convert', ready: swappable, why: 'not listed for swaps',
            hint: swappable ? 'sends TLM, receives the DAO token' : '',
        },
        {
            id: 'sell', label: 'Get TLM', blurb: `Convert ${dao.symbol} back into TLM, 1:1`,
            unit: dao.symbol, max: free > 0 ? String(free) : '', cta: 'Convert',
            ready: swappable && free > 0, why: swappable ? 'nothing free to convert' : 'not listed for swaps',
            hint: swappable && free > 0 ? `from the ${fmtAmount(p?.notStaked ?? '0')} not staked` : '',
        },
    ]

    const chosen = menu.find((a) => a.id === panelAction)

    // Two views of the same modal: pick an action, or fill one in. Showing all
    // six forms at once was the thing that felt overwhelming.
    const body = chosen
        ? `
        <button class="act-back" id="actionBack" type="button">← all actions</button>
        <div class="act-chosen">
            <h3>${esc(chosen.label)}</h3>
            <p class="act-blurb">${esc(chosen.blurb)}</p>
            ${chosen.hint ? `<p class="act-hint-line">${esc(chosen.hint)}</p>` : ''}
        </div>
        ${chosen.noInput
            ? `<div class="act-row"><button class="act-go is-wide" data-act="${chosen.id}" type="button"
                   ${busy || !chosen.ready ? 'disabled' : ''}>${esc(chosen.cta)}</button></div>`
            : `<div class="act-row">
                   <input id="${chosen.id}-in" type="text" inputmode="decimal" placeholder="0"
                          autocomplete="off" ${busy || !chosen.ready ? 'disabled' : ''}>
                   ${chosen.unit ? `<span class="act-unit">${esc(chosen.unit)}</span>` : ''}
                   ${chosen.max ? `<button class="act-max" data-max="${chosen.id}"
                          data-value="${esc(chosen.max)}" type="button">max</button>` : ''}
                   <button class="act-go" data-act="${chosen.id}" type="button"
                          ${busy || !chosen.ready ? 'disabled' : ''}>${esc(chosen.cta)}</button>
               </div>`}
        ${!chosen.ready ? `<p class="act-blocked">${esc(chosen.why)}</p>` : ''}`
        : `
        <div class="act-menu">
            ${menu.map((a) => `
                <button class="act-pick${a.ready ? '' : ' is-off'}" data-pick="${a.id}" type="button">
                    <span class="act-pick-label">${esc(a.label)}</span>
                    <span class="act-pick-blurb">${esc(a.ready ? a.blurb : a.why)}</span>
                </button>`).join('')}
        </div>`

    return `${head}
        <section class="panel-pos">
            ${rows.map(([k, v, t]) => `
                <div class="panel-row"${t ? ` title="${esc(t)}"` : ''}>
                    <span class="panel-k">${esc(k)}</span><span class="panel-v">${esc(v)}</span>
                </div>`).join('')}
            ${unstakeRows}
            ${!p ? '<p class="panel-empty">You hold nothing in this DAO yet.</p>' : ''}
        </section>

        <p class="panel-note" id="panelNote" hidden></p>
        ${body}`
}

async function openPanel(id) {
    if (selectedId !== id) panelMessage = null
    panelAction = null
    selectedId = id
    panelEl.hidden = false
    document.body.classList.add('is-modal')
    renderPanel()

    const dao = daoById(id)
    if (dao && session && !stakeConfigs.has(id)) {
        try {
            await stakeConfigFor(dao)
            if (selectedId === id) renderPanel()
        } catch (err) {
            console.error('Could not read the stake config:', err)
        }
    }
}

function closePanel() {
    selectedId = null
    panelAction = null
    panelMessage = null
    panelEl.hidden = true
    document.body.classList.remove('is-modal')
}

// Clicking the scrim closes the overlay. This has to live on the overlay itself:
// events bubble upward, so a click that lands on the backdrop never reaches a
// listener attached to the box inside it.
panelEl.addEventListener('click', (e) => {
    if (e.target === panelEl) closePanel()
})

const inputVal = (id) => panelInner.querySelector(`#${id}-in`)?.value ?? ''

panelInner.addEventListener('click', async (e) => {
    // Same rule as the details view: the way out is checked before anything that
    // could fail to resolve.
    if (e.target.closest('#panelClose')) return closePanel()

    const dao = daoById(selectedId)
    if (!dao) return

    const pick = e.target.closest('[data-pick]')
    if (pick) {
        panelAction = pick.dataset.pick
        panelMessage = null
        return renderPanel()
    }
    if (e.target.closest('#actionBack')) {
        panelAction = null
        panelMessage = null
        return renderPanel()
    }

    const max = e.target.closest('[data-max]')
    if (max) {
        const input = panelInner.querySelector(`#${max.dataset.max}-in`)
        if (input) input.value = max.dataset.value
        return
    }

    const cancel = e.target.closest('[data-cancel]')
    if (cancel) return actCancel(dao, cancel.dataset.cancel)

    const go = e.target.closest('[data-act]')
    if (!go) return
    const cfg = stakeConfigs.get(dao.id)
    switch (go.dataset.act) {
        case 'stake':     return actStake(dao, inputVal('stake'))
        case 'unstake':   return actUnstake(dao, inputVal('unstake'))
        case 'staketime': return actSetStakeTime(dao, inputVal('staketime'), cfg)
        case 'buy':       return actBuy(dao, inputVal('buy'))
        case 'sell':      return actSell(dao, inputVal('sell'))
        case 'claim':     return actClaim(dao)
    }
})

// Escape asks the DOM what is on screen rather than trusting the id variables.
// If those ever fall out of step with what is displayed, this still gets you out
// — which is the whole point of an escape hatch.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!detailsEl.hidden) return closeDetails()
    if (!panelEl.hidden) return closePanel()
})

// ── Details view ──────────────────────────────────────────────────────────
//
// A full page rather than a modal: candidates run to dozens and proposals carry
// paragraphs. Its two halves — the council with its candidates, and the
// proposals — are far too much at once, so a switch shows one at a time.

// The proposals every DAO actually runs are multisig proposals on msig.worlds,
// scoped by dac_id — thousands of them per syndicate. `prop.worlds` is a
// different, much rarer thing (worker proposals, unions only) and is not what
// "proposals" means here.
//
// msig.worlds is not listed in the directory's accounts map — there is no
// account_type for it — so unlike the custodian and token contracts it has to be
// named outright.
const MSIG_CONTRACT = 'msig.worlds'

// `state` is a bare uint8 with no enum in the ABI. Derived from live data across
// three syndicates: 2585 of one value, 297 of another, 95 of a third, which lines
// up with executed / open / cancelled respectively.
const MSIG_OPEN = 0
const MSIG_EXECUTED = 1
const MSIG_CANCELLED = 2

// A packed transaction begins with its header, and the header begins with a
// little-endian uint32 expiration. That is the only expiry a msig proposal has.
function msigExpiry(packed) {
    const hex = String(packed ?? '').slice(0, 8)
    if (hex.length < 8) return NaN
    const le = hex.match(/../g).reverse().join('')
    return parseInt(le, 16) * 1000
}

const msigTitle = (p) =>
    (p.metadata ?? []).find((m) => m.key === 'title')?.value ||
    (p.metadata ?? []).find((m) => m.key === 'description')?.value ||
    p.proposal_name

const STATE_LABEL = { 0: 'open', 1: 'executed', 2: 'cancelled' }
const STATE_CLASS = { 0: 'open', 1: 'completed', 2: 'blocked' }

let detailsId = null
let candidatesCache = new Map()
let proposalsCache = new Map()
let propFilter = 'active'
let detailsTab = 'council'   // council & candidates, or proposals
let periodFormOpen = false   // the election-period proposal form
let pickedCandidates = new Set()
let pickedProposals = new Set()

const detailsEl = $('details')


const isExpired = (p) => msigExpiry(p.packed_transaction) < Date.now()

// Active is what is still open AND still inside its transaction expiry. An
// expired proposal can never execute, so it is not shown at all — not here and
// not with a warning pill.
//
// Expiry is only meaningful while a proposal is open: an executed one ran before
// its deadline, and every executed proposal is past that deadline by now, so
// applying the same test there would hide all of them.
function propMatches(p) {
    return propFilter === 'executed'
        ? p.state === MSIG_EXECUTED
        : p.state === MSIG_OPEN && !isExpired(p)
}

// Approving needs the signer to be one of the accounts the proposal asks for,
// which in practice is the seated council. Executing is open — but only once the
// approvals satisfy the requested permission and while the transaction is still
// inside its expiry.
const canApprove = (p, amCustodian) => amCustodian && p.state === MSIG_OPEN
const canExecute = (p) => p.state === MSIG_OPEN && !isExpired(p)

// ── Proposing a new election period ───────────────────────────────────────
//
// `dao.worlds::setperiodlen(periodlength, dac_id)` runs under the DAO OWNER's
// authority, not a custodian's, so a custodian cannot send it directly. It has
// to be raised as a multisig proposal for the council to approve.
//
// The bounds are the contract's own checks, from config.cpp:
//   periodlength >= 1 day
//   periodlength <= 6 months, where a month is 30 days
//   periodlength >= the DAO's pending period delay
const PERIOD_MIN_DAYS = 1
const PERIOD_MAX_DAYS = 180

const periodFloorDays = (dao) =>
    Math.max(PERIOD_MIN_DAYS, Math.ceil((dao.pendingPeriodDelay || 0) / 86400))

// A proposal name is an eosio name: twelve characters from a 32-symbol alphabet.
// Random rather than derived — two proposals raised in one DAO must not collide.
function proposalName() {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz12345'
    const bytes = new Uint8Array(12)
    crypto.getRandomValues(bytes)
    return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

async function actProposePeriod(dao, days) {
    const n = Math.round(Number(days))
    const floor = periodFloorDays(dao)
    if (!Number.isFinite(n) || n < floor || n > PERIOD_MAX_DAYS) {
        return detailsNote(`Pick a period between ${floor} and ${PERIOD_MAX_DAYS} days.`, 'error')
    }
    if (!dao.owner) return detailsNote('This DAO has no owner account registered.', 'error')

    const seconds = n * 86400
    const actor = String(session.actor)

    let inner
    try {
        const abi = await getAbi(dao.custodianContract)
        // The msig ABI types an action's arguments as `bytes`, so they go in
        // pre-serialized rather than as an object.
        const data = Serializer.encode({
            abi, type: 'setperiodlen',
            object: { periodlength: seconds, dac_id: dao.id },
        })
        inner = {
            account: dao.custodianContract,
            name: 'setperiodlen',
            authorization: [{ actor: dao.owner, permission: 'active' }],
            data: String(data),
        }
    } catch (err) {
        console.error('Could not encode setperiodlen:', err)
        return detailsNote(`Could not build the proposal: ${readableError(err)}`, 'error')
    }

    // Seven days to collect approvals, matching what this DAO's own proposals
    // use. ref_block_num and ref_block_prefix are zero on every live proposal:
    // msig.worlds dispatches the inner actions itself, so the proposed
    // transaction is never TAPOS-checked.
    const expiry = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 19)
    const current = dao.periodLength ? fmtDays(dao.periodLength) : 'unknown'

    return submitDetails([{
        account: MSIG_CONTRACT, name: 'propose', authorization: auth(),
        data: {
            proposer: actor,
            proposal_name: proposalName(),
            requested: [{ actor: dao.owner, permission: 'active' }],
            dac_id: dao.id,
            metadata: [
                { key: 'title', value: `Set election period to ${n} day${n === 1 ? '' : 's'}` },
                {
                    // Custodians read this in a voting UI, so it says what the
                    // proposal does and nothing else. The seconds, the contract
                    // name and who raised it are all recoverable from the
                    // transaction itself.
                    key: 'description',
                    value: `Change the election period for ${dao.title} from ${current} to ` +
                        `${n} day${n === 1 ? '' : 's'}`,
                },
            ],
            trx: {
                expiration: expiry,
                ref_block_num: 0,
                ref_block_prefix: 0,
                max_net_usage_words: 0,
                max_cpu_usage_ms: 0,
                delay_sec: 0,
                context_free_actions: [],
                actions: [inner],
                transaction_extensions: [],
            },
        },
    }], `Propose a ${n}-day election period`, () => refreshProposals(dao))
}

// An empty table with no explanation reads as a failed load, so the empty state
// has to say which kind of empty it is.
function emptyProposals(dao, props) {
    if (props === null) return 'Could not read proposals — the node did not answer.'
    if (!props) return 'Reading…'
    if (props.length === 0) return 'No multisig proposals have ever been raised here.'

    if (propFilter === 'executed') return `None of the ${props.length} most recent have executed.`

    // Saying how many were withheld matters: without it an empty tab looks like
    // a failed read rather than a DAO with nothing left to act on.
    const stale = props.filter((p) => p.state === MSIG_OPEN && isExpired(p)).length
    return stale
        ? `Nothing open to act on. ${stale} proposal${stale === 1 ? ' is' : 's are'} still open but ` +
          `past the expiry inside its transaction, so it can no longer execute — those are not listed.`
        : `Nothing open in the ${props.length} most recent.`
}

async function loadDetails(dao) {
    const jobs = []
    if (!candidatesCache.has(dao.id) && dao.custodianContract) {
        jobs.push(getRows(dao.custodianContract, dao.id, 'candidates', { limit: 500 })
            .then((rows) => candidatesCache.set(dao.id, rows))
            .catch((err) => { console.error('candidates:', err); candidatesCache.set(dao.id, null) }))
    }
    if (!proposalsCache.has(dao.id)) {
        // The PRIMARY key of `proposals` is `proposal_name`, which sorts
        // alphabetically — reading it in reverse returns the names closest to
        // "zzzz", not the newest rows. `index_position: 3` is the `id` index,
        // and id is a creation counter, so that one really is chronological.
        //
        // One page of it, newest first. Eyeke holds 3028 proposals; paging the
        // lot to fill a screen would be absurd, and anything still open and
        // unexpired was necessarily created recently.
        jobs.push(Promise.all([
            postRows(MSIG_CONTRACT, dao.id, 'proposals', {
                index_position: 3, key_type: 'i64', limit: 300, reverse: true,
            }),
            postRows(MSIG_CONTRACT, dao.id, 'approvals', { limit: 500 })
                .catch(() => []),
        ])
            .then(([rows, approvals]) => {
                const byName = new Map(approvals.map((a) => [a.proposal_name, a]))
                // Sorted here rather than trusted from the node: the filters below
                // preserve order, so this is the one place newest-first is set.
                proposalsCache.set(dao.id, rows
                    .map((p) => ({ ...p, approvals: byName.get(p.proposal_name) }))
                    .sort((a, b) => Number(b.id) - Number(a.id)))
            })
            .catch((err) => { console.error('proposals:', err); proposalsCache.set(dao.id, null) }))
    }
    if (jobs.length) {
        startPhase(jobs.length)
        await Promise.all(jobs)
        endPhase()
    }
}

async function openDetails(id) {
    detailsId = id
    detailsTab = 'council'
    periodFormOpen = false

    // Start from the slate already cast, so the boxes show what you voted for
    // rather than an empty list you have to reconstruct from memory. Re-casting
    // it unchanged is exactly a vote refresh; changing one box is an edit.
    pickedCandidates = new Set(votes.get(id)?.candidates ?? [])
    pickedProposals = new Set()
    closePanel()
    renderDetails()
    const dao = daoById(id)
    if (dao) {
        await loadDetails(dao)
        if (detailsId === id) renderDetails()
    }
}

function closeDetails() {
    detailsId = null
    detailsEl.hidden = true
    document.body.classList.remove('is-details')
}

function seatRow(dao, c, seat) {
    const power = Number(c.total_vote_power)
    const age = Date.parse(`${c.avg_vote_time_stamp}Z`)
    const risk = dao.atRisk?.has(c.cust_name)
    const place = dao.rankOf?.get(c.cust_name)
    return `
    <tr class="${risk ? 'is-risk' : ''}">
        <td class="num">${seat}</td>
        <td><a class="${WATCHED.has(c.cust_name) ? 'is-watched' : ''}"
               href="${EXPLORER}${encodeURIComponent(c.cust_name)}"
               target="_blank" rel="noopener">${esc(c.cust_name)}</a>
            ${risk ? `<span class="risk" title="Currently ranked ${place ?? '?'} of the standing candidates">
                at risk${place ? ` · ranked ${place}` : ''}</span>` : ''}</td>
        <td class="num">${esc(fmtPower(power, dao))}</td>
        <td class="num">${c.number_voters}</td>
        <td class="num">${Number.isFinite(age) ? esc(fmtAge(Date.now() - age)) : '—'}</td>
    </tr>`
}

// Vote power is a running sum of token balances, so it is denominated in this
// DAO's own token at that token's precision.
function fmtPower(raw, dao) {
    const n = Number(raw) / 10 ** dao.precision
    if (!Number.isFinite(n)) return '—'
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
    return n.toFixed(0)
}

// Wraps the build so a throw can never leave a full-screen overlay standing with
// nothing in it and no way out. Revealing happens AFTER the html exists.
function renderDetails() {
    if (!detailsId) return
    const dao = daoById(detailsId)
    if (!dao) return closeDetails()

    let html
    try {
        html = buildDetails(dao)
    } catch (err) {
        console.error('Could not render the details view:', err)
        html = `<div class="d-inner">
            <header class="d-head">
                <button class="btn btn-ghost" id="detailsBack" type="button">← All DAOs</button>
                <div class="d-title"><h2>${esc(dao.title)}</h2></div>
            </header>
            <p class="panel-note is-error">This view could not be drawn: ${esc(String(err.message ?? err))}</p>
        </div>`
    }

    detailsEl.innerHTML = html
    detailsEl.hidden = false
    document.body.classList.add('is-details')
    paintDetailsNote()
}

function buildDetails(dao) {
    const maxVotes = 2
    const vote = votes.get(dao.id)
    const votedAt = vote ? Date.parse(`${vote.vote_time_stamp}Z`) : NaN
    const seated = new Set(dao.custodians)
    const amCustodian = session && seated.has(String(session.actor))

    const cands = candidatesCache.get(dao.id)
    const props = proposalsCache.get(dao.id)

    // ── your vote
    const voteBlock = !session ? '' : `
        <section class="d-block">
            <h3>Your vote</h3>
            ${vote && vote.candidates?.length ? `
                <p class="d-line">
                    <b>${vote.candidates.map((c) => esc(c)).join(', ')}</b>
                    <span class="d-dim">· cast ${esc(fmtAge(Date.now() - votedAt))} ago
                        (${isoDay(votedAt)})</span>
                </p>
                <button class="act-go" id="reVote" type="button" ${busy ? 'disabled' : ''}>Refresh this vote</button>
            ` : `<p class="d-line d-dim">No vote cast in this DAO.</p>`}
        </section>`

    // ── candidates + voting
    const standing = (cands ?? [])
        .filter((c) => c.is_active)
        .sort((a, b) => Number(b.rank) - Number(a.rank))

    const candBlock = `
        <section class="d-block">
            <h3>Candidates
                <span class="d-dim">${cands === null ? 'unavailable'
                    : cands ? `${standing.length} standing` : 'reading…'}</span>
            </h3>
            ${session ? `<p class="d-line d-dim">Pick up to ${maxVotes}, then cast.
                <span id="pickCount">${pickedCandidates.size} selected</span></p>` : ''}
            <div class="d-scroll">
            <table class="d-table">
                <thead><tr>
                    ${session ? '<th></th>' : ''}
                    <th>Candidate</th><th class="num">Vote power</th>
                    <th class="num">Voters</th><th class="num">Vote age</th><th class="num">Seat</th>
                </tr></thead>
                <tbody>
                ${standing.map((c) => {
                    const seat = dao.custodians.indexOf(c.candidate_name)
                    const age = Date.parse(`${c.avg_vote_time_stamp}Z`)
                    const on = pickedCandidates.has(c.candidate_name)
                    return `<tr class="${on ? 'is-picked' : ''}">
                        ${session ? `<td><input type="checkbox" data-cand="${esc(c.candidate_name)}"
                             ${on ? 'checked' : ''}></td>` : ''}
                        <td><a class="${WATCHED.has(c.candidate_name) ? 'is-watched' : ''}"
                               href="${EXPLORER}${encodeURIComponent(c.candidate_name)}"
                               target="_blank" rel="noopener">${esc(c.candidate_name)}</a>
                            ${(dao.wouldSeat ?? []).includes(c.candidate_name) && seat < 0
                                ? '<span class="incoming" title="Ranked inside the seat count — would take a seat if a period ran now">incoming</span>'
                                : ''}</td>
                        <td class="num">${esc(fmtPower(c.total_vote_power, dao))}</td>
                        <td class="num">${c.number_voters}</td>
                        <td class="num">${Number.isFinite(age) ? esc(fmtAge(Date.now() - age)) : '—'}</td>
                        <td class="num">${seat >= 0 ? seat + 1 : ''}</td>
                    </tr>`
                }).join('') || `<tr><td colspan="6" class="d-dim">${
                    cands === null ? 'Could not read candidates.' : 'None standing.'}</td></tr>`}
                </tbody>
            </table>
            </div>
            ${session ? `<button class="act-go" id="castVote" type="button"
                ${busy || pickedCandidates.size === 0 ? 'disabled' : ''}>
                Cast vote${pickedCandidates.size ? ` for ${pickedCandidates.size}` : ''}</button>` : ''}
        </section>`

    // ── proposals
    //
    // Keyed by `proposal_name`. A msig proposal has no `proposal_id` — that was
    // the field on prop.worlds, and reading it here returned undefined for every
    // row, so `chosen` was always empty and both buttons stayed disabled however
    // many boxes were ticked. The tick itself worked, which is what made it look
    // like a button bug rather than a key mismatch.
    const shown = (props ?? []).filter(propMatches)
    const chosen = shown.filter((p) => pickedProposals.has(p.proposal_name))
    const approvable = chosen.filter((p) => canApprove(p, amCustodian))
    const runnable = chosen.filter(canExecute)
    // Anyone may select. Approving needs a seat on this council; executing needs
    // the proposal to be open and unexpired. Both are per row, so the buttons
    // count what the selection can actually do rather than assuming one rule.
    const canPick = !!session
    // Raising one is a custodian's job, and setperiodlen needs the owner's
    // authority — which is exactly what a proposal collects.
    const floorDays = periodFloorDays(dao)
    const startDays = Math.min(PERIOD_MAX_DAYS, Math.max(floorDays,
        Math.round((dao.periodLength ?? 7 * 86400) / 86400)))

    const proposeBlock = !amCustodian ? '' : `
        <div class="d-propose">
            ${periodFormOpen ? `
                <div class="d-propose-form">
                    <div class="act-head">
                        <span class="act-label">New election period</span>
                        <span class="act-hint">${esc(fmtDays(dao.periodLength ?? 0))} today ·
                            ${floorDays}–${PERIOD_MAX_DAYS} days allowed</span>
                    </div>
                    <div class="slider-row">
                        <input type="range" id="periodSlider" min="${floorDays}" max="${PERIOD_MAX_DAYS}"
                               step="1" value="${startDays}" ${busy ? 'disabled' : ''}>
                        <output id="periodOut">${startDays} days</output>
                    </div>
                    <p class="act-blurb">Creates a multisig proposal for
                        <code>${esc(dao.custodianContract)}::setperiodlen</code>, requesting approval from
                        <code>${esc(dao.owner ?? '—')}</code>. It takes effect only once the council
                        approves and someone executes it.</p>
                    <div class="d-actions">
                        <button class="act-go" id="periodSubmit" type="button" ${busy ? 'disabled' : ''}>
                            Create proposal</button>
                        <button class="act-mini" id="periodCancel" type="button">cancel</button>
                    </div>
                </div>
            ` : `
                <button class="card-btn" id="periodOpen" type="button">Propose a new election period</button>
            `}
        </div>`

    const propBlock = `
        <section class="d-block">
            <h3>Proposals
                <span class="d-dim">${props === null ? 'unavailable'
                    : props ? `${shown.length} of the ${props.length} most recent` : 'reading…'}</span>
            </h3>

            ${proposeBlock}

            <div class="d-filter">
                <span class="${propFilter === 'active' ? 'is-on' : ''}">Active</span>
                <button class="toggle ${propFilter === 'executed' ? 'is-right' : ''}"
                        id="propToggle" type="button" role="switch"
                        aria-checked="${propFilter === 'executed'}"><i></i></button>
                <span class="${propFilter === 'executed' ? 'is-on' : ''}">Executed</span>
            </div>

            ${session && shown.length && !amCustodian ? `
                <p class="d-line d-dim">Approving needs a seat on this council, which you do not hold here.
                Finalizing is open to anyone; starting work is the proposer's alone.</p>` : ''}

            <div class="d-scroll">
            <table class="d-table">
                <thead><tr>
                    ${canPick ? '<th></th>' : ''}
                    <th>Proposal</th><th>State</th><th class="num">Approvals</th><th class="num">Expires</th>
                </tr></thead>
                <tbody>
                ${shown.map((p) => {
                    const on = pickedProposals.has(p.proposal_name)
                    const exp = msigExpiry(p.packed_transaction)
                    const got = p.approvals?.provided_approvals?.length ?? 0
                    const want = p.approvals?.requested_approvals?.length ?? 0
                    const title = msigTitle(p)
                    return `<tr class="${on ? 'is-picked' : ''}">
                        ${canPick ? `<td><input type="checkbox" data-prop="${esc(p.proposal_name)}"
                             ${on ? 'checked' : ''}></td>` : ''}
                        <td>
                            <b>${esc(title.length > 90 ? `${title.slice(0, 90)}…` : title)}</b>
                            <span class="d-dim">${esc(p.proposal_name)} · by ${esc(p.proposer)}</span>
                        </td>
                        <td><span class="pill is-${STATE_CLASS[p.state] ?? 'open'}">${
                            esc(STATE_LABEL[p.state] ?? `state ${p.state}`)}</span></td>
                        <td class="num">${got}${want ? ` <span class="d-dim">/ ${want}</span>` : ''}</td>
                        <td class="num">${Number.isFinite(exp)
                            ? esc(isoDay(exp)) : '—'}</td>
                    </tr>`
                }).join('') || `<tr><td colspan="5" class="d-dim">${emptyProposals(dao, props)}</td></tr>`}
                </tbody>
            </table>
            </div>

            ${canPick && shown.length ? `
                <div class="d-actions">
                    <button class="act-go" id="approveProps" type="button"
                        ${busy || !approvable.length ? 'disabled' : ''}
                        title="voteprop — needs a seat on this council">
                        Approve ${approvable.length || ''}</button>
                    <button class="act-go" id="execProps" type="button"
                        ${busy || !runnable.length ? 'disabled' : ''}
                        title="finalize is open to anyone; startwork only to the proposal's own proposer">
                        Execute ${runnable.length || ''}</button>
                    <span class="d-dim">${chosen.length} selected · ${approvable.length} approvable · ${runnable.length} executable by you</span>
                </div>` : ''}
        </section>`

    const openProps = (props ?? []).filter((p) => p.state === MSIG_OPEN && !isExpired(p)).length
    const due = dao.nextElection

    return `
        <div class="d-inner">
            <header class="d-head">
                <button class="btn btn-ghost" id="detailsBack" type="button">← All DAOs</button>
                <div class="d-title">
                    <h2>${esc(dao.title)}</h2>
                    <p class="panel-sub">${esc(dao.id)} · ${esc(dao.symbol)} ·
                        ${dao.group === 'union' ? 'union' : 'syndicate'}</p>
                </div>
                ${due ? `<div class="d-clock">
                    <span class="d-clock-k">Next election</span>
                    <span class="election" data-due="${due}">${esc(fmtCountdown(due - Date.now()))}</span>
                </div>` : ''}
            </header>

            <!-- The council and its candidates are one job; the proposals are
                 another. Both at once is a wall, so only one is on screen. -->
            <div class="switch d-switch" role="tablist">
                <button class="switch-btn${detailsTab === 'council' ? ' is-on' : ''}"
                        data-tab="council" role="tab" type="button">
                    Council &amp; candidates <span class="count">${dao.council.length}</span>
                </button>
                <button class="switch-btn${detailsTab === 'proposals' ? ' is-on' : ''}"
                        data-tab="proposals" role="tab" type="button">
                    Proposals <span class="count">${props ? openProps : '…'}</span>
                </button>
            </div>

            <p class="panel-note" id="detailsNote" hidden></p>

            ${detailsTab === 'council' ? `
                ${voteBlock}
                <section class="d-block">
                    <h3>Council <span class="d-dim">${dao.council.length} seated</span></h3>
                    <table class="d-table">
                        <thead><tr><th class="num">#</th><th>Custodian</th>
                            <th class="num">Vote power</th><th class="num">Voters</th>
                            <th class="num">Vote age</th></tr></thead>
                        <tbody>${dao.council.map((c, i) => seatRow(dao, c, i + 1)).join('')}</tbody>
                    </table>
                </section>
                ${candBlock}
            ` : propBlock}
        </div>`
}

let detailsMessage = null
function detailsNote(text, kind = '') {
    detailsMessage = text ? { text, kind } : null
    paintDetailsNote()
}
function paintDetailsNote() {
    const el = $('detailsNote')
    if (!el) return
    el.textContent = detailsMessage?.text ?? ''
    el.className = `panel-note${detailsMessage?.kind ? ` is-${detailsMessage.kind}` : ''}`
    el.hidden = !detailsMessage
}

// Signing from the details view. Same discipline as the panel's submit: one
// lock, one error path, one re-read.
async function submitDetails(actions, describe, after) {
    if (!session || busy) return
    busy = true
    renderDetails()
    detailsNote(`${describe} — check your wallet…`, 'work')
    try {
        await session.transact({ actions }, { broadcast: true })
        detailsNote(`${describe} sent — re-reading…`, 'ok')
        await sleep(2500)
        if (after) await after()
        await loadPosition()
        detailsNote(`${describe} done.`, 'ok')
    } catch (err) {
        if (isUserCancel(err)) detailsNote('Cancelled.')
        else {
            console.error(`${describe} failed:`, err)
            detailsNote(readableError(err), 'error')
        }
    } finally {
        busy = false
        renderDetails()
    }
}

// The slider's label follows the thumb. Written straight into the output element
// rather than through a re-render: rebuilding the section on every pixel of drag
// would destroy the very input being dragged.
detailsEl.addEventListener('input', (e) => {
    if (e.target.id !== 'periodSlider') return
    const out = $('periodOut')
    const n = Number(e.target.value)
    if (out) out.textContent = `${n} day${n === 1 ? '' : 's'}`
})

detailsEl.addEventListener('change', (e) => {
    const dao = daoById(detailsId)
    if (!dao) return

    const cand = e.target.closest('[data-cand]')
    if (cand) {
        const name = cand.dataset.cand
        if (cand.checked) {
            // maxvotes is a hard limit in the contract; enforcing it here beats
            // letting the wallet pop up for a transaction that cannot succeed.
            if (pickedCandidates.size >= 2) {
                cand.checked = false
                detailsNote('You can vote for at most 2 candidates.', 'error')
                return
            }
            pickedCandidates.add(name)
        } else pickedCandidates.delete(name)
        renderDetails()
        return
    }

    const prop = e.target.closest('[data-prop]')
    if (prop) {
        if (prop.checked) pickedProposals.add(prop.dataset.prop)
        else pickedProposals.delete(prop.dataset.prop)
        renderDetails()
    }
})

detailsEl.addEventListener('click', async (e) => {
    // Leaving comes FIRST and depends on nothing. Behind the lookup below, a DAO
    // that failed to load would have left the back button dead.
    if (e.target.closest('#detailsBack')) return closeDetails()

    const dao = daoById(detailsId)
    if (!dao) return

    if (e.target.closest('#periodOpen'))   { periodFormOpen = true;  return renderDetails() }
    if (e.target.closest('#periodCancel')) { periodFormOpen = false; return renderDetails() }
    if (e.target.closest('#periodSubmit')) {
        return actProposePeriod(dao, $('periodSlider')?.value)
    }

    const tab = e.target.closest('[data-tab]')
    if (tab) {
        detailsTab = tab.dataset.tab
        return renderDetails()
    }

    if (e.target.closest('#propToggle')) {
        propFilter = propFilter === 'active' ? 'executed' : 'active'
        pickedProposals = new Set()
        return renderDetails()
    }

    if (e.target.closest('#reVote')) {
        const v = votes.get(dao.id)
        if (!v?.candidates?.length) return
        return submitDetails([voteAction(dao, v.candidates)], 'Refresh vote')
    }

    if (e.target.closest('#castVote')) {
        return submitDetails([voteAction(dao, [...pickedCandidates])],
            `Vote for ${[...pickedCandidates].join(', ')}`)
    }

    const approve = e.target.closest('#approveProps')
    const exec = e.target.closest('#execProps')
    if (!approve && !exec) return

    const props = proposalsCache.get(dao.id) ?? []
    const seated = new Set(dao.custodians)
    const amCustodian = !!session && seated.has(String(session.actor))
    const chosen = props.filter((p) => pickedProposals.has(p.proposal_name))
    if (!chosen.length) return

    // msig.worlds approves against a permission level, which is the signer's own
    // — the same one the transaction is authorised with.
    const level = { actor: String(session.actor), permission: session.permissionLevel.permission
        ? String(session.permissionLevel.permission) : 'active' }

    if (approve) {
        const votable = chosen.filter((p) => canApprove(p, amCustodian))
        if (!votable.length) {
            return detailsNote(
                'None of the selected proposals can be approved by this account — ' +
                'approving needs a seat on this council, and the proposal must still be open.', 'error')
        }
        const actions = votable.map((p) => ({
            account: MSIG_CONTRACT, name: 'approve', authorization: auth(),
            data: { proposal_name: p.proposal_name, level, dac_id: dao.id },
        }))
        return submitDetails(actions, `Approve ${votable.length} proposal${votable.length === 1 ? '' : 's'}`,
            () => refreshProposals(dao))
    }

    const runnable = chosen.filter(canExecute)
    if (!runnable.length) {
        return detailsNote(
            'None of the selected proposals can be executed — an executed, cancelled ' +
            'or expired proposal cannot run.', 'error')
    }
    const actions = runnable.map((p) => ({
        account: MSIG_CONTRACT, name: 'exec', authorization: auth(),
        data: { proposal_name: p.proposal_name, executer: String(session.actor), dac_id: dao.id },
    }))
    return submitDetails(actions, `Execute ${runnable.length} proposal${runnable.length === 1 ? '' : 's'}`,
        () => refreshProposals(dao))
})

async function refreshProposals(dao) {
    proposalsCache.delete(dao.id)
    pickedProposals = new Set()
    await loadDetails(dao)
}

// ── Events ────────────────────────────────────────────────────────────────

// Each card carries its own two buttons. The card itself is no longer a control:
// clicking one used to slide a rail in from the edge, so a stray click anywhere
// on a name or a figure moved the whole page.
daosEl.addEventListener('click', (e) => {
    const details = e.target.closest('[data-details]')
    if (details) return openDetails(details.dataset.details)

    const actions = e.target.closest('[data-actions]')
    if (actions) return openPanel(actions.dataset.actions)
})

// Re-reads everything without a page load, so a connected wallet survives it.
async function refreshAll() {
    const btn = $('refreshBtn')
    if (btn.disabled) return
    btn.disabled = true
    try {
        stakeConfigs = new Map()
        if (await pickEndpoint()) {
            await Promise.all([loadDaos(), loadSwapTargets()])
            await loadPosition()
        }
    } finally {
        btn.disabled = false
    }
}

$('refreshBtn').addEventListener('click', refreshAll)
$('refreshVotesBtn').addEventListener('click', refreshGroupVotes)

for (const [id, value] of [['tabSyndicates', 'syndicate'], ['tabUnions', 'union']]) {
    $(id).addEventListener('click', () => {
        group = value
        for (const btn of document.querySelectorAll('.switch-btn')) {
            const on = btn.id === id
            btn.classList.toggle('is-on', on)
            btn.setAttribute('aria-selected', String(on))
        }
        render()
    })
}

// ── Boot ──────────────────────────────────────────────────────────────────

setWalletChrome()

// One interval for every clock on the page. Started before the first read so a
// countdown painted by any render begins moving immediately.
setInterval(tickCountdowns, 1000)

// Named, so the retry button can run it again instead of asking for a reload.
async function boot() {
    if (!await pickEndpoint()) return

    // The councils do not depend on who you are, so the restore runs alongside
    // them rather than delaying the page behind a wallet.
    const restoring = restoreSession()
    const targets = loadSwapTargets()
    await loadDaos()
    await targets

    // The councils render as soon as they are read; if a session was restored
    // alongside them, the holdings land in a second pass rather than holding
    // the page back.
    await restoring
    await loadPosition()
}

boot()
