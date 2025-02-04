'use strict'

const { EventEmitter } = require('events')
const debug = require('debug')('bfx:ws2')
const WebSocket = require('ws')
const Promise = require('bluebird')
const CbQ = require('cbq')
const _Throttle = require('lodash.throttle') // eslint-disable-line
const _isArray = require('lodash/isArray')
const _isEmpty = require('lodash/isEmpty')
const _isString = require('lodash/isString')
const _isNumber = require('lodash/isNumber')
const _includes = require('lodash/includes')
const _pick = require('lodash/pick')
const _isEqual = require('lodash/isEqual')
const _isFinite = require('lodash/isFinite')
const { genAuthSig, nonce } = require('bfx-api-node-util')
const LosslessJSON = require('lossless-json')
const getMessagePayload = require('../util/ws2')

const {
  BalanceInfo,
  FundingCredit,
  FundingInfo,
  FundingLoan,
  FundingOffer,
  FundingTrade,
  MarginInfo,
  Notification,
  Order,
  Position,
  Trade,
  PublicTrade,
  Wallet,
  OrderBook,
  Candle,
  TradingTicker,
  FundingTicker
} = require('bfx-api-node-models')

const DATA_CHANNEL_TYPES = ['ticker', 'book', 'candles', 'trades']
const UCM_NOTIFICATION_TYPE = 'ucm-notify-ui'
const MAX_CALC_OPS = 8

/**
 * A Promise Throttle instance
 *
 * @typedef {object} PromiseThrottle
 * @property {Function} add - add a promise to be throttled
 */

/**
 * Communicates with v2 of the Bitfinex WebSocket API
 *
 * @class
 */
class WSv2 extends EventEmitter {
  /**
   * Instantiate a new ws2 transport. Does not auto-open
   *
   * @class WSv2
   * @param {object} [opts] - instance options
   * @param {string} [opts.affCode] - affiliate code to be applied to all orders
   * @param {string} [opts.apiKey] - API key
   * @param {string} [opts.apiSecret] - API secret
   * @param {string} [opts.url] - ws connection url, defaults to {@link WSv2#url}
   * @param {number} [opts.orderOpBufferDelay] - multi-order op batching timeout
   * @param {boolean} [opts.transform] - if true, packets are converted to models
   * @param {object} [opts.agent] - optional node agent for ws connection (proxy)
   * @param {boolean} [opts.manageOrderBooks] - enable local OB persistence
   * @param {boolean} [opts.manageCandles] - enable local candle persistence
   * @param {boolean} [opts.seqAudit] - enable sequence numbers & verification
   * @param {boolean} [opts.autoReconnect] - if true, we will reconnect on close
   * @param {number} [opts.reconnectDelay] - optional, defaults to 1000 (ms)
   * @param {PromiseThrottle} [opts.reconnectThrottler] - optional pt to limit reconnect freq
   * @param {number} [opts.packetWDDelay] - watch-dog forced reconnection delay
   * @example
   *   const ws = new WSv2()
   *
   *   ws.on('open', async () => {
   *     ws.onTrades({ symbol: 'tBTCUSD' }, (trades) => {
   *       console.log('recv trades: %j', trades)
   *     })
   *
   *     await ws.subscribeTrades('tBTCUSD')
   *   })
   *
   *   await ws.open()
   */
  constructor (opts = {
    apiKey: '',
    apiSecret: '',
    url: WSv2.url,
    affCode: null
  }) {
    super()

    this.setMaxListeners(1000)
    this._affCode = opts.affCode
    this._agent = opts.agent
    this._url = opts.url || WSv2.url
    this._transform = opts.transform === true
    this._orderOpBufferDelay = opts.orderOpBufferDelay || -1
    this._orderOpBuffer = []
    this._orderOpTimeout = null
    this._seqAudit = opts.seqAudit === true
    this._autoReconnect = opts.autoReconnect === true
    this._reconnectDelay = opts.reconnectDelay || 1000
    this._reconnectThrottler = opts.reconnectThrottler
    this._manageOrderBooks = opts.manageOrderBooks === true
    this._manageCandles = opts.manageCandles === true
    this._packetWDDelay = opts.packetWDDelay
    this._packetWDTimeout = null
    this._packetWDLastTS = 0
    this._orderBooks = {}
    this._losslessOrderBooks = {}
    this._candles = {}
    this._authArgs = {
      apiKey: opts.apiKey,
      apiSecret: opts.apiSecret
    }

    /**
     * {
     *   [groupID]: {
     *     [eventName]: [{
     *       modelClass: ..,
     *       filter: { symbol: 'tBTCUSD' }, // only works w/ serialize
     *       cb: () => {}
     *     }]
     *   }
     * }
     *
     * @private
     */
    this._listeners = {}
    this._infoListeners = {} // { [code]: <listeners> }
    this._subscriptionRefs = {}
    this._channelMap = {}
    this._orderBooks = {}
    this._enabledFlags = this._seqAudit ? WSv2.flags.SEQ_ALL : 0
    this._eventCallbacks = new CbQ()
    this._isAuthenticated = false
    this._authOnReconnect = false // used for auto-auth on reconnect
    this._lastPubSeq = -1
    this._lastAuthSeq = -1
    this._isOpen = false
    this._ws = null
    this._isClosing = false // used to block reconnect on direct close() call
    this._isReconnecting = false

    this._onWSOpen = this._onWSOpen.bind(this)
    this._onWSClose = this._onWSClose.bind(this)
    this._onWSError = this._onWSError.bind(this)
    this._onWSMessage = this._onWSMessage.bind(this)
    this._triggerPacketWD = this._triggerPacketWD.bind(this)
    this._sendCalc = _Throttle(this._sendCalc.bind(this), 1000 / MAX_CALC_OPS)
  }

  /**
   * @returns {string} url
   */
  getURL () {
    return this._url
  }

  /**
   * @returns {boolean} usesAgent
   */
  usesAgent () {
    return !!this._agent
  }

  /**
   * Set `calc` and `dms` values to be used on the next {@link WSv2#auth} call
   *
   * @param {object} args - arguments
   * @param {number} [args.calc] - calc value
   * @param {number} [args.dms] - dms value, active 4
   * @param {number} [args.apiKey] API key
   * @param {number} [args.apiSecret] API secret
   * @see WSv2#auth
   */
  updateAuthArgs (args = {}) {
    this._authArgs = {
      ...this._authArgs,
      ...args
    }
  }

  /**
   * Fetch the current default auth parameters
   *
   * @returns {object} authArgs
   * @see WSv2#updateAuthArgs
   * @see WSv2#auth
   */
  getAuthArgs () {
    return this._authArgs
  }

  /**
   * Get the total number of data channels this instance is currently
   * subscribed too.
   *
   * @returns {number} count
   * @see WSv2#subscribeTrades
   * @see WSv2#subscribeTicker
   * @see WSv2#subscribeCandles
   * @see WSv2#subscribeOrderBook
   */
  getDataChannelCount () {
    return Object
      .values(this._channelMap)
      .filter(c => _includes(DATA_CHANNEL_TYPES, c.channel))
      .length
  }

  /**
   * Check if the instance is subscribed to the specified channel ID
   *
   * @param {number} chanId - ID of channel to query
   * @returns {boolean} isSubscribed
   */
  hasChannel (chanId) {
    return !!this._channelMap[chanId]
  }

  /**
   * Check if a channel/identifier pair has been subscribed too
   *
   * @param {string} channel - channel type
   * @param {string} identifier - unique identifier for the reference
   * @returns {boolean} hasRef
   * @see WSv2#managedSubscribe
   */
  hasSubscriptionRef (channel, identifier) {
    const key = `${channel}:${identifier}`
    return !!Object.keys(this._subscriptionRefs).find(ref => ref === key)
  }

  /**
   * Fetch the ID of a channel matched by type and channel data filter
   *
   * @param {string} type - channel type
   * @param {object} filter - to be matched against channel data
   * @returns {number} channelID
   */
  getDataChannelId (type, filter) {
    return Object
      .keys(this._channelMap)
      .find(cid => {
        const c = this._channelMap[cid]
        const fv = _pick(c, Object.keys(filter))
        return c.channel === type && _isEqual(fv, filter)
      })
  }

  /**
   * Check if the instance is subscribed to a data channel matching the
   * specified type and filter.
   *
   * @param {string} type - channel type
   * @param {object} filter - to be matched against channel data
   * @returns {boolean} hasChannel
   */
  hasDataChannel (type, filter) {
    return !!this.getDataChannelId(type, filter)
  }

  /**
   * Opens a connection to the API server. Rejects with an error if a
   * connection is already open. Resolves on success.
   *
   * @returns {Promise} p
   */
  async open () {
    if (this._isOpen || this._ws !== null) {
      throw new Error('already open')
    }

    debug('connecting to %s...', this._url)

    this._ws = new WebSocket(this._url, {
      agent: this._agent
    })

    this._subscriptionRefs = {}
    this._candles = {}
    this._orderBooks = {}

    this._ws.on('message', this._onWSMessage)
    this._ws.on('error', this._onWSError)
    this._ws.on('close', this._onWSClose)

    return new Promise((resolve) => {
      this._ws.on('open', () => {
        // call manually instead of binding to open event so it fires at the
        // right time
        this._onWSOpen()

        if (this._enabledFlags !== 0) {
          this.sendEnabledFlags()
        }

        debug('connected')
        resolve()
      })
    })
  }

