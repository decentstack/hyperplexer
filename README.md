[![Build Status](https://travis-ci.com/geut/@decentstack/hyperplexer.svg?branch=master)](https://travis-ci.com/geut/@decentstack/hyperplexer)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

# hyperplexer

> hypercore multiplexer and replication manager 🐙

`Version: 0.9`

hyperplexer provides you with a general purpose RPC
as opposed to implementing your own hypercore-protocol-extension.

- lower level api exposed through 4 callbacks
- Custom data exchange similar to http-headers
- Replicates multiple feeds per Peer connection
- Keeps track of which feeds your neighbours have or miss

TODO:

- [x] feed-filters
- [ ] 🔥feed hot-swapping (in progress) _epic_
- [ ] compress peer#feeds LUTs into routing filters
- [ ] cache exchanged feedDescriptors and headers

NICE TO HAVE:
- [x] Acts as hypercore-protocol-extension host (accepts other extensions)
- [ ] Make ext-host impl uniform using [abstract-extension](https://github.com/mafintosh/abstract-extension/)


## <a name="install"></a> Install

```bash
yarn add hyperplexer
# or
npm install hyperplexer
```

Run interactive hypersim session with:

```bash
$(npm bin)/hypersim -T scenarios/multi-index-swarm.js
```

## <a name="usage"></a> Usage

```
const Hyperplexer = require('hyperplexer')
const rpcChannelKey = require('crypto').randomBytes(32)

const mux = new Hyperplexer(rpcChannelKey, {
  onerror: err => console.error(err),

  // Invoked when a new PeerConnection is added to the manager.
  onconnect: peer => {
    const feeds = // get list of feeds from a core store

    const descriptors = feeds.map(feed => {
      // A descriptor must contain prop `key`
      // and optionally custom headers
      return {
        key: feed.key,
        headers: { // Attach anything you want
          length: feed.length,
          color: feed.get(0),
          interesting: Math.random() > 0.5 ? true : false
        }
      }
    })

    mux.share(peer, descriptors)
  },

  // Invoked when our we receive a manifest/ Once for each descriptor
  onaccept: (feedDescriptor, accept) => {
    const { key, headers, peer } = feedDescriptor
    if (headers.interesting === true) {
      accept(true) // includes `key` in next replicationRequest signal.
    } else {
      accept(false) // passively signals "do not want"
    }
  }

  // Resolve key to feed
  onresolve: (resolveReq, resolve) => {
    const { key } = resolveReq
    const feed = // Look up or create feed by key in a core store
    resolve(feed)
  },

  // Invoked with a list of `peers` that are unaware of `key`
  // usually happens when a new user joins the swarm, this handler
  // lets you announce their presence to the rest of the network.
  onforward: (namespace, key, peers) { // see #share() for info on namespaces
    const descriptors = // same as in `onconnect`

    peers.forEach(peer => {
      mux.share(peer, descriptors)
    })
  }
})

// With hyperswarm
hyperswarm.join(Buffer.from('Topic with hyperplexing peers'))

hyperswarm.on('connect', (socket, details) => {
 const peerConn = mux.handleConnection(!!details.client, socket)
})
```

See JSdoc annotations in [index.js](./index.js) for more info
on the `handlers` and `opts` objects.

## <a name="contribute"></a> Contributing

Ideas and contributions to the project are welcome. You must follow this [guideline](https://github.com/telamon/@decentstack/hyperplexer/blob/master/CONTRIBUTING.md).

## Ad
```ad
 _____                      _   _           _
|  __ \   Help Wanted!     | | | |         | |
| |  | | ___  ___ ___ _ __ | |_| |     __ _| |__  ___   ___  ___
| |  | |/ _ \/ __/ _ \ '_ \| __| |    / _` | '_ \/ __| / __|/ _ \
| |__| |  __/ (_|  __/ | | | |_| |___| (_| | |_) \__ \_\__ \  __/
|_____/ \___|\___\___|_| |_|\__|______\__,_|_.__/|___(_)___/\___|

If you're reading this it means that the docs are missing or in a bad state.

Writing and maintaining friendly and useful documentation takes
effort and time. In order to do faster releases
I will from now on provide documentation relational to project activity.

  __How_to_Help____________________________________.
 |                                                 |
 |  - Open an issue if you have ANY questions! :)  |
 |  - Star this repo if you found it interesting   |
 |  - Fork off & help document <3                  |
 |.________________________________________________|

I publish all of my work as Libre software and will continue to do so,
drop me a penny at Patreon to help fund experiments like these

Patreon: https://www.patreon.com/decentlabs
Discord: https://discord.gg/K5XjmZx
Telegram: https://t.me/decentlabs_se
```

## License

GNU AGPLv3 © Tony Ivanov
