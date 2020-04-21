[![Build Status](https://travis-ci.com/geut/@decentstack/hyperplexer.svg?branch=master)](https://travis-ci.com/geut/@decentstack/hyperplexer)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

# @decentstack/hyperplexer

> hypercore multiplexer and replication manager

`Version: pre-release`

hyperplexer is a replication-manager designed to effectively replicate
multiple feeds on single peer connections.

In order to ovecome the O(n^n) issues that arise in swarms with high feed counts:

- [x] feed-filters
- [ ] feed hot-swapping (in progress) _epic_
- [ ] compress peer#feeds LUTs
- [ ] cache exchange-headers

Other features:
- [x] Acts as hypercore-protocol-extension host
- [ ] Make ext-host impl uniform using [abstract-extension](https://github.com/mafintosh/abstract-extension/)


## <a name="install"></a> Install

```bash
yarn add hyperplexer
# or
npm install hyperplexer
```

## <a name="usage"></a> Usage

```
const mux = new Hyperplexer(encryptionKey, handlers, opts)
const stream = mux.replicate(true)
```

See JSdoc annotations in [index.js](./index.js) for info
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
