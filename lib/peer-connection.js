const assert = require('assert')
const Protocol = require('hypercore-protocol')
const eos = require('end-of-stream')
// const pump = require('pump')
const debugFactory = require('debug')
const { defer, infer } = require('deferinfer')
const { assertCore, fastHash } = require('./util')
// const substream = require('hypercore-substream')
const ph = require('pretty-hash')
const codecs = require('codecs')
// const NanoQueue = require('nanoqueue')
const CoreExchangeExtension = require('exchange-protocol')

const {
  STATE_INIT,
  STATE_ACTIVE,
  STATE_DEAD,
  PROTOCOL_VERSION,
  EXCHANGE_TIMEOUT
} = require('./constants')

class PeerConnection {
  constructor (initiator, exchangeKey, opts = {}) {
    assert(typeof initiator === 'boolean', 'First argument `initiator` must be a boolean!')
    assert(typeof exchangeKey === 'string' || Buffer.isBuffer(exchangeKey), 'Second arg `exchangeKey` must be a string or buffer')
    this._id = Buffer.from(Array.from(new Array(6)).map(() => Math.floor(256 * Math.random())))
    this.initiator = initiator
    this.state = STATE_INIT
    this.opts = opts || {}

    this.useVirtual = !!opts.useVirtual && false // Disabled for now.
    this.activeVirtual = []
    this._extensions = {}
    this.pendingReplications = {}

    // Lift off handlers from options.
    this.handlers = {
      onmanifest: opts.onmanifest,
      onrequest: opts.onrequest,
      onstatechange: opts.onstatechange,
      onreplicating: opts.onreplicating,
      onopen: opts.onopen,
      onclose: opts.onclose,
      onextension: opts.onextension,
      onauthenticate: opts.onauthenticate
    }
    delete opts.onmanifest
    delete opts.onrequest
    delete opts.onstatechange
    delete opts.onreplicating
    delete opts.onopen
    delete opts.onclose
    delete opts.onextension
    delete opts.onauthenticate

    // Initialize stats
    this.stats = {
      snapshotsSent: 0,
      snapshotsRecv: 0,
      requestsSent: 0,
      requestsRecv: 0,
      channelsOpened: 0,
      channelsClosed: 0
    }

    // Normalize exchange key
    if (typeof exchangeKey === 'string') exchangeKey = Buffer.from(exchangeKey, 'hex')
    this.exchangeKey = exchangeKey

    // Initialize individual debug handle
    this.debug = debugFactory(`decentstack/repl/${this.shortid}`)

    // Pre-bind kill
    this.kill = this.kill.bind(this)

    // Create stream
    this.stream = new Protocol(initiator, {
      onhandshake: this._onHandshake.bind(this),
      ondiscoverykey: this._onChannelOpened.bind(this),
      onchannelclose: this._onChannelClosed.bind(this),
      onauthenticate: this.handlers.onauthenticate
    })

    // Register end-of-stream handler
    eos(this.stream, err => this.kill(err, true))
    // listening for 'error' should be done by eos, is eos compatible with streamx?
    this.stream.once('error', err => this.kill(err))

    // Register the core-exchange protocol
    this.exchangeExt = CoreExchangeExtension(this, {
      onmanifest: (snapshot, accept, peer) => {
        this.stats.snapshotsRecv++
        this.debug(`Received manifest #${snapshot.id}`)
        // Forward upwards
        if (typeof this.handlers.onmanifest === 'function') {
          this.handlers.onmanifest(snapshot, accept, this)
        }
      },
      onrequest: (req, peer) => {
        peer.debug(`Received replication request for ${req.keys.length} feeds`)
        // Don't forward the hypercore-protocol-stream, forward this connection.
        // Actualy peer === PeerConnection in this scenario.
        // Forward upward
        if (typeof this.handlers.onrequest === 'function') {
          this.handlers.onrequest(req, peer)
        }
      }
    })

    // Versioncheck part #1, TODO: clean up! it's effective but not pretty.
    let resolveRemoteVersion = null
    const remoteVersionPromise = defer(d => { resolveRemoteVersion = d })

    // Create the channel that we're going to use for exchange signaling.
    this.exchangeChannel = this.stream.open(this.exchangeKey, {
      onextension: this._onExtension.bind(this),
      onoptions: (opts) => {
        // Hack, remote version is packed into first element of extensions array
        resolveRemoteVersion(null, opts.extensions.shift())
      },
      onopen: async () => {
        this.debug('Exchange Channel opened', ph(this.exchangeKey))
        if (!this.stream.remoteVerified(this.exchangeKey)) throw new Error('open and unverified')
        this.exchangeChannel.options({
          extensions: [PROTOCOL_VERSION]
        })

        // TODO: versioncheck part #2
        const [lNameVer] = PROTOCOL_VERSION.split('.')
        const remoteVersion = await remoteVersionPromise
        const [rNameVer] = remoteVersion.split('.')
        if (lNameVer !== rNameVer) {
          this.kill(new Error(`Version mismatch! local: ${PROTOCOL_VERSION}, remote: ${remoteVersion}`))
        } else {
          this._transition(STATE_ACTIVE)
        }
      },
      onclose: () => {
        this.debug('Exchange Channel closed')
      }
    })

    this.debug(`Initializing new PeerConnection(${this.initiator}) extensions:`, Object.values(this._extensions).map(i => i.name))
  }

