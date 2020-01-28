const test = require('tape')
const hypercore = require('hypercore')
const ram = require('random-access-memory')
const { defer } = require('deferinfer')
const { ReplicationManager, PeerConnection } = require('..')
const { randomBytes } = require('crypto')

test('PeerConnection.replicateCore().then()', async t => {
  t.plan(3)
  try {
    const feed1 = hypercore(ram)
    await defer(d => feed1.ready(d))
    const feed2 = hypercore(ram, feed1.key)

    for (let i = 0; i < 3; i++) {
      await defer(d => feed1.append(randomBytes(0xff), d))
    }
    const exKey = randomBytes(64)
    const peer1 = new PeerConnection(true, exKey)
    const peer2 = new PeerConnection(false, exKey)
    peer1.stream
      .pipe(peer2.stream)
      .pipe(peer1.stream)
      .once('error', t.error)
      .once('end', t.pass.bind(null, 'pipe closed'))

    peer1.replicateCore(feed1, err => t.error(err, 'Feed 1 replication finished successfully'))
    await peer2.replicateCore(feed2)
    t.pass('Feed 2 replication finished successfully')
  } catch (e) { t.error(e) }
})

const arraySourceFactory = (ra, coreFn, count = 3) => {
  const a = Array.from(new Array(count))
    .map((_, n) => coreFn(p => ra(n + p)))
  a.ready = (cb, i = 0) => i < a.length ? a[i].ready(a.ready(cb, ++i)) : cb()
  a.toManifest = cb => {
    a.ready(() => {
      cb(a.map(f => ({
        key: f.key,
        headers: { origin: 'dummy' }
      })))
    })
  }
  a.create = key => {
    const l = a.length
    const f = coreFn(p => ra(l + p), key)
    a.push(f)
    return f
  }
  a.sumBlocks = () => a.reduce((s, f) => s + f.length, 0)
  return a
}

// Horrible out of control test that needs to be clarified.
test.only('basic replication', async t => {
  t.plan(32)
  const encryptionKey = randomBytes(32)
  let imLast = false

  // Register corestore as middleware
  // local has 3 feeds
  const localStore = arraySourceFactory(ram, hypercore, 3)
  await defer(d => localStore.ready(d))
  for (const feed of localStore) {
    await defer(d => feed.append(randomBytes(512), d))
  }

  const stack = new ReplicationManager(encryptionKey, {
    onerror: t.error,
    onconnect: peer => {
      localStore.toManifest(m => stack.share(peer, m))
      t.ok(peer, '"connection" event fired on local')
    },
    ondisconnect (err, conn) {
      t.error(err, 'Graceful disconnect')
      t.ok(conn, '"disconnect" event fired on local')
      t.equal(conn.state, 'dead', 'Connection marked as dead')
      t.error(conn.lastError, 'No errors on remote conn state')
      if (imLast) finishUp()
      else imLast = 'remote'
    },

    onauthenticate (peer) {
      debugger
      return true
    },
    onaccept ({ key, headers, peer, namespace }, accept) {
      t.equal(namespace, 'default', 'Namespace default')
      t.ok(Buffer.isBuffer(key), 'Key is buffer')
      t.equal(headers.origin, 'dummy', 'Origin header set')
      debugger
      accept(true)
    },

    // Create flag if the core is new given this
    // managers' context. Please clarify, how is it new given the context?
    // Disabling the create flag for now.
    onresolve ({ namespace, key, create }, resolve) {
      t.equal(namespace, 'default', 'Namespace is set')
      t.equal(typeof create, 'undefined', 'disabled')
      const feed = localStore.find(f => f.key.equals(key))
      t.ok(feed.key, 'Feed exists in localStore')
      resolve(feed)
    }
  })

  const remoteStore = arraySourceFactory(ram, hypercore, 0)
  await defer(d => remoteStore.ready(d))
  for (const feed of remoteStore) {
    await defer(d => feed.append(randomBytes(512), d))
  }

  const remoteStack = new ReplicationManager(encryptionKey, {
    onerror: t.error,
    onconnect: conn => t.ok(conn, '"connection" event fired on remote'),
    ondisconnect (err, peer) {
      t.error(err, 'Graceful disconnect')
      t.equal(peer.state, 'dead', 'Connection marked as dead')
      t.error(peer.lastError, 'No errors on remote conn state')
      if (imLast) finishUp()
      else imLast = 'local'
    },

    onresolve ({ namespace, key }, resolve) {
      let feed = remoteStore.find(f => {
        return f.key.equals(key)
      })
      if (!feed) feed = remoteStore.create(key)
      t.ok(feed, 'feed found')
      feed.ready(() => resolve(feed))
    }
  })

  // Initialize a reverse stream
  const stream = remoteStack.replicate(true)

  // Preferred connection handler
  const connection = stack.handleConnection(false, { stream })
  // stream.pipe(connection.stream).pipe(stream)
  t.ok(connection instanceof PeerConnection, 'PeerConnection returned')
  // Also supported but not explored patterns includes:
  // stack.replicate({ stream })
  // stream.pipe(stack.replicate()).pipe(stream)

  const finishUp = () => {
    t.equal(localStore.length, 3, 'All feeds available on local')
    t.equal(remoteStore.length, 3, 'All feeds available on remote')
    t.equal(remoteStore.sumBlocks(), localStore.sumBlocks(), 'All entries transfered')
    debugger
    t.equal(connection.queue.remaining, 0)
    stack.close(t.end)
  }
})