  /**
   * Closes the active connection. If there is none, rejects with a promise.
   * Resolves on success
   *
   * @param {number} code - passed to ws
   * @param {string} reason - passed to ws
   * @returns {Promise} p
   */
  async close (code, reason) {
    if (!this._isOpen || this._ws === null) {
      throw new Error('not open')
    }

    debug('disconnecting...')

    return new Promise((resolve) => {
      this._ws.once('close', () => {
        this._isOpen = false
        this._ws = null

        debug('disconnected')
        resolve()
      })

      if (!this._isClosing) {
        this._isClosing = true
        this._ws.close(code, reason)
      }
    })
  }

  /**
   * Generates & sends an authentication packet to the server; if already
   * authenticated, rejects with an error, resolves on success.
   *
   * If a DMS flag of 4 is provided, all open orders are cancelled when the
   * connection terminates.
   *
   * @param {number?} calc - optional, default is 0
   * @param {number?} dms - optional dead man switch flag, active 4
   * @returns {Promise} p
   */
  async auth (calc, dms) {
    this._authOnReconnect = true
    if (!this._isOpen) {
      throw new Error('not open')
    }

    if (this._isAuthenticated) {
      throw new Error('already authenticated')
    }

    const authNonce = nonce()
    const authPayload = `AUTH${authNonce}${authNonce}`
    const { sig } = genAuthSig(this._authArgs.apiSecret, authPayload)
    const authArgs = { ...this._authArgs }

    if (_isFinite(calc)) authArgs.calc = calc
    if (_isFinite(dms)) authArgs.dms = dms

    return new Promise((resolve) => {
      this.once('auth', () => {
        debug('authenticated')
        resolve()
      })

      this.send({
        event: 'auth',
        apiKey: this._authArgs.apiKey,
        authSig: sig,
        authPayload,
        authNonce,
        ...authArgs
      })
    })
  }

  /**
   * Utility method to close & re-open the ws connection. Re-authenticates if
   * previously authenticated
   *
   * @returns {Promise} p - resolves on completion
   */
  async reconnect () {
    this._isReconnecting = true

    if (this._ws !== null && this._isOpen) { // did we get a watchdog timeout and need to close the connection?
      await this.close()

      return new Promise((resolve) => {
        this.once(this._authOnReconnect ? 'auth' : 'open', resolve)
      })
    }

    return this.reconnectAfterClose() // we are already closed, so reopen and re-auth
  }

  /**
   * @private
   */
  async reconnectAfterClose () {
    if (!this._isReconnecting || this._ws !== null || this._isOpen) {
      return this.reconnect()
    }

    await this.open()

    if (this._authOnReconnect) {
      await this.auth()
    }
  }

  /**
   * Returns an error if the message has an invalid (out of order) sequence #
   * The last-seen sequence #s are updated internally.
   *
   * @param {Array} msg - incoming message
   * @returns {Error} err - null if no error or sequencing not enabled
   * @private
   */
  _validateMessageSeq (msg = []) {
    if (!this._seqAudit) return null
    if (!Array.isArray(msg)) return null
    if (msg.length === 0) return null

    // The auth sequence # is the last value in channel 0 non-heartbeat packets.
    const authSeq = msg[0] === 0 && msg[1] !== 'hb'
      ? msg[msg.length - 1]
      : NaN

    // *-req packets don't include public seq numbers
    if (`${(msg[2] || [])[1] || ''}`.slice(-4) !== '-req') {
      // All other packets provide a public sequence # as the last value. For chan
      // 0 packets, these are included as the 2nd to last value
      const seq = (
        (msg[0] === 0) &&
        (msg[1] !== 'hb') &&
        !(msg[1] === 'n' && ((msg[2] || [])[1] || '').slice(-4) === '-req')
      )
        ? msg[msg.length - 2]
        : msg[msg.length - 1]

      if (!_isFinite(seq)) return null

      if (this._lastPubSeq === -1) { // first pub seq received
        this._lastPubSeq = seq
        return null
      }

      if (seq !== this._lastPubSeq + 1) { // check pub seq
        return new Error(`invalid pub seq #; last ${this._lastPubSeq}, got ${seq}`)
      }

      this._lastPubSeq = seq
    }

    if (!_isFinite(authSeq)) return null
    if (authSeq === 0) return null // still syncing

    // notifications don't advance seq
    if (msg[1] === 'n') {
      return authSeq !== this._lastAuthSeq
        ? new Error(
          `invalid auth seq #, expected no advancement but got ${authSeq}`
          )
        : null
    }

    if (authSeq === this._lastAuthSeq) {
      return new Error(
        `expected auth seq # advancement but got same seq: ${authSeq}`
      )
    }

    // check
    if (this._lastAuthSeq !== -1 && authSeq !== this._lastAuthSeq + 1) {
      return new Error(
        `invalid auth seq #; last ${this._lastAuthSeq}, got ${authSeq}`
      )
    }

    this._lastAuthSeq = authSeq
    return null
  }

  /**
   * Trigger the packet watch-dog; called when we haven't seen a new WS packet
   * for longer than our WD duration (if provided)
   *
   * @returns {Promise} p
   * @private
   */
  async _triggerPacketWD () {
    if (!this._packetWDDelay || !this._isOpen) {
      return Promise.resolve()
    }

    debug(
      'packet delay watchdog triggered [last packet %dms ago]',
      Date.now() - this._packetWDLastTS
    )

    this._packetWDTimeout = null
    return this.reconnect()
  }

  /**
   * Reset the packet watch-dog timeout. Should be called on every new WS packet
   * if the watch-dog is enabled
   *
   * @private
   */
  _resetPacketWD () {
    if (!this._packetWDDelay) return
    if (this._packetWDTimeout !== null) {
      clearTimeout(this._packetWDTimeout)
    }

    if (!this._isOpen) return

    this._packetWDTimeout = setTimeout(() => {
      this._triggerPacketWD().catch((err) => {
        debug('error triggering packet watchdog: %s', err.message)
      })
    }, this._packetWDDelay)
  }

  /**
   * Subscribes to previously subscribed channels, used after reconnecting
   *
   * @private
   */
  resubscribePreviousChannels () {
    Object.values(this._prevChannelMap).forEach((chan) => {
      const { channel } = chan

      switch (channel) {
        case 'ticker': {
          const { symbol } = chan
          this.subscribeTicker(symbol)
          break
        }

        case 'trades': {
          const { symbol } = chan
          this.subscribeTrades(symbol)
          break
        }

        case 'book': {
          const { symbol, len, prec } = chan
          this.subscribeOrderBook(symbol, prec, len)
          break
        }

        case 'candles': {
          const { key } = chan
          this.subscribeCandles(key)
          break
        }

        default: {
          debug('unknown previously subscribed channel type: %s', channel)
        }
      }
    })
  }

  /**
   * @private
   */
  _onWSOpen () {
    this._isOpen = true
    this._isReconnecting = false
    this._packetWDLastTS = Date.now()
    this._lastAuthSeq = -1
    this._lastPubSeq = -1
    this.emit('open')

    if (!_isEmpty(this._prevChannelMap)) {
      this.resubscribePreviousChannels()
      this._prevChannelMap = {}
    }

    debug('connection open')
  }

  /**
   * @private
   */
  async _onWSClose () {
    this._isOpen = false
    this._isAuthenticated = false
    this._lastAuthSeq = -1
    this._lastPubSeq = -1
    this._enabledFlags = 0
    this._ws = null
    this._subscriptionRefs = {}
    this.emit('close')

    debug('connection closed')

    // _isReconnecting = true - if a reconnection has been requested. In that case always call reconnectAfterClose
    // _isClosing = true - if the user explicitly requested a close
    // _autoReconnect = true - if the user likes to reconnect automatically
    if (this._isReconnecting || (this._autoReconnect && !this._isClosing)) {
      this._prevChannelMap = this._channelMap

      setTimeout(async () => {
        try {
          if (this._reconnectThrottler) {
            await this._reconnectThrottler.add(this.reconnectAfterClose.bind(this))
          } else {
            await this.reconnectAfterClose()
          }
        } catch (err) {
          debug('error reconnectAfterClose: %s', err.stack)
        }
      }, this._reconnectDelay)
    }

    this._channelMap = {}
    this._isClosing = false
  }

  /**
   * @param {Error} err - error
   * @private
   */
  _onWSError (err) {
    this.emit('error', err)

    debug('error: %s', err)
  }

  /**
   * @param {Array} arrN - notification in ws array format
   * @private
   */
  _onWSNotification (arrN) {
    const status = arrN[6]
    const msg = arrN[7]

    if (!arrN[4]) return

    if (arrN[1] === 'on-req') {
      const [,, cid] = arrN[4]
      const k = `order-new-${cid}`

      if (status === 'SUCCESS') {
        this._eventCallbacks.trigger(k, null, arrN[4])
      } else {
        this._eventCallbacks.trigger(k, new Error(`${status}: ${msg}`), arrN[4])
      }
    } else if (arrN[1] === 'oc-req') {
      const [id] = arrN[4]
      const k = `order-cancel-${id}`

      if (status === 'SUCCESS') {
        this._eventCallbacks.trigger(k, null, arrN[4])
      } else {
        this._eventCallbacks.trigger(k, new Error(`${status}: ${msg}`), arrN[4])
      }
    } else if (arrN[1] === 'ou-req') {
      const [id] = arrN[4]
      const k = `order-update-${id}`

      if (status === 'SUCCESS') {
        this._eventCallbacks.trigger(k, null, arrN[4])
      } else {
        this._eventCallbacks.trigger(k, new Error(`${status}: ${msg}`), arrN[4])
      }
    }
  }

