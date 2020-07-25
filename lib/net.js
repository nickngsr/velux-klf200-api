// Copyright (c) 2018 Träger

// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
// ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

'use strict';

const Tls = require('tls');
const Slip = require('./slip');
const Klf = require('./klf');
const Tools = require('./tools');
const Buffer = require('safe-buffer').Buffer;
const debug = require('debug')('velux-klf200-api:net');
const Promise = require('bluebird');
const EventEmitter = require('events');

class Velux extends EventEmitter {

  static get API() { return Klf.API };
  static get types() { return Klf };
  static calcPosition(value) {
    return Tools.calcPosition(value);
  }

  constructor(host, password, config) {
    super();
    this.pending = [];
    this.host = host;
    this.password = password;

    // connecting flag
    this._connecting = false;
    // connected (and logged in) flag
    this._connected = false;

    this._loginFailed = false;

    const defaults = {
      autoReconnect: false,
      autoConnect: false,
      ...config
    };

    this._autoReconnect = defaults.autoReconnect;

    if (defaults.autoConnect) {
      // wrap in a timeout so that any listener on the 'connecting' event fires
      setTimeout(() => {
        this.connect();
      });
    }

  }

  get connected() {
    return !!this._connected;
  }

  get connecting() {
    return !!this._connecting;
  }

  /**
   *
   * @param data
   * @returns {module:safe-buffer.Buffer}
   * @private
   */
  _setCMD(data) {
    debug('setCMD', 'call', data);
    let api;
    if (typeof data.apiText !== 'undefined') {
      api = data.apiText;
      data.api = this.API[data.apiText];
    } else {
      api = Tools.nameFromId(data.api, Velux.API);
    }
    const apiCall = Klf.APIFunctionOUT[api];
    let cmd = new Buffer(0);
    if (apiCall){
      const databuf = apiCall(data);
      const length = !(databuf)?0:databuf.length;
      cmd = new Buffer(length+5);
      if (databuf) {
        databuf.copy(cmd,4,0)
      }
      cmd.writeUInt8(0x00&&0xFF,0);
      cmd.writeUInt8(cmd.length-2,1);
      cmd.writeUInt16BE(data.api,2);
      let cs = cmd[0];
      for (let i=1; i<cmd.length-1; i++) {
        cs ^= cmd[i]
      }
      cmd.writeUInt8(cs&0xFF,cmd.length-1);
      debug('setCMD', cmd.length, ':', cmd.toString('hex'));
    }
    return cmd
  }

  /**
   *
   * @param cmd
   * @returns {{}}
   * @private
   */
  _getCMD(cmd) {
    debug('getCMD', 'call', cmd.length, ':', cmd.toString('hex'));
    let data = {};
    if (cmd.length > 4) {
      let cs = cmd[0];
      for (let i=1; i<cmd.length-1; i++) {
        cs ^= cmd[i]
      }
      data.id = cmd.readUInt8(0);
      //const length = cmd.readUInt8(1);
      data.api = cmd.readUInt16BE(2);
      data.apiText = Tools.nameFromId(data.api, Velux.API);

      if ((cmd[cmd.length-1] === (cs&0xFF)) && (cmd.length > 5) && Klf.APIFunctionIN[data.apiText]) {
        const d = Klf.APIFunctionIN[data.apiText](cmd.slice(4,cmd.length-1));
        data = Object.assign(data,d);
      }
    }
    debug('getCMD', data);
    return data
  }

  connect(isReconnect) {
    const conProm = this._connect(isReconnect);

    // we want to silently catch future errors (for reconnects) must listen on error event for those
    if (isReconnect) {
      conProm.catch(() => {});
    }

    return conProm;
  }