test.skip('Basic: Live feed forwarding', t => {
  t.plan(13)
  setup('one', p1 => {
    setup('two', p2 => {
      setup('three', p3 => {
        let feedsReplicated = 0
        p1.store.on('feed', feed => {
          feed.get(0, (err, data) => {
            t.error(err)
            switch (feedsReplicated++) {
              case 0: {
                const f2 = p2.store.feeds[0]
                t.equal(feed.key.toString('hex'), f2.key.toString('hex'), 'should see m2\'s writer')
                t.equals(data.toString(), 'two', 'm2\'s writer should have been replicated')
                break
              }
              case 1: {
                const f3 = p3.store.feeds[0]
                t.equal(feed.key.toString('hex'), f3.key.toString('hex'), 'should see m3\'s writer')
                t.equals(data.toString(), 'three', 'm3\'s writer should have been forwarded via m2')
                p1.stack.close()
                p2.stack.close()
                p3.stack.close()
                break
              }
              default:
                t.ok(false, 'Only expected to see 2 feed events, got: ' + feedsReplicated)
            }
          })
        })
        let pending = 3

        const finishUp = err => {
          t.error(err, `Stack gracefully closed #${pending}`)
          if (--pending) return
          t.pass('All 3 stacks closed')
          t.end()
        }

        p1.stack.once('close', finishUp)
        p2.stack.once('close', finishUp)
        p3.stack.once('close', finishUp)
        // stack1 and stack2 are now live connected.
        p1.stack.handleConnection(true, p2.stack.replicate(false))

        // When m3 is attached to m2, m2 should forward m3's writer to m1.
        p3.stack.handleConnection(false, p2.stack.replicate(true))
      })
    })
  })

  function setup (msg, cb) {
    const encryptionKey = Buffer.alloc(32)
    encryptionKey.write('forwarding is good')
    const stack = new Decentstack(encryptionKey, { live: true })
    stack.once('error', t.error)
    const store = new ArrayStore(ram, hypercore, 1)
    stack.use(store, 'ArrayStore')
    const feed = store.feeds[0]
    const ret = { stack, store, feed }
    feed.ready(() => {
      feed.append(msg, err => {
        t.error(err)
        cb(ret)
      })
    })
    return ret
  }
})

test.skip('Hypercore extensions support (local|global)', async t => {
  t.plan(10)
  const encryptionKey = Buffer.alloc(32)
  encryptionKey.write('foo bars')

  const stack = new Decentstack(encryptionKey)
  stack.once('error', t.error)

  const conn = new PeerConnection(true, encryptionKey, {
    live: true,
    onclose: err => t.error(err, 'Close Handler invoked w/o error')
  })

  const peerExt = conn.registerExtension('hello', {
    encoding: 'json',
    onmessage (decodedMessage, peer) {
      t.equal(peer, conn, 'PeerConnection should be presented')
      t.equal(decodedMessage.world, 'greetings!')
      peerExt.send({ dead: 'feed' }, peer)
    }
  })
  t.equal(conn._extensions[peerExt._id], peerExt)

  const globalExt = stack.registerExtension('hello', {
    encoding: 'json',
    onmessage (decodedMessage, peer) {
      t.ok(peer, 'PeerConnection should be presented')
      t.equal(decodedMessage.dead, 'feed', 'message decoded correctly')

      globalExt.destroy() // unregisters the extension
      t.notOk(stack._extensions[globalExt._id], 'Global ext successfully destroyed')
      peerExt.destroy() // unregisters peer specific ext
      t.notOk(conn._extensions[peerExt._id], 'Peer extension successfully destroyed')
      conn.kill()
    }
  })
  t.equal(stack._extensions[globalExt._id], globalExt)

  t.equal(globalExt.name, 'hello')
  stack.handleConnection(false, conn.stream, { live: true })
  conn.stream.once('end', t.end)

  globalExt.broadcast({ world: 'greetings!' })
})