  /**
   * @param {string} rawMsg - incoming message JSON
   * @param {string} flags - flags
   * @private
   */
  _onWSMessage (rawMsg, flags) {
    debug('recv msg: %s', rawMsg)

    this._packetWDLastTS = Date.now()
    this._resetPacketWD()

    let msg

    try {
      msg = JSON.parse(rawMsg)
    } catch (e) {
      this.emit('error', `invalid message JSON: ${rawMsg}`)
      return
    }

    debug('recv msg: %j', msg)

    if (this._seqAudit) {
      const seqErr = this._validateMessageSeq(msg)

      if (seqErr !== null) {
        this.emit('error', seqErr)
        return
      }
    }

    this.emit('message', msg, flags)

    if (Array.isArray(msg)) {
      this._handleChannelMessage(msg, rawMsg)
    } else if (msg.event) {
      this._handleEventMessage(msg)
    } else {
      debug('recv unidentified message: %j', msg)
    }
  }

  /**
   * @param {Array} msg - message
   * @param {string} rawMsg - message JSON
   * @private
   */
  _handleChannelMessage (msg, rawMsg) {
    const [chanId, type] = msg
    const channelData = this._channelMap[chanId]

    if (!channelData) {
      debug('recv msg from unknown channel %d: %j', chanId, msg)
      return
    }

    if (msg.length < 2) return
    if (msg[1] === 'hb') return

    if (channelData.channel === 'book') {
      if (type === 'cs') {
        this._handleOBChecksumMessage(msg, channelData)
      } else {
        this._handleOBMessage(msg, channelData, rawMsg)
      }
    } else if (channelData.channel === 'trades') {
      this._handleTradeMessage(msg, channelData)
    } else if (channelData.channel === 'ticker') {
      this._handleTickerMessage(msg, channelData)
    } else if (channelData.channel === 'candles') {
      this._handleCandleMessage(msg, channelData)
    } else if (channelData.channel === 'status') {
      this._handleStatusMessage(msg, channelData)
    } else if (channelData.channel === 'auth') {
      this._handleAuthMessage(msg, channelData)
    } else {
      this._propagateMessageToListeners(msg, channelData)
      this.emit(channelData.channel, msg)
    }
  }

  /**
   * @param {Array} msg - message
   * @param {object} chanData - channel definition
   * @private
   */
  _handleOBChecksumMessage (msg, chanData) {
    this.emit('cs', msg)

    if (!this._manageOrderBooks) {
      return
    }

    const { symbol, prec } = chanData
    const cs = msg[2]

    // NOTE: Checksums are temporarily disabled for funding books, due to
    //       invalid book sorting on the backend. This change is temporary
    if (symbol[0] === 't') {
      const err = this._verifyManagedOBChecksum(symbol, prec, cs)

      if (err) {
        this.emit('error', err)
        return
      }
    }

    const internalMessage = [chanData.chanId, 'ob_checksum', cs]
    internalMessage.filterOverride = [
      chanData.symbol,
      chanData.prec,
      chanData.len
    ]

    this._propagateMessageToListeners(internalMessage, false)
    this.emit('cs', symbol, cs)
  }

  /**
   * Called for messages from the 'book' channel. Might be an update or a
   * snapshot
   *
   * @param {Array|Array[]} msg - message
   * @param {object} chanData - entry from _channelMap
   * @param {string} rawMsg - message JSON
   * @private
   */
  _handleOBMessage (msg, chanData, rawMsg) {
    const { symbol, prec } = chanData
    const raw = prec === 'R0'
    let data = getMessagePayload(msg)

    if (this._manageOrderBooks) {
      const err = this._updateManagedOB(symbol, data, raw, rawMsg)

      if (err) {
        this.emit('error', err)
        return
      }

      data = this._orderBooks[symbol]
    }

    // Always transform an array of entries
    if (this._transform) {
      data = new OrderBook((Array.isArray(data[0]) ? data : [data]), raw)
    }

    const internalMessage = [chanData.chanId, 'orderbook', data]
    internalMessage.filterOverride = [
      chanData.symbol,
      chanData.prec,
      chanData.len
    ]

    this._propagateMessageToListeners(internalMessage, chanData, false)
    this.emit('orderbook', symbol, data)
  }

  /**
   * @param {string} symbol - symbol for order book
   * @param {number[]|number[][]} data - incoming data
   * @param {boolean} raw - if true, the order book is considered R*
   * @param {string} rawMsg - source message JSON
   * @returns {Error} err - null on success
   * @private
   */
  _updateManagedOB (symbol, data, raw, rawMsg) {
    // parse raw string with lossless parse which takes
    // the exact strict values rather than converting to floats
    // [0.00001, [1, 2, 3]] -> ['0.00001', ['1', '2', '3']]
    const rawLossless = LosslessJSON.parse(rawMsg, (key, value) => {
      if (value && value.isLosslessNumber) {
        return value.toString()
      } else {
        return value
      }
    })
    const losslessUpdate = rawLossless[1]
    // Snapshot, new OB. Note that we don't protect against duplicates, as they
    // could come in on re-sub
    if (Array.isArray(data[0])) {
      this._orderBooks[symbol] = data
      this._losslessOrderBooks[symbol] = losslessUpdate
      return null
    }

    // entry, needs to be applied to OB
    if (!this._orderBooks[symbol]) {
      return new Error(`recv update for unknown OB: ${symbol}`)
    }

    OrderBook.updateArrayOBWith(this._orderBooks[symbol], data, raw)
    OrderBook.updateArrayOBWith(this._losslessOrderBooks[symbol], losslessUpdate, raw)
    return null
  }

  /**
   * @param {string} symbol - symbol for order book
   * @param {string} prec - precision
   * @param {number} cs - expected checksum
   * @returns {Error} err - null if none
   * @private
   */
  _verifyManagedOBChecksum (symbol, prec, cs) {
    const ob = this._losslessOrderBooks[symbol]

    if (!ob) return null

    const localCS = ob instanceof OrderBook
      ? ob.checksum()
      : OrderBook.checksumArr(ob, prec === 'R0')

    return localCS !== cs
      ? new Error(`OB checksum mismatch: got ${localCS}, want ${cs}`)
      : null
  }

  /**
   * Returns an up-to-date copy of the order book for the specified symbol, or
   * null if no OB is managed for that symbol.
   *
   * Set `managedOrderBooks: true` in the constructor to use.
   *
   * @param {string} symbol - symbol for order book
   * @returns {OrderBook} ob - null if not found
   * @example
   *   const ws = new WSv2({ managedOrderBooks: true })
   *
   *   ws.on('open', async () => {
   *       ws.onOrderBook({ symbol: 'tBTCUSD' }, () => {
   *         const book = ws.getOB('tBTCUSD')
   *
   *         if (!book) return
   *
   *         const spread = book.midPrice()
   *         console.log('spread for tBTCUSD: %f', spread)
   *       })
   *
   *       ws.subscribeOrderBook({ symbol: 'tBTCUSD' })
   *   })
   *
   *   await ws.open()
   */
  getOB (symbol) {
    if (!this._orderBooks[symbol]) return null

    return new OrderBook(this._orderBooks[symbol])
  }

  /**
   * Returns an up-to-date lossless copy of the order book for the specified symbol, or
   * null if no OB is managed for that symbol. All amounts and prices are in original
   * string format.
   *
   * Set `manageOrderBooks: true` in the constructor to use.
   *
   * @param {string} symbol - symbol for order book
   * @returns {OrderBook} ob - null if not found
   */
  getLosslessOB (symbol) {
    if (!this._losslessOrderBooks[symbol]) return null

    return new OrderBook(this._losslessOrderBooks[symbol])
  }

  /**
   * @param {Array} msg - incoming message
   * @param {object} chanData - channel definition
   * @private
   */
  _handleTradeMessage (msg, chanData) {
    const eventName = msg[1][0] === 'f'
      ? msg[1] // Funding trades are passed to fte/ftu handlers
      : msg[1] === 'te'
        ? 'trade-entry'
        : 'trades'

    let payload = getMessagePayload(msg)

    if (!Array.isArray(payload[0])) {
      payload = [payload]
    }

    let data = payload

    if (this._transform) { // correctly parse single trade/array of trades
      const M = eventName[0] === 'f' && msg[2].length === 8 ? FundingTrade : PublicTrade
      const trades = M.unserialize(data)

      if (_isArray(trades) && trades.length === 1) {
        data = trades[0]
      } else {
        data = trades
      }

      data = new M(data)
    }

    const internalMessage = [chanData.chanId, eventName, data]
    internalMessage.filterOverride = [chanData.symbol || chanData.pair]

    this._propagateMessageToListeners(internalMessage, chanData, false)
    this.emit('trades', chanData.symbol || chanData.pair, data)
  }

