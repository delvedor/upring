'use strict'

const hashring = require('swim-hashring')
const EE = require('events').EventEmitter
const inherits = require('util').inherits
const net = require('net')
const tentacoli = require('tentacoli')
const pump = require('pump')
const dezalgo = require('dezalgo')
const networkAddress = require('network-address')
const bloomrun = require('bloomrun')
const tinysonic = require('tinysonic')

function UpRing (opts) {
  if (!(this instanceof UpRing)) {
    return new UpRing(opts)
  }

  opts = opts || {}
  opts.port = opts.port || 0
  opts.host = opts.host || networkAddress()

  const hashringOpts = opts.hashring || {}
  hashringOpts.base = hashringOpts.base || opts.base
  hashringOpts.name = hashringOpts.name || opts.name
  hashringOpts.client = hashringOpts.client || opts.client
  hashringOpts.host = opts.host

  this._inbound = new Set()

  this._dispatch = (req, reply) => {
    var func
    if (this._router) {
      func = this._router.lookup(req)
      if (func) {
        func(req, reply)
      } else {
        reply(new Error('message does not match any pattern'))
      }
    } else {
      this.emit('request', req, reply)
    }
  }

  this._server = net.createServer((stream) => {
    if (this.closed) {
      stream.destroy()
      return
    }

    const instance = tentacoli()
    this._inbound.add(instance)
    pump(stream, instance, stream, () => {
      this._inbound.delete(instance)
    })
    instance.on('request', this._dispatch)
  })
  this._server.listen(opts.port, opts.host, () => {
    const local = hashringOpts.local = hashringOpts.local || {}
    const meta = local.meta = local.meta || {}
    meta.upring = {
      address: opts.host,
      port: this._server.address().port
    }
    this._hashring = hashring(hashringOpts)
    this._hashring.on('up', () => {
      this.emit('up')
    })
    this._hashring.on('move', (info) => {
      this.emit('move', info)
    })
    this._hashring.on('steal', (info) => {
      this.emit('steal', info)
    })
    this._hashring.on('error', this.emit.bind(this, 'error'))
  })

  this._server.on('error', this.emit.bind(this, 'error'))

  this._peers = {}
}

inherits(UpRing, EE)

UpRing.prototype.whoami = function () {
  return this._hashring.whoami()
}

UpRing.prototype.allocatedToMe = function (key) {
  return this._hashring.allocatedToMe(key)
}

UpRing.prototype.peerConn = function (peer) {
  let conn = this._peers[peer.id]

  if (!conn) {
    const upring = peer.meta.upring
    const stream = net.connect(upring.port, upring.address)
    conn = tentacoli()
    pump(stream, conn, stream, () => {
      conn._pending.forEach((msg) => {
        setTimeout(() => {
          this.request(msg.obj, msg.callback, msg._count)
        }, 100 * msg._count)
      })
      delete this._peers[peer.id]
    })

    conn._pending = new Set()
    this._peers[peer.id] = conn
  }

  return conn
}

UpRing.prototype.peers = function () {
  return this._hashring.peers()
}

UpRing.prototype.request = function (obj, callback, _count) {
  if (this._hashring.allocatedToMe(obj.key)) {
    this._dispatch(obj, dezalgo(callback))
  } else {
    let peer = this._hashring.lookup(obj.key)
    let upring = peer.meta.upring
    if (!upring || !upring.address || !upring.port) {
      callback(new Error('peer has invalid upring metadata'))
      return
    }

    // TODO simplify all this logic
    // and avoid allocating a closure
    if (typeof _count !== 'number') {
      _count = 0
    } else if (_count === 3) {
      callback(new Error('retried three times'))
      return
    } else {
      _count++
    }

    const conn = this.peerConn(peer)
    const msg = { obj, callback, _count }
    conn._pending.add(msg)
    conn.request(obj, function (err, result) {
      conn._pending.delete(msg)
      callback(err, result)
    })
  }

  return this
}

UpRing.prototype.add = function (pattern, func) {
  if (!this._router) {
    this._router = bloomrun()
  }

  if (typeof pattern === 'string') {
    let sonic = tinysonic(pattern)

    if (sonic) {
      pattern = sonic
    } else {
      pattern = { cmd: pattern }
    }
  }

  this._router.add(pattern, func)
}

UpRing.prototype.close = function (cb) {
  cb = cb || noop

  if (this.closed) {
    return cb()
  }

  this.closed = true

  Object.keys(this._peers).forEach((id) => {
    this._peers[id].destroy()
  })

  this._inbound.forEach((s) => {
    s.destroy()
  })
  this._hashring.close()
  this._server.close(cb)

  return this
}

function noop () {}

module.exports = UpRing
