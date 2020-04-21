// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Decentstack - Replication Manager
 * @module @decentstack/replication-manager
 */
const assert = require('assert')
const PeerConnection = require('./lib/peer-connection')
const { defer, infer } = require('deferinfer')
const debug = require('debug')('decentstack/repl/mgr')
const {
  STATE_ACTIVE,
  STATE_DEAD
} = require('./lib/constants')

/** Class ReplicationManager */
class ReplicationManager {
  /**
   * Creates an instance
   * @param {Buffer} rpcChannelKey - Encryption key for the RPC communication channel.
   *
   * // Handlers
   * @param handlers {Object} - Event handlers
   * @param handlers {Object} - handlers object that allows you to control and interact with the manager.
   * @param handlers.onshare {function} - Control what you share. Invoked for each feed before manifest is sent to a peer.
   * @param handlers.onaccept {function} - Control what you accept. Invoked when receiving a manifest from a peer
   * @param handlers.onauthenticate {function} - Signal-handshake authentication handler, control which peers to communicate with.
   * @param handlers.onconnect {function} - Invoked when a new peer connection is established.
   * @param handlers.ondisconnect {function} - Invoked when a peer connection is dropped
   * @param handlers.onforward {function} - Invoked when new feed has unware peer candidates
   * @param handlers.resolve {function} - Invoked when a key needs to be resolved to a feed.
   * // Misc handlers
   * @param handlers.onerror {function} - Handler for errors that occur on remotely initiated actions
   *
   * // Options
   * @param opts {Object} - Options
   * @param opts.noforward - set to true to prevent automatic sharing of remotely discovered feeds to other connected peers
   * @param opts.live - set to true to keep connection open. (should be default?)
   */
  constructor (rpcChannelKey, handlers = {}, opts) {
    this.protocolOpts = opts || {}
    this.rpcChannelKey = rpcChannelKey
    /*
    this.queue = new NanoQueue(opts.activeLimit || 50, {
      process: this._processQueue.bind(this),
      oncomplete: () => this.debug('ReplicationQueue flushed')
    })
    */
    this.handlers = {
      // Replication control
      // onshare: handlers.onshare || (() => true),
      onaccept: handlers.onaccept || ((_, c) => c(true)),
      onforward: handlers.onforward,
      // Peer control
      onauthenticate: handlers.onauthenticate,
      onconnect: handlers.onconnect,
      ondisconnect: handlers.ondisconnect,
      // Store handlers
      resolve: handlers.resolve,
      // Misc
      onerror: handlers.onerror || ((error, peer) => console.error('RemoteError caused by peer:', error, peer))
      // Not implemented / prototypes
      // onfeedstart
      // onfeeddone
    }
    this.peers = []
    this._extensions = {}
    this._resourceCache = {}
    this._onPeerStateChanged = this._onPeerStateChanged.bind(this)
    this._onManifestReceived = this._onManifestReceived.bind(this)
    this._onReplicateRequest = this._onReplicateRequest.bind(this)
    this._closed = false
    this._closing = false
    // this._onFeedReplicated = this._onFeedReplicated.bind(this)
    // this._onUnhandeledExtension = this._onUnhandeledExtension.bind(this)
    this.stats = { started: 0, done: 0 }
  }

  /**
   * handleConnection is an higher-level alternative to replicate()
   * Except it returns the PeerConnection instance instead of just the hyper-protocol stream.
   * @param initiator {boolean} - 1: Initiationg connection, 0: Receiving connection
   * @param stream {Stream} - An optional nodejs or hypercore-protocol stream.
   * @param opts {Object} - override peer or hpercore-protocol options for this connection.
   */
  handleConnection (initiator, stream, opts = {}) {
    if (this._closed) throw new Error('Closed')
    assert(typeof initiator === 'boolean', 'Initiator must be a boolean')
    if (stream && typeof stream.pipe !== 'function') return this.handleConnection(initiator, null, stream)
    const conn = this._newExchangeStream(initiator, opts)
    stream = stream || opts.stream
    if (stream) stream.pipe(conn.stream).pipe(stream)
    return conn
  }

  /**
   * Support for standard replicate() api. see @hypercore#replicate()
   * @param initiator {boolean} - 1: Initiationg connection, 0: Receiving connection
   * @param opts {Object} - override peer or hpercore-protocol options for this connection.
   */
  replicate (initiator, opts = {}) {
    assert(typeof initiator === 'boolean', 'Initiator must be a boolean')
    return this.handleConnection(initiator, opts).stream
  }

  /** Starts an key exchange conversation
   * @param peer {PeerConnection} - Active peer
   * @param feeds {Array} - List of feeds where each item in list has the following
   * structure: `{ key: Buffer<FeedKey/ID>, headers: { somekey: 'somevalue' } }`
   * @param opts.namespace {string} - Namespace to advertise, defaults to 'default', use this
   * to not get your cores mixed up when using multiple stores.
   * @param opts.ondone {function} - Optional callback function (error, selectedFeeds) {}
   */
  share (peer, feeds, opts = {}) {
    const namespace = opts.namespace || 'default'
    const reqTime = (new Date()).getTime()

    const cb = (err, selectedFeeds) => {
      // Getting requests for all automatically sent manifests is not
      // mandatory in this stage, we're only using this callback for local statistics.
      if (err && err.type !== 'ManifestResponseTimedOutError') return peer.kill(err)
      else if (!err) {
        const resTime = (new Date()).getTime() - reqTime
        debug(`Remote response (${resTime}ms)`)
      } else {
        console.warn('Remote ignored our manifest')
      }
      if (typeof opts.ondone === 'function') opts.ondone(err, selectedFeeds)
    }
    peer.sendManifest(namespace, feeds, cb)
  }