  /**
   * @param {Array} msg - incoming message
   * @param {object} chanData - channel definition
   * @private
   */
  _handleTickerMessage (msg = [], chanData = {}) {
    let data = getMessagePayload(msg)

    if (this._transform) {
      data = (chanData.symbol || '')[0] === 't'
        ? new TradingTicker([chanData.symbol, ...msg[1]])
        : new FundingTicker([chanData.symbol, ...msg[1]])
    }

    const internalMessage = [chanData.chanId, 'ticker', data]
    internalMessage.filterOverride = [chanData.symbol]

    this._propagateMessageToListeners(internalMessage, chanData, false)
    this.emit('ticker', chanData.symbol, data)
  }

  /**
   * Called for messages from a 'candles' channel. Might be an update or
   * snapshot.
   *
   * @param {Array|Array[]} msg - incoming message
   * @param {object} chanData - entry from _channelMap
   * @private
   */
  _handleCandleMessage (msg, chanData) {
    const { key } = chanData
    let data = getMessagePayload(msg)

    if (this._manageCandles) {
      const err = this._updateManagedCandles(key, data)

      if (err) {
        this.emit('error', err)
        return
      }

      data = this._candles[key]
    } else if (data.length > 0 && !Array.isArray(data[0])) {
      data = [data] // always pass on an array of candles
    }

    if (this._transform) {
      data = Candle.unserialize(data)
    }

    const internalMessage = [chanData.chanId, 'candle', data]
    internalMessage.filterOverride = [chanData.key]

    this._propagateMessageToListeners(internalMessage, chanData, false)
    this.emit('candle', data, key)
  }

  /**
   * Called for messages from a 'status' channel.
   *
   * @param {Array|Array[]} msg - incoming message
   * @param {object} chanData - entry from _channelMap
   * @private
   */
  _handleStatusMessage (msg, chanData) {
    const { key } = chanData
    const data = getMessagePayload(msg)

    const internalMessage = [chanData.chanId, 'status', data]
    internalMessage.filterOverride = [chanData.key]

    this._propagateMessageToListeners(internalMessage, chanData, false)
    this.emit('status', data, key)
  }

  /**
   * @param {string} key - key for candle set
   * @param {number[]|number[][]} data - incoming dataset (single or multiple)
   * @returns {Error} err - null on success
   * @private
   */
  _updateManagedCandles (key, data) {
    if (Array.isArray(data[0])) { // snapshot, new candles
      data.sort((a, b) => b[0] - a[0])

      this._candles[key] = data
      return null
    }

    // entry, needs to be applied to candle set
    if (!this._candles[key]) {
      return new Error(`recv update for unknown candles: ${key}`)
    }

    const candles = this._candles[key]
    let updated = false

    for (let i = 0; i < candles.length; i++) {
      if (data[0] === candles[i][0]) {
        candles[i] = data
        updated = true
        break
      }
    }

    if (!updated) {
      candles.unshift(data)
    }

    return null
  }

  /**
   * Fetch a reference to the full set of synced candles for the specified key.
   * Set `managedCandles: true` in the constructor to use.
   *
   * @param {string} key - key for candle set
   * @returns {Array} candles - empty array if none exist
   * @example
   *   const ws = new WSv2({ managedCandles: true })
   *
   *   ws.on('open', async () => {
   *       ws.onCandles({ key: 'trade:1m:tBTCUSD' }, () => {
   *         const candles = ws.getCandles('trade:1m:tBTCUSD')
   *
   *         if (!candles) return
   *
   *         console.log('%d candles in dataset', candles.length)
   *       })
   *
   *       ws.subscribeCandles({ key: 'trade:1m:tBTCUSD' })
   *   })
   *
   *   await ws.open()
   */
  getCandles (key) {
    return this._candles[key] || []
  }

  /**
   * @param {Array} msg - incoming message
   * @param {object} chanData - channel data
   * @private
   */
  _handleAuthMessage (msg, chanData) {
    if (msg[1] === 'n') {
      const payload = getMessagePayload(msg)

      if (payload) {
        this._onWSNotification(payload)
      }
    } else if (msg[1] === 'te') {
      msg[1] = 'auth-te'
    } else if (msg[1] === 'tu') {
      msg[1] = 'auth-tu'
    }

    this._propagateMessageToListeners(msg, chanData)
  }

  /**
   * @param {Array} msg - incoming message
   * @param {object} chan - channel data
   * @param {boolean} transform - defaults to internal flag
   * @private
   */
  _propagateMessageToListeners (msg, chan, transform = this._transform) {
    const listenerGroups = Object.values(this._listeners)

    for (let i = 0; i < listenerGroups.length; i++) {
      WSv2._notifyListenerGroup(listenerGroups[i], msg, transform, this, chan)
    }
  }

  /**
   * Applies filtering & transform to a packet before sending it out to matching
   * listeners in the group.
   *
   * @param {object} lGroup - listener group to parse & notify
   * @param {object} msg - passed to each matched listener
   * @param {boolean} transform - whether or not to instantiate a model
   * @param {WSv2} ws - instance to pass to models if transforming
   * @param {object} chanData - channel data
   * @private
   */
  static _notifyListenerGroup (lGroup, msg, transform, ws, chanData) {
    const [, eventName, data = []] = msg
    let filterByData

    // Catch-all can't filter/transform
    WSv2._notifyCatchAllListeners(lGroup, msg)

    if (!lGroup[eventName] || lGroup[eventName].length === 0) return

    const listeners = lGroup[eventName].filter((listener) => {
      const { filter } = listener

      if (!filter) return true

      // inspect snapshots for matching packets
      if (Array.isArray(data[0])) {
        const matchingData = data.filter((item) => {
          filterByData = msg.filterOverride ? msg.filterOverride : item

          return WSv2._payloadPassesFilter(filterByData, filter)
        })

        return matchingData.length !== 0
      }

      // inspect single packet
      filterByData = msg.filterOverride ? msg.filterOverride : data

      return WSv2._payloadPassesFilter(filterByData, filter)
    })

    if (listeners.length === 0) return

    listeners.forEach(({ cb, modelClass }) => {
      const ModelClass = modelClass

      if (!ModelClass || !transform || data.length === 0) {
        cb(data, chanData)
      } else if (Array.isArray(data[0])) {
        cb(data.map((entry) => {
          return new ModelClass(entry, ws)
        }), chanData)
      } else {
        cb(new ModelClass(data, ws), chanData)
      }
    })
  }

  /**
   * @param {Array} payload - payload to verify
   * @param {object} filter - filter to match against payload
   * @returns {boolean} pass
   * @private
   */
  static _payloadPassesFilter (payload, filter) {
    const filterIndices = Object.keys(filter)
    let filterValue

    for (let k = 0; k < filterIndices.length; k++) {
      filterValue = filter[filterIndices[k]]

      if (_isEmpty(filterValue) || filterValue === '*') {
        continue
      }

      if (payload[+filterIndices[k]] !== filterValue) {
        return false
      }
    }

    return true
  }

  /**
   * @param {object} lGroup - listener group keyed by event ('' in this case)
   * @param {*} data - packet to pass to listeners
   * @private
   */
  static _notifyCatchAllListeners (lGroup, data) {
    if (!lGroup['']) return

    for (let j = 0; j < lGroup[''].length; j++) {
      lGroup[''][j].cb(data)
    }
  }

  /**
   * @param {object} msg - incoming message
   * @private
   */
  _handleEventMessage (msg) {
    if (msg.event === 'auth') {
      this._handleAuthEvent(msg)
    } else if (msg.event === 'subscribed') {
      this._handleSubscribedEvent(msg)
    } else if (msg.event === 'unsubscribed') {
      this._handleUnsubscribedEvent(msg)
    } else if (msg.event === 'info') {
      this._handleInfoEvent(msg)
    } else if (msg.event === 'conf') {
      this._handleConfigEvent(msg)
    } else if (msg.event === 'error') {
      this._handleErrorEvent(msg)
    } else if (msg.event === 'pong') {
      this._handlePongEvent(msg)
    } else {
      debug('recv unknown event message: %j', msg)
    }
  }

  /**
   * Emits an error on config failure, otherwise updates the internal flag set
   * and triggers any callbacks
   *
   * @param {object} msg - config message
   * @private
   */
  _handleConfigEvent (msg = {}) {
    const { status, flags } = msg
    const k = this._getConfigEventKey(flags)

    if (status !== 'OK') {
      const err = new Error(`config failed (${status}) for flags ${flags}`)
      debug('config failed: %s', err.message)

      this.emit('error', err)
      this._eventCallbacks.trigger(k, err)
    } else {
      debug('flags updated to %d', flags)

      this._enabledFlags = flags
      this._eventCallbacks.trigger(k, null, msg)
    }
  }

  /**
   * @param {object} msg - incoming message
   * @private
   */
  _handlePongEvent (msg) {
    debug('pong: %s', JSON.stringify(msg))

    this.emit('pong', msg)
  }

  /**
   * @param {object} msg - incoming message
   * @private
   */
  _handleErrorEvent (msg) {
    debug('error: %s', JSON.stringify(msg))

    this.emit('error', msg)
  }

