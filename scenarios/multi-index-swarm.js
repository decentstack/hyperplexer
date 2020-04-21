const HyperSim = require('hyper-simulator')
// const hypercore = require('hypercore')
const { defer } = require('deferinfer')

const { randomBytes } = require('crypto')
const { ReplicationManager } = require('..')
const Corestore = require('corestore')
/*
 * Topics represented as an integer between 0 and 5
 * Each robo-peer picks 3 interests by random from topics. (todo: expose pseudo-random via context)
 * 1. behaviours [ intitiator | lurker | replier ]
 *   a) Creates 'hello' posts in each topic of interests
 *   b) Replies to messages in topics of interest.
 *   c) Just reads and replicates
 * 2.
 * */
const N_TOPICS = 5
const N_PEERS = 20
const TOPIC = Buffer.from('DUMMYTOPIC')
const COMM_KEY = randomBytes(32)

class RoboPeer {
  onerr (err) {
    debugger
    this.ctx.signal('repl-error', err)
  }

  constructor (context, endFn) {
    this._endFn = endFn
    this.ctx = context
    this.onerr = this.onerr.bind(this)

    const { storage, random, signal } = context
    this.signal = signal
    this._db = {}
    this.initiator = true
    this.replier = true
    // const lurker = !(initiator && replier)

    this.subs = Array.from(new Array(3)).map(() =>
      Math.round(random() * N_TOPICS))

    this.store = new Corestore(storage, { valueEncoding: 'json' })
    this.rpl = new ReplicationManager(COMM_KEY, {
      onerror: this.onerr,
      onaccept: (c, a) => this._onaccept(c, a),
      resolve: (c, r) => this._resolve(c, r),
      onconnect: peer => this._offerFeeds(peer).catch(this.onerr),
      onforward: (ns, key, peers) => peers.forEach(p => this._offerFeeds(p, key).catch(this.onerr))
      // ondisconnect: (err, conn) => { debugger },
    })
  }

  async _offerFeeds (peer, key = null) {
    const manifest = []
    // corestore really is a bad combo for ReplicationManager
    for (const feed of this.store._externalCores.values()) {
      if (key && !key.equals(feed.key)) return

      const headers = await this._indexHeaders(feed)
      manifest.push({
        key: feed.key,
        headers
      })
    }
    this.rpl.share(peer, manifest)
  }

  _onaccept ({ key, headers, peer }, accept) {
    const agg = Object.values(headers).reduce((agg, t) => {
      agg[t] = agg[t] || 0
      agg[t]++
      return agg
    }, {})
    const eoi = this.subs.reduce((i, t) => i + (agg[t] ? agg[t] : 0), 0)
    accept(!!eoi)
    // Here we get an issue with low-quality connections where two peers
    // with completley different interests stay connected.
    // I've found similar behaviour in the plain hypercore-swarm scenario
    // where peers choke themselves with low-quality links.
    // Swarm performance can be improved by:
    // - Drop links with low or no activity
    //    - Idle timeout after block exchange completed (complicated...)
    //    - No subscription overlap thus idle since start.
    // - Seek to replace low linkrate connections with higher rates when activity is high.
    // How does bittorrent clients handle this? Is there a linkquality seeking algorithm?
    // I imagine that as a user i'd like to tell the replication manager to maintain 50 healthy connections. and that's it.
    // A healthy connection is one that is:
    // - not a Lose-lose connection
    // - lose-win is lo-prio
    // - win-lose is hi-prio
    // - win-win is highest prio
    //
    // Variables: linkRate, idleTime, uploadedBytes, downloadedBytes, age?
    if (eoi) this.signal('yep', eoi)
    else this.signal('nop', eoi)
  }

  async _indexHeaders (feed) {
    this._db[feed.key.toString()] = this._db[feed.key.toString()] || {}
    const db = this._db[feed.key.toString()]
    for (let i = 0; i < feed.length; i++) {
      if (!feed.has(i)) continue
      const entry = await defer(done => feed.get(i, done))
        .catch(this.onerr)
      db['i' + i] = entry.topic
    }
    return db
  }

  _resolve ({ key, create }, resolve) {
    const feed = this.store.get({ key })
    this.signal('resolve')
    feed.on('download', idx => {
      const ptr = [feed.key.toString('hex'), idx].join('@')
      this.signal('download', { ptr })

      // Post a reply within 10 random simulator seconds.
      this.ctx.timeout(this.ctx.random() * 10 * 1000)
        .then(() => {
          this._postReplyTo(feed, idx)
        })
        .catch(this.onerr)
    })
    feed.ready(() => resolve(feed))
  }

  _postReplyTo (feed, idx) {
    if (this.ended) return
    const ptr = [feed.key.toString('hex'), idx].join('@')
    if (feed.key.equals(this.writer.key)) debugger
    feed.get(idx, (err, { topic, depth }) => {
      if (err) return this.onerr(err)

      if (this.subs.indexOf(topic) === -1) return
      if (depth > 10) this.end()

      const bulkBloat = randomBytes(16 << 10) // 16KiB
      const reply = {
        topic,
        depth: depth + 1,
        message: 'reply',
        replyTo: ptr,
        bulkBloat
      }
      this.writer.append(reply, err => {
        if (err) this.onerr(err)
        else this.signal('reply', { topic, depth })
      })
    })
  }

  end () {
    this._endFn()
    this._endFn = null
  }

  get ended () {
    return !this._endFn
  }

  // This is a.k.a. ready()
  async populateContent () {
    await defer(done => this.store.ready(done))
    this.writer = this.store.default()

    this.writer.on('upload', idx => this.signal('upload', idx))

    await defer(done => this.writer.ready(done))
    if (this.initiator) {
      for (const s of this.subs) {
        await defer(done => this.writer.append({ topic: s, depth: 0, message: 'hello' }, done))
          .catch(this.onerr)
      }
    }
  }

  setupSwarm () {
    this.ctx.swarm.join(TOPIC)
    this.ctx.swarm.on('connection', (socket, details) => {
      // TODO: where's the live flag??
      this.rpl.handleConnection(!!details.client, socket)
    })
  }
}

try {
  const simulator = new HyperSim({
    // logger: HyperSim.TermMachine()
    // logger: () => {}
  })

  simulator.ready(() => {
    // Launch some leeches
    for (let i = 0; i < N_PEERS; i++) {
      const linkRate = (() => {
        switch (i % 3) {
          case 0: return 2048 << 8
          case 1: return 1024 << 8
          case 2: return 512 << 8
        }
      })()

      simulator.launch('peer', { linkRate }, (c, e) => {
        const peer = new RoboPeer(c, e)
        peer.populateContent()
        peer.setupSwarm()
      })
    }

    // Watch the data be replicated.
    simulator.run(3, 100)
      .then(() => console.error('Simulation finished'))
      .catch(err => console.error('Simulation failed', err))
  })
} catch (e) {
  console.error('Simulation failed', e)
}