  get closed () { return this._closed }

  close (cb) {
    this._closing = true
    this._closed = true
    // disconnect all peers
    for (const peer of this.peers) peer.kill()

    // release all open feeds
    const p = Promise.all(
      Object.values(this._resourceCache)
        .map(feed => defer(d => feed.close(d)))
    )
      .then(() => { this._closing = false })

    return infer(p, cb)
  }

  // Create an exchange stream
  _newExchangeStream (initiator, opts = {}) {
    const mergedOpts = Object.assign(
      {},
      this.protocolOpts, // Global live flag.

      opts, // Local overrides

      // Handlers
      {
        onmanifest: this._onManifestReceived,
        onrequest: this._onReplicateRequest,
        onstatechange: this._onPeerStateChanged,
        // onreplicating: (...args) => this._emit('onreplicating', peer, ...args),
        onextension: this._onUnhandeledExtension,
        onauthenticate: this.handlers.onauthenticate ? (...auth) => this._emit('onauthenticate', ...auth, peer) : null
      }
    )
    const peer = new PeerConnection(initiator, this.rpcChannelKey, mergedOpts)
    this.peers.push(peer)
    return peer
  }

  _onManifestReceived (snapshot, accept, peer) {
    let pending = snapshot.feeds.length
    const selected = []

    const whenSelectionDone = () => {
      // Send replicationRequest to remote
      accept(selected)

      // Initiate replication assuming that remote will honor
      // the offer.
      this._mapFeeds(snapshot.namespace, selected)
        .then(feeds => {
          const promises = []
          for (const feed of feeds) {
            if (!peer.isActive(feed.key)) {
              promises.push(this._startFeedReplication(feed, peer))
            }

            // Attempt to find peers that are not aware of
            // this key in order to forward the share.
            const doForwardDetection = typeof this.handlers.onforward === 'function'
            if (doForwardDetection) {
              const hkey = feed.key.toString('hex')
              const unawarePeers = this.peers
                .filter(p =>
                  p !== peer && // exclude current peer
                  p.state === STATE_ACTIVE && // Is connected and active
                  // Hasn't seen this key in any offer exchanges
                  (!p.exchangeExt.offeredKeys[hkey] ||
                    !p.exchangeExt.remoteOfferedKeys[hkey])
                )
              if (unawarePeers.length) {
                this.handlers.onforward(snapshot.namespace, feed.key, unawarePeers)
              }
            }
          }
          return Promise.all(promises)
        })
        .catch(this.handlers.onerror)
    }

    for (const feed of snapshot.feeds) {
      // Skip already replicating feeds.
      if (peer.isActive(feed.key)) continue
      // Otherwise query handler
      this._isResourceAllowed(
        snapshot.namespace,
        feed.key,
        feed.headers,
        peer,
        accepted => {
          if (accepted) selected.push(feed.key)
          if (!--pending) whenSelectionDone()
        }
      )
    }
  }

  _isResourceAllowed (namespace, key, headers, peer, callback) {
    // TODO: short-circuit through cache?
    // if (this._whitelist[namespace][key]) callback(true)
    this.handlers.onaccept({
      key,
      headers,
      peer,
      namespace
    }, callback)
  }

  _startFeedReplication (feed, peer) {
    this.stats.started++
    return peer.replicateCore(feed)
      .then(r => {
        // Replication done?
        // debugger
        this.stats.done++
        return r
      })
  }

  // Synchroneous feed mapper
  _mapFeeds (namespace, keys) {
    return Promise.all(keys.map(key => this._resolveResource(namespace, key)))
  }

  async _resolveResource (namespace, key) {
    let feed = this._resourceCache[key.toString('hex')] // TODO: bug, namespace ignored!
    if (feed) return feed

    feed = await defer(done => this.handlers.resolve({ namespace, key }, feed => {
      done(null, feed)
    }))

    this._resourceCache[key.toString('hex')] = feed
    await defer(done => feed.ready(done))
    if (!key.equals(feed.key)) throw new Error(`Resolved key mismatch: ${key.toString('hex')} !== ${feed.key.toString('hex')}`)
    return feed
  }

  _onPeerStateChanged (state, prevstate, err, peer) {
    switch (state) {
      case STATE_ACTIVE:
        this._emit('onconnect', peer)
        break
      case STATE_DEAD:
        // cleanup up
        this.peers.splice(this.peers.indexOf(peer), 1)
        this._emit('ondisconnect', err, peer)
        if (peer.lastError) {
          this._emit('error', peer.lastError, peer)
        }
        break
    }
  }

  _emit (ev, ...args) {
    if (typeof this.handlers[ev] === 'function') return this.handlers[ev](...args)
  }

  _onReplicateRequest (req, peer) {
    const { namespace, keys } = req
    const offered = peer.exchangeExt.offeredKeys[namespace] || {}
    // Maybe offered-filtering should be done in exchange-ext.
    this._mapFeeds(namespace, keys.filter(k => offered[k.toString('hex')]))
      .then(feeds => {
        for (const feed of feeds) {
          if (peer.isActive(feed.key)) continue
          this._startFeedReplication(feed, peer)
            .catch(this.handlers.onerror)
        }
      })
      .catch(this.handlers.onerror)
  }
}

module.exports = (...args) => new ReplicationManager(...args)
module.exports.ReplicationManager = ReplicationManager
module.exports.PeerConnection = PeerConnection