  /**
   * @param {object} data - incoming message
   * @private
   */
  _handleAuthEvent (data = {}) {
    const { chanId, msg = '', status = '' } = data

    if (status !== 'OK') {
      const err = new Error(msg.match(/nonce/)
        ? 'auth failed: nonce small; you may need to generate a new API key to reset the nonce counter'
        : `auth failed: ${msg} (${status})`
      )

      debug('%s', err.message)
      this.emit('error', err)
      return
    }

    this._channelMap[chanId] = { channel: 'auth' }
    this._isAuthenticated = true

    this.emit('auth', data)
    debug('authenticated!')
  }

  /**
   * @param {object} msg - incoming message
   * @private
   */
  _handleSubscribedEvent (msg) {
    this._channelMap[msg.chanId] = msg

    debug('subscribed to %s [%d]', msg.channel, msg.chanId)
    this.emit('subscribed', msg)
  }

  /**
   * @param {object} msg - incoming message
   * @private
   */
  _handleUnsubscribedEvent (msg) {
    delete this._channelMap[msg.chanId]
    debug('unsubscribed from %d', msg.chanId)
    this.emit('unsubscribed', msg)
  }

  /**
   * @param {object} msg - incoming message
   * @private
   */
  _handleInfoEvent (msg = {}) {
    const { version, code } = msg

    if (version) {
      if (version !== 2) {
        const err = new Error(`server not running API v2: v${version}`)

        this.emit('error', err)
        this.close().catch((err) => {
          debug('error closing connection: %s', err.stack)
        })
        return
      }

      const { status } = msg.platform || {}

      debug(
        'server running API v2 (platform: %s (%d))',
        status === 0 ? 'under maintenance' : 'operating normally', status
      )
    } else if (code) {
      if (this._infoListeners[code]) {
        this._infoListeners[code].forEach(cb => cb(msg))
      }

      if (code === WSv2.info.SERVER_RESTART) {
        debug('server restarted, please reconnect')
      } else if (code === WSv2.info.MAINTENANCE_START) {
        debug('server maintenance period started!')
      } else if (code === WSv2.info.MAINTENANCE_END) {
        debug('server maintenance period ended!')
      }
    }

    this.emit('info', msg)
  }

  /**
   * Subscribes and tracks subscriptions per channel/identifier pair. If
   * already subscribed to the specified pair, nothing happens.
   *
   * @param {string} channel - channel name
   * @param {string} identifier - for uniquely identifying the ref count
   * @param {object} payload - merged with sub packet
   * @returns {boolean} subSent
   * @todo will be refactored to return promise from subscribe() call instead
   *   of sub action taken flag
   * @see WSv2#subscribeTrades
   * @see WSv2#subscribeTicker
   * @see WSv2#subscribeCandles
   * @see WSv2#subscribeOrderBook
   * @example
   * const ws = new WSv2()
   *
   * ws.on('open', async () => {
   *   ws.onTrades({ symbol: 'tBTCUSD' }, (trades) => {
   *     console.log('recv trades: %j', trades)
   *  })
   *
   *   ws.managedSubscribe('trades', 'tBTCUSD', { symbol: 'tBTCUSD' })
   * })
   *
   * await ws.open()
   */
  managedSubscribe (channel = '', identifier = '', payload = {}) {
    const key = `${channel}:${identifier}`

    if (this._subscriptionRefs[key]) {
      this._subscriptionRefs[key]++
      return false
    }

    this._subscriptionRefs[key] = 1
    this.subscribe(channel, payload)

    return true
  }

  /**
   * Decreases the subscription ref count for the channel/identifier pair, and
   * unsubscribes from the channel if it reaches 0.
   *
   * @param {string} channel - channel name
   * @param {string} identifier - for uniquely identifying the ref count
   * @returns {boolean} unsubSent
   */
  managedUnsubscribe (channel = '', identifier = '') {
    const key = `${channel}:${identifier}`
    const chanId = this._chanIdByIdentifier(channel, identifier)

    if (chanId === null || isNaN(this._subscriptionRefs[key])) return false

    this._subscriptionRefs[key]--
    if (this._subscriptionRefs[key] > 0) return false

    this.unsubscribe(chanId)
    delete this._subscriptionRefs[key]

    return true
  }

  /**
   * Fetch a channel definition
   *
   * @param {object} opts - options
   * @param {number} opts.chanId - channel ID
   * @param {string} opts.channel - channel name
   * @param {string} [opts.symbol] - match by symbol
   * @param {string} [opts.key] - match by key (for candle channels)
   * @returns {object} chanData - null if not found
   */
  getChannelData ({ chanId, channel, symbol, key }) {
    const id = chanId || this._chanIdByIdentifier(channel, symbol || key)

    return this._channelMap[id] || null
  }

  /**
   * @param {string} channel - channel name
   * @param {string} identifier - unique identifier for the channel
   * @returns {number} channelID
   * @private
   */
  _chanIdByIdentifier (channel, identifier) {
    const channelIds = Object.keys(this._channelMap)
    let chan

    for (let i = 0; i < channelIds.length; i++) {
      chan = this._channelMap[channelIds[i]]

      if (chan.channel === channel && (
        chan.symbol === identifier ||
        chan.key === identifier
      )) {
        return channelIds[i]
      }
    }

    return null
  }

  /**
   * @param {string} key - key for the promise
   * @returns {Promise} p - resolves on event
   * @private
   */
  _getEventPromise (key) {
    return new Promise((resolve, reject) => {
      this._eventCallbacks.push(key, (err, res) => {
        if (err) {
          return reject(err)
        }

        resolve(res)
      })
    })
  }

  /**
   * Send a packet to the WS server
   *
   * @param {*} msg - packet, gets stringified
   */
  send (msg) {
    if (!this._ws || !this._isOpen) {
      this.emit('error', new Error('no ws client or not open'))
    } else if (this._isClosing) {
      this.emit('error', new Error('connection currently closing'))
    } else {
      debug('sending %j', msg)
      this._ws.send(JSON.stringify(msg))
    }
  }

  /**
   * @returns {boolean} sequencingEnabled
   */
  sequencingEnabled () {
    return this._seqAudit
  }

  /**
   * Configures the seq flag to enable sequencing (packet number) for this
   * connection. When enabled, the seq number will be the last value of
   * channel packet arrays.
   *
   * @param {object} args - params
   * @param {boolean} [args.audit] - if true, an error is emitted on invalid seq
   * @returns {Promise} p
   * @see WSv2#flags
   */
  async enableSequencing (args = { audit: true }) {
    this._seqAudit = args.audit === true

    return this.enableFlag(WSv2.flags.SEQ_ALL)
  }

  /**
   * Enables a configuration flag.
   *
   * @param {number} flag - flag to update, as numeric value
   * @returns {Promise} p
   * @see WSv2#flags
   * @example
   * const ws = new WSv2()
   *
   * ws.on('open', async () => {
   *   await ws.enableFlag(WSv2.flags.CHECKSUM)
   *   console.log('ob checkums enabled')
   * })
   *
   * await ws.open()
   */
  async enableFlag (flag) {
    this._enabledFlags = this._enabledFlags | flag

    if (!this._isOpen) {
      return
    }

    this.sendEnabledFlags()
    return this._getEventPromise(this._getConfigEventKey(flag))
  }

  /**
   * Sends the local flags value to the server, updating the config
   *
   * @private
   */
  sendEnabledFlags () {
    this.send({
      event: 'conf',
      flags: this._enabledFlags
    })
  }

  /**
   * Checks local state, relies on successful server config responses
   *
   * @see enableFlag
   *
   * @param {number} flag - flag to check for
   * @returns {boolean} enabled
   */
  isFlagEnabled (flag) {
    return (this._enabledFlags & flag) === flag
  }

  /**
   * @param {string} flag - flag to fetch event key for
   * @returns {string} key
   * @private
   */
  _getConfigEventKey (flag) {
    return `conf-res-${flag}`
  }

  /**
   * Register a callback in case of a ws server restart message; Use this to
   * call reconnect() if needed. (code 20051)
   *
   * @param {Function} cb - called on event trigger
   */
  onServerRestart (cb) {
    this.onInfoMessage(WSv2.info.SERVER_RESTART, cb)
  }

  /**
   * Register a callback in case of a 'maintenance started' message from the
   * server. This is a good time to pause server packets until maintenance ends
   *
   * @param {Function} cb - called on event trigger
   */
  onMaintenanceStart (cb) {
    this.onInfoMessage(WSv2.info.MAINTENANCE_START, cb)
  }

  /**
   * Register a callback to be notified of a maintenance period ending
   *
   * @param {Function} cb - called on event trigger
   */
  onMaintenanceEnd (cb) {
    this.onInfoMessage(WSv2.info.MAINTENANCE_END, cb)
  }

  /**
   * Subscribe to a channel with the given filter payload
   *
   * @param {string} channel - channel payload/data
   * @param {object} payload - optional extra packet data
   * @example
   * const ws = new WSv2()
   *
   * ws.on('open', () => {
   *   ws.onTrades({ symbol: 'tBTCUSD' }, (trades) => {
   *     // ...
   *   })
   *
   *   ws.subscribe('trades', { symbol: 'tBTCUSD' })
   * })
   *
   * await ws.open()
   */
  subscribe (channel, payload) {
    this.send(Object.assign({
      event: 'subscribe',
      channel
    }, payload))
  }