  /**
   *
   * @returns {Promise}
   */
  _connect(isReconnect) {

    if (this._connecting || this._connected) {
      debug('connect', 'already connecting, ignoring connect command');
      return Promise.resolve();
    }
    debug('connect', 'call', this.host);

    this._socketShouldConnect = true;
    this._connecting = true;

    clearTimeout(this._reconnectTimeout);

    return new Promise((resolve, reject) => {

      this.emit('connecting', !!isReconnect);

      const opts = {
        rejectUnauthorized: false,
        requestCert: true
      };

      const client = Tls.connect(51200, this.host, opts, () => {
        clearTimeout(this._connectTimeout);
        resolve(true);
      });

      this._connectTimeout = setTimeout(() => {
        debug('connect', 'Failed to connect to device');
        this.emit('connectionFailed');
        this._tcpClient.destroy(new Error("Connection timed out"));
      }, 15000);

      client.setNoDelay(true);

      client.on('data', buffer => {
        this._resetPingTimer();
        debug('connect', 'dataListener', buffer.length, ':', buffer.toString('hex'));
        Slip.unpack(buffer)
        .then((buf) => {
          const data = this._getCMD(buf);
          if (data.apiText.endsWith('NTF')){
            debug('connect', 'dataListener', 'NTF', data);
            this.emit('NTF',data);
            this.emit(data.apiText, data);
          } else {
            this._analyse_CFM(data);
          }
        }).catch((err) => {
          debug('connect', 'dataListener', err)
        });
      });

      client.on('error', error => {
        this.emit('error', error);
        client.destroy();
        debug('connect', error);
        return reject(error)
      });

      client.on('close', hadError => {
        this._resetPingTimer(true);

        // if the socket should still be open and has been previously connected, try reconnecting if autoReconnect is enabled
        // this can be updated in the future so that only login failures stop it from reconnecting
        const shouldReconnect = this._socketShouldConnect && !this._loginFailed && this._autoReconnect;

        this._connected = false;
        this._connecting = false;

        // make sure the current 'close' is due to an error, if it was pass the last error
        this.emit('disconnect', hadError, shouldReconnect);
        this._lastError = null;

        if (shouldReconnect) {

          debug('connect', 'socket closed, reconnecting');

          // reconnect in 5 secs
          this._reconnectTimeout = setTimeout(() => {
            this.connect(true);
          }, 5000);

        } else {

          debug('connect', 'socket closed');

        }

      });

      this._tcpClient = client;

    }).then(() => {

      return this._login(isReconnect);

    });
  }

  /**
   *
   * @param data
   * @param resolve
   * @param reject
   * @private
   */
  _add_CFM(data, resolve, reject) {

    const apiText = Tools.nameFromId(data.api, Velux.API).replace(/REQ$/,'CFM');
    const api = Velux.API[apiText];

    this.pending[apiText] = {
      resolve,
      reject,
      api,
      timeout: setTimeout(() => {
        const error = new Error(`timeout ${apiText}`);
        delete this.pending[apiText];
        debug('add_CFM', error);
        return reject(error);
      }, 5000)
    }

  };

  /**
   *
   * @param cancel
   * @private
   */
  _resetPingTimer(cancel) {
    debug('ping', `timer ${cancel?'stopped':'reset'}`);
    clearTimeout(this._pingTimer);
    if (cancel) return;
    this._pingTimer = setTimeout(() => {
      this.sendCommand({api: Velux.API.GW_GET_STATE_REQ}).then(() => {
        this._resetPingTimer();
      }).catch(() => {
        if (this._tcpClient) {
          this._tcpClient.destroy();
        }
      })
    }, 5 * 60 * 1000);
  }

  /**
   *
   * @param data
   * @returns {*}
   * @private
   */
  _analyse_CFM(data) {
    if (data.api && this.pending[data.apiText]) {
      debug('analyse_CFM', 'api pending');
      const pending = this.pending[data.apiText];
      clearTimeout(pending.timeout);
      delete this.pending[data.apiText];
      return pending.resolve(data);
    } else {
      debug('analyse_CFM', 'api not pending', data);
      this.emit('notPending', data);
    }
  }

  /**
   *
   * @param data
   * @param cb
   * @returns {Promise}
   */
  sendCommand(data, cb) {
    debug('sendCommand', 'call', data, 'cb '+!(!(cb)));
    return new Promise((resolve, reject) => {
      const cmd = this._setCMD(data);
      Slip.pack(cmd)
      .then((buf) => {
        this._add_CFM(data ,resolve, reject);
        const ok = this._tcpClient.write(buf);
        debug('sendCommand', 'write completed', ok, 'data', buf.length, ':', buf.toString('hex'))
      }).catch((err)=>{
        debug('sendCommand', err);
        return reject(err)
      });
    }).asCallback(cb);
  }


  /**
   *
   * @returns {Promise}
   * @private
   */
  _login(isReconnect) {
    debug('login', 'call', this.password);

    this._loginFailed = false;

    return this.sendCommand({
      'api': Velux.API.GW_PASSWORD_ENTER_REQ,
      'password': this.password
    }).then(data => {

      if (!data.status) {
        throw new Error('Login was refused');
      }

      debug('login', 'Login Successful');

      this._connected = true;
      this._connecting = false;

      this.emit('connected', !!isReconnect);

    }).catch(err => {
      debug('login', err);
      this._loginFailed = true;
      this._tcpClient.destroy(err);
      throw err;
    });

  }

  _prepareEnd() {
    this._socketShouldConnect = false;

    clearTimeout(this._connectTimeout);
    clearTimeout(this._reconnectTimeout);
  }

  /**
   * Ends the tcp connection
   */
  end() {
    debug('end', 'call');
    this._prepareEnd();

    if (this._tcpClient) {
      this._tcpClient.end();
    }
  }

  destroy() {
    this._prepareEnd();
    if (this._tcpClient) {
      this._tcpClient.destroy();
    }
  }

}

module.exports = Velux;