  get id () {
    return this._id
  }

  get shortid () {
    return this._id.hexSlice(0, 4)
  }

  /*
   * this is our errorHandler + peer-cleanup
   * calling it without an error implies a natural disconnection.
   */
  kill (err = null, eosDetected = false) {
    this.debug(`kill invoked, by eos: ${eosDetected}, error:`, err)
    // Report other post-mortem on console as the manager
    // will already have removed it's listeners from this connection,
    // logging is better than silent failure
    if (this.state === STATE_DEAD) {
      if (err) console.warning('Warning kill() invoked on dead peer-connection\n', this.shortid, err)
      return
    }

    const cleanup = () => {
      this.debug('cleanup:', err)
      this.exchangeChannel.close()
      // Save error for post mortem debugging
      this.lastError = err
      // Notify the manager that this PeerConnection died.
      this._transition(STATE_DEAD, err)
    }

    // If stream is alive, destroy it and wait for eos to invoke kill(err) again
    // this prevents some post-mortem error reports.
    if (!this.stream.destroyed && !eosDetected) {
      if (err) {
        // Destroy with error
        this.stream.destroy(err)
      } else {
        this.end()
      }
    } else cleanup() // Perform cleanup now.
  }

  end () {
    // wait for stream to flush before cleanup
    this.debug('invoke end & schedule cleanup')
    for (const chan of this.activeChannels) {
      chan.close()
    }
  }

  registerExtension (name, handlers) {
    if (!handlers && typeof name.name === 'string') return this.registerExtension(name.name, name)

    // TODO: Handle scenarios where impl is a factory function
    // impl({name, send, broadcast, destroy})
    // Something still feels off with hypercore's extension handling, but
    // it's no longer an issue for us.

    const ext = {
      _id: fastHash(name),
      _codec: codecs(handlers.encoding),
      name
    }

    ext.send = message => {
      const buff = ext._codec ? ext._codec.encode(message) : message
      this.exchangeChannel.extension(ext._id, buff)
    }

    ext.broadcast = ext.send

    ext.destroy = () => {
      this.debug('Unregister extension', name, ext._id.toString(16))
      delete this._extensions[ext._id]
    }

    if (typeof handlers === 'function') {
      ext.handlers = handlers(ext)
    } else {
      ext.handlers = handlers
    }

    this._extensions[ext._id] = ext
    this.debug('Register extension', name, ext._id.toString(16))
    return ext
  }

  sendManifest (namespace, manifest, cb) {
    const mid = this.exchangeExt.sendManifest(namespace, manifest, cb)
    this.stats.snapshotsSent++
    this.debug(`manifest#${mid} sent with ${manifest.keys.length} keys`)
  }

  sendRequest (namespace, keys, manifestId) {
    this.exchangeExt.sendRequest(namespace, keys, manifestId)
    this.debug(`Replication request sent for mid#${manifestId} with ${keys.length} keys`)
    this.stats.requestsSent++
  }

  get activeChannels () {
    return [...this.activeVirtual, ...this.stream.channelizer.local.filter(c => !!c)]
  }

  get activeKeys () {
    return this.activeChannels.map(f => f.key.hexSlice())
  }

  isActive (key) {
    if (typeof key === 'string') key = Buffer.from(key, 'hex')
    assert(Buffer.isBuffer(key), 'Key must be a string or a buffer')
    return !!this.activeChannels.find(f => f.key.equals(key))
  }

  // --------- internal api