  /**
   * Subscribe to a ticker data channel
   *
   * @param {string} symbol - symbol of ticker
   * @returns {boolean} subscribed
   * @see WSv2#managedSubscribe
   * @example
   * await ws.subscribeTicker('tBTCUSD')
   */
  async subscribeTicker (symbol) {
    return this.managedSubscribe('ticker', symbol, { symbol })
  }

  /**
   * Subscribe to a trades data channel
   *
   * @param {string} symbol - symbol of market to monitor
   * @returns {boolean} subscribed
   * @see WSv2#managedSubscribe
   * @example
   * await ws.subscribeTrades('tBTCUSD')
   */
  async subscribeTrades (symbol) {
    return this.managedSubscribe('trades', symbol, { symbol })
  }

  /**
   * Subscribe to an order book data channel
   *
   * @param {string} symbol - symbol of order book
   * @param {string} prec - P0, P1, P2, or P3 (default P0)
   * @param {string} len - 25 or 100 (default 25)
   * @returns {boolean} subscribed
   * @see WSv2#managedSubscribe
   * @example
   * await ws.subscribeOrderBook('tBTCUSD', 'R0', '25')
   */
  async subscribeOrderBook (symbol, prec = 'P0', len = '25') {
    return this.managedSubscribe('book', symbol, { symbol, len, prec })
  }

  /**
   * Subscribe to a candle data channel
   *
   * @param {string} key - 'trade:5m:tBTCUSD'
   * @returns {boolean} subscribed
   * @see WSv2#managedSubscribe
   * @example
   * await ws.subscribeCandles('trade:5m:tBTCUSD')
   */
  async subscribeCandles (key) {
    return this.managedSubscribe('candles', key, { key })
  }

  /**
   * Subscribe to a status data channel
   *
   * @param {string} key - i.e. 'liq:global'
   * @returns {boolean} subscribed
   * @see WSv2#managedSubscribe
   * @example
   * await ws.subscribeStatus('liq:global')
   */
  async subscribeStatus (key) {
    return this.managedSubscribe('status', key, { key })
  }

  /**
   * Unsubscribe from a channel by ID
   *
   * @param {number} chanId - ID of channel to unsubscribe from
   * @example
   * const id = ws.getDataChannelId('ticker', { symbol: 'tBTCUSD' })
   *
   * if (id) {
   *   ws.unsubscribe(id)
   * }
   */
  unsubscribe (chanId) {
    this.send({
      event: 'unsubscribe',
      chanId: +chanId
    })
  }

  /**
   * Unsubscribe from a ticker data channel
   *
   * @param {string} symbol - symbol of ticker
   * @returns {boolean} unsubscribed
   * @see WSv2#subscribeTicker
   * @example
   * await ws.unsubscribeTicker('tBTCUSD')
   */
  async unsubscribeTicker (symbol) {
    return this.managedUnsubscribe('ticker', symbol)
  }

  /**
   * Unsubscribe from a trades data channel
   *
   * @param {string} symbol - symbol of market to unsubscribe from
   * @returns {boolean} unsubscribed
   * @see WSv2#subscribeTrades
   * @example
   * await ws.unsubcribeTrades('tBTCUSD')
   */
  async unsubscribeTrades (symbol) {
    return this.managedUnsubscribe('trades', symbol)
  }

  /**
   * Unsubscribe from an order book data channel
   *
   * @param {string} symbol - symbol of order book
   * @returns {boolean} unsubscribed
   * @see WSv2#subscribeOrderBook
   * @example
   * await ws.unsubcribeOrderBook('tBTCUSD')
   */
  async unsubscribeOrderBook (symbol) {
    return this.managedUnsubscribe('book', symbol)
  }

  /**
   * @param {string} symbol - symbol of candles
   * @param {string} frame - time frame
   * @returns {boolean} unsubscribed
   * @see WSv2#subscribeCandles
   * @example
   *   await ws.unsubscribeCandles('tBTCUSD', '1m')
   */
  async unsubscribeCandles (symbol, frame) {
    return this.managedUnsubscribe('candles', `trade:${frame}:${symbol}`)
  }

  /**
   * @param {string} key - key that was used in initial {@link WSv2#subscribeStatus} call
   * @returns {boolean} unsubscribed
   * @see WSv2#subscribeStatus
   */
  async unsubscribeStatus (key) {
    return this.managedUnsubscribe('status', key)
  }

  /**
   * Remove all listeners by callback group ID
   *
   * @param {string} cbGID - callback group to remove
   * @example
   * await ws.subscribeTrades({ symbol: 'tBTCUSD', cbGID: 42 })
   * await ws.subscribeTrades({ symbol: 'tLEOUSD', cbGID: 42 })
   * await ws.subscribeTrades({ symbol: 'tETHUSD', cbGID: 42 })
   *
   * // ...
   *
   * ws.removeListeners(42)
   */
  removeListeners (cbGID) {
    delete this._listeners[cbGID]
  }

  /**
   * Request a calc operation to be performed on the specified indexes
   *
   * @param {string[]} prefixes - desired prefixes to be calculated
   */
  requestCalc (prefixes) {
    this._sendCalc([0, 'calc', null, prefixes.map(p => [p])])
  }

  /**
   * Throttled call to ws.send, max 8 op/s
   *
   * @param {Array} msg - message
   * @private
   */
  _sendCalc (msg) {
    debug('req calc: %j', msg)

    this._ws.send(JSON.stringify(msg))
  }

  /**
   * Sends a new order to the server and resolves the returned promise once the
   * order submit is confirmed. Emits an error if not authenticated. The order
   * can be either an array, key/value map, or Order object instance.
   *
   * @see WSv2#cancelOrders
   * @see WSv2#cancelOrder
   * @see WSv2#updateOrder
   *
   * @param {object|Array} order - order object model or array
   * @returns {Promise} p - resolves on submit notification
   * @example
   * const o = new Order({
   *   type: Order.type.EXCHANGE_LIMIT,
   *   amount: 18,
   *   price: 0.75,
   *   symbol: 'tBTCUSD',
   *   hidden: true
   * }, ws)
   *
   * await ws.submitOrder(o)
   *
   * console.log('order confirmed! status: %s', o.status)
   */
  async submitOrder (order) {
    if (!this._isAuthenticated) {
      throw new Error('not authenticated')
    }

    const packet = Array.isArray(order)
      ? order
      : order instanceof Order
        ? order.toNewOrderPacket()
        : new Order(order).toNewOrderPacket()

    if (this._affCode) {
      if (!packet.meta) {
        packet.meta = {}
      }

      packet.meta.aff_code = packet.meta.aff_code || this._affCode // eslint-disable-line
    }

    this._sendOrderPacket([0, 'on', null, packet])

    return this._getEventPromise(`order-new-${packet.cid}`)
  }

  /**
   * Send a changeset to update an order in-place while maintaining position in
   * the price queue. The changeset must contain the order ID, and supports a
   * 'delta' key to increase/decrease the total amount.
   *
   * @see WSv2#submitOrder
   *
   * @param {object} changes - requires at least an 'id'
   * @returns {Promise} p - resolves on receiving an confirmation notification
   */
  async updateOrder (changes = {}) {
    const { id } = changes

    if (!this._isAuthenticated) {
      throw new Error('not authenticated')
    } else if (!id) {
      throw new Error('order ID required for update')
    }

    this._sendOrderPacket([0, 'ou', null, changes])

    return this._getEventPromise(`order-update-${id}`)
  }

  /**
   * Cancels an order by ID and resolves the returned promise once the cancel is
   * confirmed. Emits an error if not authenticated. The ID can be passed as a
   * number, or taken from an order array/object.
   *
   * @see WSv2#submitOrder
   *
   * @param {object|Array|number} order - order model, array, or ID to be cancelled
   * @returns {Promise} p
   */
  async cancelOrder (order) {
    if (!this._isAuthenticated) {
      throw new Error('not authenticated')
    }

    const id = _isNumber(order)
      ? order
      : Array.isArray(order)
        ? order[0]
        : order.id

    debug(`cancelling order ${id}`)
    this._sendOrderPacket([0, 'oc', null, { id }])

    return this._getEventPromise(`order-cancel-${id}`)
  }

  /**
   * Cancels multiple orders, returns a promise that resolves once all
   * operations are confirmed.
   *
   * @see WSv2#submitOrder
   *
   * @param {object[]|Array[]|number[]} orders - array of order models, arrays
   *   or IDs to be cancelled
   * @returns {Promise} p
   */
  async cancelOrders (orders) {
    if (!this._isAuthenticated) {
      throw new Error('not authenticated')
    }

    return Promise.all(orders.map(o => {
      return this.cancelOrder(o)
    }))
  }

  /**
   * Sends the op payloads to the server as an 'ox_multi' command. A promise is
   * returned and resolves immediately if authenticated, as no confirmation is
   * available for this message type.
   *
   * @param {object[]} opPayloads - order operations
   * @returns {Promise} p - rejects if not authenticated
   */
  async submitOrderMultiOp (opPayloads) {
    if (!this._isAuthenticated) {
      throw new Error('not authenticated')
    }

    // TODO: multi-op tracking
    this.send([0, 'ox_multi', null, opPayloads])
  }

