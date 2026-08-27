# DAO Master

A front end for the [Alien Worlds](https://github.com/Alien-Worlds) DAO contracts
on WAX.

**Live:** <https://foxbaguette.github.io/daomaster/>

Not affiliated with Alien Worlds. Everything on the page is read from public
chain data.

**Stage 1** — every DAO and the custodians currently
seated on it, with a switch between syndicates and unions, and — for whoever
connects a wallet — what they hold in each.

```
website/index.html   markup
website/app.js       chain reads and rendering
website/styles.css   the look
website/serve.ps1    local dev server
```

## Running it

```powershell
powershell -ExecutionPolicy Bypass -File "website\serve.ps1"
```

then open <http://127.0.0.1:4440/>. It has to be served over `http://` — from
`file://` the page's origin is `null` and every WAX node refuses the CORS
preflight.

No build step, no dependencies. `app.js` is a plain ES module.

## Where the data comes from

Two tables:

| Read | Contract | Table | Scope |
| --- | --- | --- | --- |
| The directory | `index.worlds` | `dacs` | `index.worlds` |
| The seated council | the DAO's custodian contract | `custodians1` | the DAO id |

The custodian contract is **not** hardcoded. Each directory row carries an
`accounts` map keyed by `dacdir::account_type`, and type `2` is `CUSTODIAN`.
Today every DAO points at `dao.worlds`, but the directory is what decides that,
so the page reads it per DAO instead of assuming.

Each DAO's council lives in a scope named after its `dac_id` — `eyeke`,
`velesunn`, `nerix` — which is why one deployed custodian contract can run
all fourteen registered elections without them seeing each other. Twelve of
those are shown on the page; see below.

## Syndicates vs unions

A DAO is a **union** if it has no `TREASURY` account (type `1`) in the directory,
and a **syndicate** if it does. That is a real functional difference the
contracts encode — syndicates hold a treasury, unions do not — rather than a
naming convention, and it agrees exactly with the titles: the same six rows are
the ones whose `title` ends in "Union".

Splits 6 / 6.

Test A and Test B are registered in the directory exactly like any other DAO —
treasury, refs, a seated council — so nothing in the data marks them as scratch.
They are hidden by the `HIDDEN` set in `app.js`, which is a curation choice and
therefore a list of ids rather than a rule.

## The DAO's own TLM

Each card shows what the DAO itself can spend, and the two groups keep it in
different places:

| Group | Account type | Example | Balance read from |
|---|---|---|---|
| Syndicate | `SPENDINGS` (11) | `eyeke.dac` | `alien.worlds` / `accounts` |
| Union | `PROP_FUNDS_SOURCE` (13) | `eyeke.wp.dac` | `alien.worlds` / `accounts` |

Reading `accounts[13] ?? accounts[11]` is not a guess at which one to prefer —
`dacdirectory_shared.hpp` says why the split exists, in its own comment on type
13:

> `PROP_FUNDS_SOURCE = 13` — Account to hold all the Proposal funds for
> spending only. This is to ensure that the union daos have spending access but
> the syndicates only have deposit access.

So type 13 is registered on the six unions and on nothing else, while type 11 —
"Account to hold all the spending allowance for the current period" — is the
syndicate's own. Both groups also carry `PROP_FUNDS` (12), which is the same
`*.wp.dac` account seen from the deposit side; a syndicate having a 12 is why
type 12 cannot be used to tell the groups apart, and why it is not the one read
here.

This is TLM, not the DAO token. Every DAO runs on its own `token.worlds` symbol
— `EYE`, `MAG`, `NERUNN` — and TLM sits beside that, on `alien.worlds`. Nothing
is subtracted from the balance: DAO-token staking happens in `token.worlds` and
does not touch it.

The read has its own guard rather than sitting inside the council's. A node that
will not serve one scope of `alien.worlds` has said nothing about whether the
council read worked, so a missing balance leaves the chip off one card instead of
reporting the whole card unavailable.

## Connecting a wallet

Optional, and top-right. [WharfKit](https://wharfkit.com) with the Anchor and
Cloud Wallet plugins; WharfKit's own picker chooses between them. Nothing on the
page is gated behind it and nothing signs a transaction yet — the session is
here so the actions that will need one have it.

WharfKit is ESM-only (no UMD build, no `window` global), which is why `app.js`
loads as a module and the bare specifiers resolve through the import map in
`index.html`. The `?external=` on each esm.sh URL keeps antelope/common/session
as a **single shared instance** — duplicate copies break `instanceof` checks at
runtime.

Signing follows reads: whichever node the probe settles on is pushed into the
kit with `setEndpoint`, so the wallet is not talking to some other node than the
page is.

Connected, the button shows the account. It opens a menu rather than logging
out on click — it is the control you press to check *who you are*, and one
misplaced click should not end the session. Logging out is a deliberate second
choice inside the menu, which also closes on outside-click and on Escape. A
stored session is restored on load in parallel with the DAO reads, so the page
never waits behind a wallet.

## Your holdings

Signed in, each DAO card gains a block for whatever the connected account holds
there — owned, staked, stake time, and any unstake in flight. **Every line is
dropped when it would read as a zero**, so a DAO you have nothing in shows
nothing at all, and the block disappears entirely rather than printing four
empty rows.

All four live on the DAO's own token contract, and — this is the trap — they are
scoped by **`dac_id`**, not by the token symbol:

| Table | Scope | Keyed by |
| --- | --- | --- |
| `accounts` | the holder | symbol |
| `stakes` | `dac_id` | account |
| `staketime` | `dac_id` | account |
| `unstakes` | `dac_id` | auto-id, plus a `byaccount` secondary index |
| `stakeconfig` | `dac_id` | singleton |

`get_table_by_scope` reports **zero scopes** for `stakes`, `unstakes`,
`staketime` and `stakeconfig` on `token.worlds`, which makes it look like DAO
token staking is unused. It is not — direct reads at `scope = dac_id` return
data. Do not conclude from the scope index that these tables are empty.

Two details that are easy to get wrong:

- **`unstakes` is keyed by an auto-incrementing id**, so one account's releases
  come from the `byaccount` secondary index — `index_position: 2`,
  `key_type: 'name'`, bounded to the actor. A primary-key read would need a full
  table scan.
- **`staketime` has no row until a delay is explicitly set**, and the contract
  then falls back to `stakeconfig.min_stake_time`. A missing row means *the
  minimum*, not zero. The page reads `stakeconfig` for exactly those DAOs — a
  stake with no delay row — and labels the value as the minimum in its tooltip.

Balances are one read per token contract, not one per DAO, since a holder's
`accounts` scope carries every symbol at once. The rest is three bounded reads
per DAO, run at the same concurrency as the councils.

Figures are shown per line and never summed. Whether an unstaking amount is
already reflected in the liquid balance is a contract detail this page does not
assert, so it prints what each table says and leaves it there.

Amounts are **truncated to whole tokens** — the fractional part is dropped, not
rounded — and the symbol is dropped with it, since the card a figure sits in is
already the DAO whose token it is. Each row carries the exact asset string in its
tooltip, so nothing is unrecoverable.

### Pacing, and why it is a correctness measure

Reads are spread across **every** healthy node, and no single node is asked for
more than three calls in any rolling three seconds.

That is not politeness. Leaning on one node does not reliably produce an HTTP
429 — it produces an empty `rows` array, which is **indistinguishable from
"nothing staked"** and renders as a holder having nothing at all. A silently
wrong page is worse than a slow one. This was not theoretical: during
development `wax.eosdac.io` returned empty for bounded `stakes` reads that four
other nodes answered correctly.

`acquireNode()` hands out the least-loaded node with room left in its window and
waits when every node is spent, so the aggregate rate is simply how many nodes
are up (ten nodes gives about ten reads a second). A failed read is retried on a
*different* node, up to `MAX_ATTEMPTS`.

Each node opens its window already holding its probe. The probe deliberately
bypasses the scheduler — it is one call to one named node, which is the whole
point of a probe — but it is still a call that node just served, so starting its
budget at zero would let the first burst put four on it inside the window.

A full signed-in load is around fifty paced reads, which takes seconds rather
than milliseconds, so there is a progress bar under the status line. It counts
requests, the same unit the scheduler meters.

## Acting on a DAO

Selecting a card opens a side panel that stays open while the grid behind stays
browsable — picking another card swaps its contents. Every action below signs;
each shape was read off the contracts **and** confirmed against a live mainnet
trace before being wired up.

| Action | Call | Input |
| --- | --- | --- |
| Stake | `token.worlds::stake(account, quantity)` | amount, up to what is free |
| Unstake | `token.worlds::unstake(account, quantity)` | amount, up to what is staked |
| Claim | `token.worlds::claimunstkes(account, token_symbol)` | none |
| Cancel | `token.worlds::cancel(unstake_id, token_symbol)` | the row's id |
| TLM to token | `alien.worlds::transfer` + `stake.worlds::stake` | TLM amount |
| Token to TLM | `token.worlds::transfer` to `stake.worlds` | token amount |

Things that are not obvious from the ABI:

- **`claimunstkes` moves no tokens.** It calls `get_liquid` purely for the side
  effect of erasing expired rows. The tokens never left the balance — the
  unstake row was only suppressing the liquid figure. That is why an account can
  show the same amount as both *not staked* and *claimable*.
- **Stake time can only be increased**, never reduced, while anything is staked
  or unstaking. Bounds come from that DAO's `stakeconfig`.
- **`planet_name` is not uniform.** Syndicates are addressed by their planet
  account (`eyeke.world`, from `plnts.worlds/planets`, matched on
  `dac_symbol`); unions by their `dac_id` (`kavianunn`, from
  `stake.worlds/stakedaos`). Both branches were confirmed on chain.
- **The TLM swap is one transaction of two actions.** The transfer alone would
  park TLM on `stake.worlds` with nothing to claim it.
- **Union tokens are `transfer_locked`.** They can only go back to
  `stake.worlds`, never to another account.
- **Amounts are truncated, never rounded**, when converted to the fixed-point
  string the chain wants — rounding up could ask to move more than is held.

After a transaction lands the page waits one block-ish and re-reads the
position, because an accepted transaction is not yet a readable row.

## The card, and getting from it to anything else

Each card carries its own **Details** and **Actions** buttons. The card itself is
not a control — it used to be, and a stray click anywhere on a name or a figure
slid a rail in from the edge of the page.

**Actions** opens a centred overlay that asks *which* action first and only then
shows that action's fields. Six forms stacked on one rail was the thing that felt
overwhelming. Actions that cannot run are still listed, greyed, with the reason
in place of the description — knowing an action exists and why it is unavailable
beats it silently vanishing.

**Details** opens the full page, which is itself split by a switch: the council
with its candidates, or the proposals. Both at once is a wall.

### The election clock

`lastperiodtime + periodlength`, from `dacglobals`, counted down beside the DAO
name. `newperiod` is permissionless but somebody still has to send it, so a due
date in the past means nobody has — that reads **pending** rather than counting
upward.

Seconds only appear inside the last hour. Above that they change nothing a reader
cares about and make every card twitch once a second. One interval repaints only
the clock text, never the card: a full re-render each second would throw away
scroll position, checkbox state and any half-typed amount.

### Pre-selected candidates

Opening a DAO's details seeds the candidate checkboxes with the slate already
cast, read from `votes`. Re-casting it unchanged is exactly a vote refresh;
changing one box is an edit. Starting from an empty list would mean
reconstructing your own vote from memory before you could adjust it.

## Proposing a new election period

A seated custodian gets a **Propose a new election period** button in the
proposals section, with a slider.

`dao.worlds::setperiodlen(periodlength, dac_id)` runs under `require_auth(dac.owner)`
— the DAO's owner account, *not* a custodian's. So a custodian cannot send it at
all. It has to be raised as a multisig proposal that the council then approves
and someone executes, which is exactly what the button builds.

Slider bounds are the contract's own checks from `config.cpp`:

| Check | Value |
| --- | --- |
| `periodlength >= days` | 1 day |
| `periodlength <= 6 * months` | 180 days (a month is 30 days there) |
| `periodlength >= pending_period_delay` | 0 on every DAO today, so no extra floor |

The proposal is built from the shape three live proposals actually use:

```
msig.worlds::propose(
  proposer      = the custodian, who signs
  requested     = [ <dao.owner>@active ]
  metadata      = [ title, description ]
  trx.actions   = [ setperiodlen, authorized by <dao.owner>@active ]
)
```

**`ref_block_num` and `ref_block_prefix` are zero**, matching every live
proposal — `msig.worlds` dispatches the inner actions itself, so the proposed
transaction is never TAPOS-checked. Expiry is seven days, the same window this
DAO's own proposals use.

The description reads exactly `Change the election period for Kavian from 180
days to 14 days` and stops there. Custodians read it in a voting UI; the seconds,
the contract name and who raised it are all recoverable from the transaction
itself and only get in the way.

**The inner action has to be serialized in the browser.** The msig ABI types it
as `bytes`, and `abi_json_to_bin` — which used to do this server-side — now
returns 404 or 410 on every endpoint in the list. `@wharfkit/antelope`'s
`Serializer` does it against the ABI fetched from the chain.

## At risk

A seated custodian is marked **at risk** when they would not be re-seated if a
period ran right now, and a standing candidate is marked **incoming** when they
would take a seat.

This is not a guess. `newperiod` walks the candidates table's `bydecayed` index
— which sorts on `UINT64_MAX - rank`, so ascending on it is descending by rank —
skips inactive candidates, requires `total_vote_power > 0`, and stops at
`numelected`. The page reads the head of that same index and compares it to
`custodians1`. `custodians1` holds exactly `numelected` rows once a period has
run, so the seat count is the seated count and no `dacglobals` read is needed.

Both reads are pinned to one node: split across a block boundary they can
disagree and invent an at-risk seat that does not exist.

The label is *at risk*, not *out* — the ranking moves every time anyone votes,
and a period may be days away. Red is otherwise only used for failures, which is
the right register: it is a warning about the DAO, not a property of the account.

**Why this happens is worth understanding.** `rank` is
`(log2(vote_power + 1) + avg_vote_time / SECONDS_TO_DOUBLE) * 10000` — the time
term is linear while the power term is logarithmic, so vote *recency* routinely
outweighs vote *size*. In Kavian right now `anyo.cabal` holds 57.41M vote power
and is ranked below `.p2bu.wam` on 115.1K, because one was last voted 362 days
ago and the other 32. That is also why refreshing a vote is worth doing at all.

## Details, voting and proposals

The panel's **details** button opens a full page for one DAO: its council, every
standing candidate, your vote, and its proposals. Full page rather than more
panel — candidates run to dozens and proposals carry paragraphs.

### Voting

`dao.worlds::votecust(voter, newvotes[], dac_id)`. Your slate lives in `votes`
scoped by dac_id. **Refreshing a vote is re-casting the same slate**: it rewrites
`vote_time_stamp`, which feeds each candidate's `avg_vote_time_stamp` and so
their `rank`. The candidate list does not change — only its age.

The group button above the grid does that for a whole tab in one transaction. It
is **only enabled when a vote row was read for every DAO in the group**: a
partial slate would silently leave out the DAOs whose votes could not be read,
so a failed read disables the button rather than shrinking it.

`maxvotes` is 2, enforced in the UI as well as the contract — better than a
wallet prompt for a transaction that cannot succeed.

### Proposals

**`msig.worlds`**, scoped by dac_id. These are the multisig proposals every DAO
actually runs, and there are thousands of them: eyeke 3028, magor 2012,
nerix 1994, veles 1504, naron 1400, kavian 932.

> **The trap.** `prop.worlds` is a *different* contract — worker proposals, and
> only unions have ever used it (74 completed across all six). It is registered
> at account type 6 for **every** DAO including syndicates, so "does this DAO
> have a proposals contract" is true everywhere and tells you nothing. Reading
> `prop.worlds` at a syndicate scope returns zero rows on every node. If the
> proposals list looks empty, check which contract is being read.

Reads are the **300 most recent, `reverse: true`** — one page, no paging. Open
proposals are recent by nature, and paging eyeke's 3028 rows to fill a screen
would be absurd.

`state` is a bare `uint8` with no enum in the ABI. Derived from live data across
three syndicates — 2585 of one value, 297 of another, 95 of a third:

| Value | Meaning |
| --- | --- |
| `0` | open |
| `1` | executed |
| `2` | cancelled |

**Expiry is not a field.** A msig proposal's only expiry is the one inside its
packed transaction: the header begins with a little-endian `uint32` expiration,
so it is the first four bytes of `packed_transaction`.

**Active means open, and expiry is shown rather than filtered on.** Across all
twelve DAOs exactly *one* open proposal is currently unexpired — filtering the
expired ones out would leave the tab empty and looking broken, so they are listed
with a red `expired` pill instead. They still cannot execute.

| Action | Call | Who |
| --- | --- | --- |
| Approve | `msig.worlds::approve(proposal_name, level, dac_id)` | signs with the signer's own permission level; in practice a seated custodian |
| Execute | `msig.worlds::exec(proposal_name, executer, dac_id)` | open, once the approvals satisfy the requested permission and the transaction has not expired |

The approvals column is `provided_approvals` over `requested_approvals`, joined
from the `approvals` table on `proposal_name`.

## Worker proposals

A third details tab, on the six **unions only**. Different system, different
contract: `prop.worlds` (`dacproposals`, in
[Alien-Worlds/eosdac-contracts](https://github.com/Alien-Worlds/eosdac-contracts)
under `contracts/dacproposals`). A msig proposal is a transaction the council
signs; a worker proposal is a **job** — someone offers to do work for a fee, the
council votes on whether it is worth doing, the worker does it, and the council
votes again on whether it was done. The money moves through `escrw.worlds`, not
through the proposal.

The directory registers `prop.worlds` as account type `PROPOSALS` (6) for
*every* DAO, which is misleading: only the unions use it, and all six syndicate
scopes hold zero rows. That registration is also what first sent this app looking
for the msig proposals in the wrong contract.

### The state machine

```
pendingappr ──votes──▶ apprvtes ──startwork──▶ inprogress
     │                                              │
     └── expiry ──▶ expired                    completework
                                                    ▼
completed ◀── finalize ── apprfinvtes ◀──votes── pendingfin
                               │                    │
                               └─── dispute ──▶ indispute
```

Two vote rounds, counted separately against different thresholds. `updpropvotes`
runs after every vote and moves the row into the matching `*vtes` state as soon
as its threshold is met, so the stored state already answers "is there enough" —
the tally only has to say by how much.

Config is a singleton per scope, identical on all six unions today:

| | |
| --- | --- |
| `proposal_threshold` | 3 — approvals before work may start |
| `finalize_threshold` | 2 — approvals before the escrow pays |
| `approval_duration` | 30 days to collect the first set |
| `min_proposal_duration` | 7 days from **creation** before anything can be finalized |
| `proposal_fee` | 120 TLM |

### The stored state lies in two ways, and both are visible on chain

**Expiry passes silently.** `expiry` is only acted on when someone next votes:
`updpropvotes` writes `expired` at that point and not before. Eleven of the
twelve non-completed proposals on chain read `pendingappr` or `apprvtes` while
being long past their window. The badge shows them as expired and says why on
hover.

This applies to the approval round **only**. `_voteprop` checks
`has_not_expired()` in the approval branch and not in the finalize branch, and
`finalize` never checks it at all — so a proposal waiting to be paid is not
stale however old its `expiry` looks.

**`apprvtes` and `apprfinvtes` are a verdict cached at the last vote.**
`count_votes` skips — and erases — votes from accounts no longer seated, so a
recount can fall back below the threshold without the row changing.
`eyekeunn/dngoggqgd` is exactly this: stored `apprfinvtes`, and not one of the
custodians who voted for it still holds a seat, so it recounts to 0 of 2.
`startwork` and `finalize` both recount before acting, so the recount governs;
the badge follows it and the tooltip explains the disagreement.

### Counting a vote

`count_votes` is ported faithfully. One approval is worth 1, plus 1 for each
custodian who delegated *this proposal* to that approver, plus 1 for each
custodian who has not voted here at all and has delegated this proposal's
*category* to them. No union has ever used delegation — every vote row on chain
is direct and none carries a `category_id` — but a tally that quietly ignored it
would be wrong the first time someone used it.

### Actions

Every one of these calls `assertValidMember` first, which wants the account
registered against the **latest** member terms in `token.worlds`, not merely
registered. That is read up front so a stale agreement is a sentence rather than
an unreadable wallet error.

| Action | Call | Who, and when |
| --- | --- | --- |
| Approve / deny | `voteprop(custodian, proposal_id, approve\|deny, dac_id)` | seated custodian, approval round, not expired |
| Accept / reject work | `votepropfin(custodian, proposal_id, approve\|deny, dac_id)` | seated custodian, finalize round |
| Agree to arbitrate | `arbagree(arbiter, proposal_id, dac_id)` | the named arbiter, approval round |
| Start work | `startwork(proposal_id, dac_id)` | the worker, once approvals are met **and** the arbiter has agreed |
| Mark complete | `completework(proposal_id, dac_id)` | the worker, from `inprogress` |
| Finalize and pay | `finalize(proposal_id, dac_id)` | **anyone** — no `require_auth` — once the finalize votes are met and the 7-day hold has passed |

A button whose preconditions are not met is still shown, disabled, with the
reason on its tooltip: a worker needs to be told it is one approval short, not
left guessing.

#### Voting needs a second authorization

`voteprop` and `votepropfin` are signed with **two** permission levels, not one:

```
["1x1ci.wam@active", "nar.unn.dac@one"]
```

The DAO's own account at its `one` permission, alongside the custodian's active.
Every voteprop and votepropfin in chain history carries both, and without the
second one the contract refuses for missing that permission. None of the other
five actions want it — history confirms each of those is the actor's `@active`
alone.

**It is not a second signer.** `one` is threshold 1 with each seated custodian's
`@active` at weight 1 (`dao.worlds` maintains it from the election), so the
custodian's own key satisfies it. Adding the level is the DAO saying "a custodian
asked for this"; the wallet still signs once.

Nothing in the published `dacproposals` source accounts for this — master's
`_voteprop` does `require_auth(custodian)` and nothing else, so the deployed
build is not that source. The chain is what this follows.

`arbagree` is included because `startwork` refuses without it, which makes the
arbiter's agreement a stage rather than a detail. Five of the 86 proposals on
chain have never had it.

Cancelling (`cancelprop`, `cancelwip`) and disputing (`dispute`) are **not**
here.

### Raising one

`createprop` takes the fee from a deposit balance `prop.worlds` keeps per
account, not from the transaction — and `receive` credits *any* transfer to the
contract regardless of memo. So raising a proposal from an account with no
deposit is two actions in one transaction: the transfer, then `createprop`.

Both preconditions are read before the form will submit:

- the proposer must be in `recwl` for that scope (presence only — the receiver's
  rating is not checked)
- the arbiter must be in `arbwhitelist` with `rating > 0`, so only those are
  offered

The arbiter's pay must be above zero. That is not a contract rule — nothing
checks it at creation — but `startwork` sends it to escrow as its own
`transfer`, and a transfer of zero is rejected, so a proposal created with
nothing for the arbiter can never start.

The pay token is taken from the config's own `proposal_fee` rather than assumed
to be TLM.

### The document, and uploading one

`content_hash` is a free string. Both an IPFS CID and a plain URL appear on chain
today, so the list makes either clickable — a CID through Alien Worlds' own
gateway, which is where [wps.alienops.io](https://wps.alienops.io) links every
document:

```
https://ipfs.alienworlds.io/ipfs/<cid>
```

The **Upload** button beside the field pins a file and fills the field with its
CID, against the same endpoint the WPS client uses:

```
POST https://api.alienworlds.io/workerproposal/upload
multipart/form-data, one part named "file"
→ { "result": { "name", "cid", "size", "allocations": [...] } }
```

It answers `Access-Control-Allow-Origin: *`, so it can be called straight from
the page. Two details worth keeping:

- **Do not set `Content-Type`.** The browser has to write it itself so it can
  attach the multipart boundary; naming it by hand produces a header with no
  boundary and the server cannot parse the body. (The WPS client passes
  `multipart/form-data` to axios, which discards it for exactly this reason.)
- **409 means already pinned**, and the CID is inside the message text — between
  `Qm` and ` is`. That is a success wearing an error's clothes, so it fills the
  field like any other. Re-uploading an identical file actually answers **200
  with the same CID** today, so this branch is unexercised; it is kept for parity
  with the WPS client, which handles it.

Nothing in the upload path re-renders. The form's fields are uncontrolled, and
rebuilding the section mid-upload would throw away whatever had been typed into
the other six — so the button's label and the CID are written straight into the
DOM.

## The watchlist

`WATCHED` in `app.js` is a hand-supplied set of accounts. Any custodian in it is
drawn in blue wherever it appears, and any DAO where they hold `CONTROL_THRESHOLD`
seats or more gets an **MC controlled** marker. Both are edited in one place:

```js
const WATCHED = new Set(['5thba.wam', '42lra.wam', 't1dbe.wam', 'fgaqa.c.wam', 'im24u.c.wam'])
const CONTROL_THRESHOLD = 3
```

Nothing on chain says these accounts are related — the marker means "this many
of the watched accounts hold seats here" and nothing more. It carries the count
it came from in its tooltip so the claim can be checked against the blue names
directly underneath it.

The rule runs over every DAO, so unions get the marker on the same terms as
syndicates. At 3 of 5 the current list marks **Naron, Neri, Veles** and
**Kavian Union, Neri Union, Veles Union**.

Blue is used for nothing else on the page, so a blue name is always a watched
account. The bullet beside each name is tinted along with the text, so the
highlight does not rely on telling two hues apart.

## Council order

`custodians1` carries both `total_vote_power` and `rank`, and the contract seats
candidates off its `bydecayed` index, which orders by `rank`:

```
rank = (log2(vote_power + 1) + avg_vote_time / SECONDS_TO_DOUBLE) * 10000
```

— an index blending how much support a candidate has with how recently it was
given. It disagrees with raw vote power on most councils, so the page sorts by
`rank`. Leaving the rows in the primary-key order the node returns would print a
council in an order the chain does not use.

## Notes

- **`dac_state` is `0` on every row**, including the live planets, so it is not a
  usable "active" flag and nothing on the page renders one.
- **The endpoint list** is carried over from Very Serious Space War, where each
  node was verified *from a browser* with the exact request this app makes.
  Several nodes answer a `curl` GET fine and still fail the browser's OPTIONS
  preflight; see the comment above `ENDPOINTS` before adding one.

## Not here yet

Login, and everything that needs it: voting, candidacy, proposals, the msig
flow. Also pending custodians (`pendingcusts` — the council that takes over at
the next period), full candidate lists, and proxies.