  _onExtension (id, message) {
    const ext = this._extensions[id]

    // bubble the message if it's not registered on this peer connection.
    if (typeof ext === 'undefined') {
      if (typeof this.handlers.onextension === 'function') {
        this.handlers.onextension(id, message, this)
      }
      return // Do not process further
    }

    if (ext._codec) message = ext._codec.decode(message)
    ext.handlers.onmessage(message, this)
  }

  _onChannelOpened (discoveryKey) {
    // console.log('_onChannelOpened', arguments)
    this.debug('remote replicates discKey', ph(discoveryKey))
    if (this.state === STATE_INIT) {
      const verified = this.stream.remoteVerified(discoveryKey)
      if (!verified) return this.kill(new Error('Remote uses a different exchangeKey'))
    }
  }

  _onChannelClosed (dk, pk) {
    this.stats.channelsClosed++
    const signalDone = this.pendingReplications[pk.toString()]
    if (typeof signalDone === 'function') signalDone()
    else if (!this.exchangeKey.equals(pk)) console.warn('Failed to free up slot for channel', dk, pk)

    this._c = this._c || 0
    this.debug('closing channel', ++this._c, ph(dk), pk && ph(pk))

    // If opts.live is not set, then we only do one single exchange roundtrip
    // and attempt to close the PeerConnection as soon as initial feeds have
    // been replicated.
    if (!this.opts.live) {
      const localExchanged = this.stats.snapshotsRecv && this.stats.requestsSent
      const remoteExchanged = this.stats.snapshotsSent && this.stats.requestsRecv
      const isLast = !this.activeChannels.filter(c => {
        return c && !dk.equals(c.discoveryKey) && !this.exchangeKey.equals(c.key)
      }).length

      if (localExchanged && remoteExchanged) this.exchangeChannel.close()
      else if (isLast) {
        // If we're last, setup a timed trigger to close the connection anyway.
        // there's no guarantee that the remote going to offer us anything.
        setTimeout(() => {
          // TODO: avoid closing exchange channel in mid-communication.
          // Close the exchange channel
          this.debug('post-close timeout triggered')
          this.exchangeChannel.close()
        }, EXCHANGE_TIMEOUT) // maybe use a different timeout here.
      }
    }
  }

  _onHandshake () {
    this.debug('Handshake received')
    // Currently there's nothing to do at this stage.
  }

  _transition (newState, err = null) {
    // We only have 3 states, and none of the transitions
    // loop back on themselves
    if (newState === this.state) return console.warn('Connection already in state', newState, err)

    const prevState = this.state
    this.state = newState

    if (typeof this.handlers.onstatechange === 'function') {
      this.handlers.onstatechange(newState, prevState, err, this)
    } else if (err) {
      // Log error if no 'state-change' listeners available to handle it.
      console.error('PeerConnection received error during `state-change` event, but no there are no registered handlers for it!\n', err)
    }

    switch (this.state) {
      case STATE_DEAD:
        if (typeof this.handlers.onclose === 'function') {
          this.handlers.onclose(err, this)
        }
        break
      case STATE_ACTIVE:
        if (typeof this.handlers.onopen === 'function') {
          this.handlers.onopen(this)
        }
        break
    }
  }

  // Expects feeds to be 'ready' when invoked
  replicateCore (feed, callback) {
    assertCore(feed)
    const p = defer(done => {
      this._joinCore(feed, (err, stream) => {
        if (err && err.type !== 'AlreadyActive') this.kill(err)

        if (err) done(err)
        else this.pendingReplications[feed.key.toString()] = done
      })
    })

    return infer(p, callback)
  }

  _joinCore (feed, cb) {
    if (this.isActive(feed.key)) {
      // TODO: False positive when joining feed who's key equals this.exchangeKey
      // maybe always prefix exchangeKeys to avoid channel-collisions.
      // either that or track feed activity on exchangeChannel which is worse imho.
      const err = new Error(`Feed ${ph(feed.key)} is already being replicated`)
      err.type = 'AlreadyActive'
      return cb(err)
    }
    this.stats.channelsOpened++

    // -- deleted substream code here --

    // non virt-stream
    const stream = this.stream

    feed.replicate(this.initiator, { stream })
    this.debug('replicating feed:', ph(feed.discoveryKey), ph(feed.key))
    // notify manager that a new feed is replicated here,
    // The manager will forward this event to other connections that not
    // yet have this feed listed in their knownFeeds
    if (typeof this.handlers.onreplicating === 'function') {
      this.handlers.onreplicating(feed.key, this)
    }

    return cb(null, stream)
  }
}

module.exports = PeerConnection