  /**
   * @param {Array} packet - new order packet to be submitted
   * @private
   */
  _sendOrderPacket (packet) {
    if (this._hasOrderBuff()) {
      this._ensureOrderBuffTimeout()
      this._orderOpBuffer.push(packet)
    } else {
      this.send(packet)
    }
  }

  /**
   * @returns {boolean} buffEnabled
   * @private
   */
  _hasOrderBuff () {
    return this._orderOpBufferDelay > 0
  }

  /**
   * @private
   */
  _ensureOrderBuffTimeout () {
    if (this._orderOpTimeout !== null) return

    this._orderOpTimeout = setTimeout(
      this._flushOrderOps.bind(this),
      this._orderOpBufferDelay
    )
  }

  /**
   * Splits the op buffer into packets of max 15 ops each, and sends them down
   * the wire.
   *
   * @returns {Promise} p - resolves after send
   * @private
   */
  _flushOrderOps () {
    this._orderOpTimeout = null

    const packets = this._orderOpBuffer.map(p => [p[1], p[3]])
    this._orderOpBuffer = []

    if (packets.length <= 15) {
      return this.submitOrderMultiOp(packets)
    }

    const promises = []

    while (packets.length > 0) {
      const opPackets = packets.splice(0, Math.min(packets.length, 15))
      promises.push(this.submitOrderMultiOp(opPackets))
    }

    return Promise.all(promises)
  }

  /**
   * @returns {boolean} authenticated
   */
  isAuthenticated () {
    return this._isAuthenticated
  }

  /**
   * @returns {boolean} open
   */
  isOpen () {
    return this._isOpen
  }

  /**
   * @returns {boolean} reconnecting
   */
  isReconnecting () {
    return this._isReconnecting
  }

  /**
   * Sends a broadcast notification, which will be received by any active UI
   * websocket connections (at bitfinex.com), triggering a desktop notification.
   *
   * In the future our mobile app will also support spawning native push
   * notifications in response to incoming ucm-notify-ui packets.
   *
   * @param {object} opts - options
   * @param {string} [opts.message] - message to display
   * @param {string} [opts.type] - notification type, 'ucm-*' for broadcasts
   * @param {string} [opts.level] - 'info', 'error', or 'success'
   * @param {string} [opts.image] - link to an image to be shown
   * @param {string} [opts.link] - URL the notification should forward too
   * @param {string} [opts.sound] - URL of sound to play
   * @throws an error if given no type or message, or the instance is not open
   *   and authenticated
   */
  notifyUI (opts = {}) {
    const { type, message, level, image, link, sound } = opts

    if (!_isString(type) || !_isString(message)) {
      throw new Error(`notified with invalid type/message: ${type}/${message}`)
    }

    if (!this._isOpen) {
      throw new Error('socket not open')
    }

    if (!this._isAuthenticated) {
      throw new Error('socket not authenticated')
    }

    this.send([0, 'n', null, {
      type: UCM_NOTIFICATION_TYPE,
      info: {
        type,
        message,
        level,
        image,
        link,
        sound
      }
    }])
  }

  /**
   * Adds a listener to the internal listener set, with an optional grouping
   * for batch unsubscribes (GID) & automatic ws packet matching (filterKey)
   *
   * @param {string} eventName - as received on ws stream
   * @param {object} filter - map of index & value in ws packet
   * @param {object} modelClass - model to use for serialization
   * @param {string} cbGID - listener group ID for mass removal
   * @param {Function} cb - listener
   * @private
   */
  _registerListener (eventName, filter, modelClass, cbGID, cb) {
    if (!cbGID) cbGID = null

    if (!this._listeners[cbGID]) {
      this._listeners[cbGID] = { [eventName]: [] }
    }

    const listeners = this._listeners[cbGID]

    if (!listeners[eventName]) {
      listeners[eventName] = []
    }

    const l = {
      cb,
      modelClass,
      filter
    }

    listeners[eventName].push(l)
  }

  /**
   * Registers a new callback to be called when a matching info message is
   * received.
   *
   * @param {number} code - from #WSv2.info
   * @param {Function} cb - callback
   */
  onInfoMessage (code, cb) {
    if (!this._infoListeners[code]) {
      this._infoListeners[code] = []
    }

    this._infoListeners[code].push(cb)
  }

  /**
   * Register a generic handler to be called with each received message
   *
   * @param {object} opts - options
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   */
  onMessage ({ cbGID }, cb) {
    this._registerListener('', null, null, cbGID, cb)
  }

  /**
   * Register a handler to be called with each received candle
   *
   * @param {object} opts - options
   * @param {string} opts.key - candle set key, i.e. trade:30m:tBTCUSD
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-public-candle
   * @see WSv2#subscribeCandles
   * @see WSv2#unsubscribeCandles
   */
  onCandle ({ key, cbGID }, cb) {
    this._registerListener('candle', { 0: key }, Candle, cbGID, cb)
  }

  /**
   * Register a handler to be called with each received candle
   *
   * @param {object} opts - options
   * @param {string} opts.symbol - book symbol
   * @param {string} opts.prec - book precision, i.e. 'R0'
   * @param {string} opts.len - book length, i.e. '25'
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-public-order-books
   * @see WSv2#subscribeOrderBook
   * @see WSv2#unsubscribeOrderBook
   */
  onOrderBook ({ symbol, prec, len, cbGID }, cb) {
    this._registerListener('orderbook', {
      0: symbol,
      1: prec,
      2: len
    }, OrderBook, cbGID, cb)
  }

  /**
   * Register a handler to be called with each received order book checksum
   *
   * @param {object} opts - options
   * @param {string} opts.symbol - book symbol
   * @param {string} opts.prec - book precision, i.e. 'R0'
   * @param {string} opts.len - book length, i.e. '25'
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-public-order-books
   * @see WSv2#subscribeOrderBook
   * @see WSv2#unsubscribeOrderBook
   */
  onOrderBookChecksum ({ symbol, prec, len, cbGID }, cb) {
    this._registerListener('ob_checksum', {
      0: symbol,
      1: prec,
      2: len
    }, null, cbGID, cb)
  }

  /**
   * Register a handler to be called with each received trade (pair or symbol
   * required)
   *
   * @param {object} opts - options
   * @param {string} [opts.pair] - required if no symbol specified
   * @param {string} [opts.symbol] - required if no pair specified
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-public-trades
   * @see WSv2#subscribeTrades
   * @see WSv2#unsubscribeTrades
   */
  onTrades ({ symbol, pair, cbGID }, cb) {
    const id = pair || symbol || ''
    const model = id[0] === 'f' ? FundingTrade : PublicTrade

    this._registerListener('trades', { 0: id }, model, cbGID, cb)
  }

  /**
   * Register a handler to be called on each trade `'te'` event
   *
   * @param {object} opts - options
   * @param {string} [opts.pair] - required if no symbol specified
   * @param {string} [opts.symbol] - required if no pair specified
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-public-trades
   * @see WSv2#subscribeTrades
   * @see WSv2#unsubscribeTrades
   */
  onTradeEntry ({ pair, symbol, cbGID }, cb) {
    const id = pair || symbol || ''
    this._registerListener('trade-entry', { 0: id }, PublicTrade, cbGID, cb)
  }

  /**
   * Register a handler to be called on each personal trade `'te'` event
   *
   * @param {object} opts - options
   * @param {string} [opts.pair] - required if no symbol specified
   * @param {string} [opts.symbol] - required if no pair specified
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-public-trades
   */
  onAccountTradeEntry ({ symbol, cbGID }, cb) {
    this._registerListener('auth-te', { 1: symbol }, Trade, cbGID, cb)
  }

  /**
   * Register a handler to be called on each personal trade `'tu'` event
   *
   * @param {object} opts - options
   * @param {string} [opts.pair] - required if no symbol specified
   * @param {string} [opts.symbol] - required if no pair specified
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-trades
   */
  onAccountTradeUpdate ({ symbol, cbGID }, cb) {
    this._registerListener('auth-tu', { 1: symbol }, Trade, cbGID, cb)
  }

  /**
   * Register a handler to be called on each received ticker
   *
   * @param {object} opts - options
   * @param {string} opts.symbol - symbol for tickers
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-public-ticker
   * @see WSv2#subscribeTicker
   * @see WSv2#unsubscribeTicker
   */
  onTicker ({ symbol = '', cbGID } = {}, cb) {
    const m = symbol[0] === 'f' ? FundingTicker : TradingTicker
    this._registerListener('ticker', { 0: symbol }, m, cbGID, cb)
  }

  /**
   * Register a handler to be called on each message for the desired status
   * feed.
   *
   * @param {object} opts - options
   * @param {string} opts.key - key of feed to listen on
   * @param {string|number} [opts.cbGID] - callback group ID
   * @param {Function} cb - callback
   * @see WSv2#subscribeStatus
   */
  onStatus ({ key = '', cbGID } = {}, cb) {
    this._registerListener('status', { 0: key }, null, cbGID, cb)
  }

  /**
   * Register a handler to be called on each full order snapshot (sent on auth)
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {number} [opts.id] - order ID to match
   * @param {number} [opts.cid] - order client ID to match
   * @param {number} [opts.gid] - order group ID to match
   * @param {string|number} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-orders
   * @see WSv2#auth
   */
  onOrderSnapshot ({ symbol, id, cid, gid, cbGID }, cb) {
    this._registerListener('os', {
      0: id,
      1: gid,
      2: cid,
      3: symbol
    }, Order, cbGID, cb)
  }

  /**
   * Register a handler to be called on each new order packet
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {number} [opts.id] - order ID to match
   * @param {number} [opts.cid] - order client ID to match
   * @param {number} [opts.gid] - order group ID to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-orders
   * @see WSv2#submitOrder
   */
  onOrderNew ({ symbol, id, cid, gid, cbGID }, cb) {
    this._registerListener('on', {
      0: id,
      1: gid,
      2: cid,
      3: symbol
    }, Order, cbGID, cb)
  }

  /**
   * Register a handler to be called on each order update packet
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {number} [opts.id] - order ID to match
   * @param {number} [opts.cid] - order client ID to match
   * @param {number} [opts.gid] - order group ID to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-orders
   * @see WSv2#updateOrder
   */
  onOrderUpdate ({ symbol, id, cid, gid, cbGID }, cb) {
    this._registerListener('ou', {
      0: id,
      1: gid,
      2: cid,
      3: symbol
    }, Order, cbGID, cb)
  }

  /**
   * Register a handler to be called on each order close packet
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {number} [opts.id] - order ID to match
   * @param {number} [opts.cid] - order client ID to match
   * @param {number} [opts.gid] - order group ID to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-orders
   * @see WSv2#cancelOrder
   */
  onOrderClose ({ symbol, id, cid, gid, cbGID }, cb) {
    this._registerListener('oc', {
      0: id,
      1: gid,
      2: cid,
      3: symbol
    }, Order, cbGID, cb)
  }

  /**
   * Register a handler to be called on each position snapshot (sent on auth)
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-position
   * @see WSv2#auth
   */
  onPositionSnapshot ({ symbol, cbGID }, cb) {
    this._registerListener('ps', { 0: symbol }, Position, cbGID, cb)
  }

  /**
   * Register a handler to be called when a position is opened
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-position
   */
  onPositionNew ({ symbol, cbGID }, cb) {
    this._registerListener('pn', { 0: symbol }, Position, cbGID, cb)
  }

  /**
   * Register a handler to be called when a position is updated
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-position
   */
  onPositionUpdate ({ symbol, cbGID }, cb) {
    this._registerListener('pu', { 0: symbol }, Position, cbGID, cb)
  }

  /**
   * Register a handler to be called when a position is closed
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-position
   */
  onPositionClose ({ symbol, cbGID }, cb) {
    this._registerListener('pc', { 0: symbol }, Position, cbGID, cb)
  }

  /**
   * Register a handler to be called on each fundign offer snapshot (sent on
   * auth)
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-offers
   * @see WSv2#auth
   */
  onFundingOfferSnapshot ({ symbol, cbGID }, cb) {
    this._registerListener('fos', { 1: symbol }, FundingOffer, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding offer is created
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-offers
   */
  onFundingOfferNew ({ symbol, cbGID }, cb) {
    this._registerListener('fon', { 1: symbol }, FundingOffer, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding offer is updated
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-offers
   */
  onFundingOfferUpdate ({ symbol, cbGID }, cb) {
    this._registerListener('fou', { 1: symbol }, FundingOffer, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding offer is closed
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-offers
   */
  onFundingOfferClose ({ symbol, cbGID }, cb) {
    this._registerListener('foc', { 1: symbol }, FundingOffer, cbGID, cb)
  }

  /**
   * Register a handler to be called on each funding credit snapshot (sent on
   * auth)
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-credits
   * @see WSv2#auth
   */
  onFundingCreditSnapshot ({ symbol, cbGID }, cb) {
    this._registerListener('fcs', { 1: symbol }, FundingCredit, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding credit is created
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-credits
   */
  onFundingCreditNew ({ symbol, cbGID }, cb) {
    this._registerListener('fcn', { 1: symbol }, FundingCredit, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding credit is updated
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-credits
   */
  onFundingCreditUpdate ({ symbol, cbGID }, cb) {
    this._registerListener('fcu', { 1: symbol }, FundingCredit, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding credit is closed
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-credits
   */
  onFundingCreditClose ({ symbol, cbGID }, cb) {
    this._registerListener('fcc', { 1: symbol }, FundingCredit, cbGID, cb)
  }

  /**
   * Register a handler to be called on each funding loan snapshot (sent on
   * auth)
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-loans
   * @see WSv2#auth
   */
  onFundingLoanSnapshot ({ symbol, cbGID }, cb) {
    this._registerListener('fls', { 1: symbol }, FundingLoan, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding loan is created
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-loans
   */
  onFundingLoanNew ({ symbol, cbGID }, cb) {
    this._registerListener('fln', { 1: symbol }, FundingLoan, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding loan is updated
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-loans
   */
  onFundingLoanUpdate ({ symbol, cbGID }, cb) {
    this._registerListener('flu', { 1: symbol }, FundingLoan, cbGID, cb)
  }

  /**
   * Register a handler to be called when a funding loan is closed
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-loans
   */
  onFundingLoanClose ({ symbol, cbGID }, cb) {
    this._registerListener('flc', { 1: symbol }, FundingLoan, cbGID, cb)
  }

  /**
   * Register a handler to be called on each wallet snapshot (sent on auth)
   *
   * @param {object} opts - options
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-wallets
   */
  onWalletSnapshot ({ cbGID }, cb) {
    this._registerListener('ws', null, Wallet, cbGID, cb)
  }

  /**
   * Register a handler to be called on each wallet update
   *
   * @param {object} opts - options
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-wallets
   */
  onWalletUpdate ({ cbGID }, cb) {
    this._registerListener('wu', null, Wallet, cbGID, cb)
  }

  /**
   * Register a handler to be called on each balance info update
   *
   * @param {object} opts - options
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-balance
   */
  onBalanceInfoUpdate ({ cbGID }, cb) {
    this._registerListener('bu', null, BalanceInfo, cbGID, cb)
  }

  /**
   * Register a handler to be called on each margin info update
   *
   * @param {object} opts - options
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-margin
   */
  onMarginInfoUpdate ({ cbGID }, cb) {
    this._registerListener('miu', null, MarginInfo, cbGID, cb)
  }

  /**
   * Register a handler to be called on each funding info update
   *
   * @param {object} opts - options
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-funding
   */
  onFundingInfoUpdate ({ cbGID }, cb) {
    this._registerListener('fiu', null, FundingInfo, cbGID, cb)
  }

  /**
   * Register a handler to be called on each funding trade `'te'` event
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-funding-trades
   */
  onFundingTradeEntry ({ symbol, cbGID }, cb) {
    this._registerListener('fte', { 0: symbol }, FundingTrade, cbGID, cb)
  }

  /**
   * Register a handler to be called on each funding trade `'tu'` event
   *
   * @param {object} opts - options
   * @param {string} [opts.symbol] - symbol to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-funding-trades
   */
  onFundingTradeUpdate ({ symbol, cbGID }, cb) {
    this._registerListener('ftu', { 0: symbol }, FundingTrade, cbGID, cb)
  }

  /**
   * Register a handler to be called on each notification
   *
   * @param {object} opts - options
   * @param {string} [opts.type] - type to match
   * @param {string} [opts.cbGID] - callback group id
   * @param {Function} cb - callback
   * @see https://docs.bitfinex.com/v2/reference#ws-auth-notifications
   */
  onNotification ({ type, cbGID }, cb) {
    this._registerListener('n', { 1: type }, Notification, cbGID, cb)
  }
}

/**
 * Map of flag names and numeric values for usage with the API
 *
 * @constant
 * @property {number} DEC_S - flag to request all decimals as strings
 * @property {number} TIME_S - flag to request all timestamps as strings
 * @property {number} TIMESTAMP - flag to request timestamp in milliseconds
 * @property {number} SEQ_ALL - flag to enable sequence numbers & verification
 * @property {number} CHECKSUM - flag to enable order book checksums
 * @memberof! WSv2#
 */
WSv2.flags = {
  DEC_S: 8, // enables all decimals as strings
  TIME_S: 32, // enables all timestamps as strings
  TIMESTAMP: 32768, // timestamps in milliseconds
  SEQ_ALL: 65536, // enable sequencing
  CHECKSUM: 131072 // enable checksum per OB change, top 25 levels per-side
}

/**
 * Map of info event names and their respective codes for usage with the API
 *
 * @constant
 * @property {number} SERVER_RESTART - server restart event
 * @property {number} MAINTENANCE_START - maintenance start event
 * @property {number} MAINTENANCE_END - maintenance end event
 * @memberof! WSv2#
 */
WSv2.info = {
  SERVER_RESTART: 20051,
  MAINTENANCE_START: 20060,
  MAINTENANCE_END: 20061
}

/**
 * Default connection URL
 *
 * @constant
 * @type {string}
 * @memberof! WSv2#
 * @default
 */
WSv2.url = 'wss://api.bitfinex.com/ws/2'

module.exports = WSv2
