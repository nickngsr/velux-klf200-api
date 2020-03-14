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

  static calcPosition = Tools.calcPosition;
  static types = Klf;

  constructor() {
    super();
    this.API = Klf.API;
    this.pending = [];
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
      api = Tools.nameFromId(data.api,this.API);
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
      data.apiText = Tools.nameFromId(data.api, this.API);

      if ((cmd[cmd.length-1] == (cs&0xFF)) && (cmd.length > 5) && Klf.APIFunctionIN[data.apiText]) {
        const d = Klf.APIFunctionIN[data.apiText](cmd.slice(4,cmd.length-1));
        data = Object.assign(data,d);
      }
    }
    debug('getCMD', data);
    return data
  }

  /**
   *
   * @param host
   * @param options
   * @param cb
   * @returns {Promise}
   */
  connect(host, options, cb) {
    debug('connect', 'call', host, options, 'cb '+!(!(cb)));

    return new Promise((resolve, reject) => {
      const options = {
        rejectUnauthorized: false,
        requestCert: true,
        ...options
      };

      const client = Tls.connect(51200, host, options, () => {
        debug('connect', 'connected');
        resolve(true);
      });

      client.setNoDelay(true);

      client.on('data', buffer => {
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

      client.on('timeout', data => {
        this.emit('err',data);
        client.end();
        const error = new Error('tcp error'+data);
        debug('connect', error);
        return reject(error);
      });

      client.on('error', data => {
        this.emit('err',data);
        client.end();
        const error = new Error('tcp error'+data);
        debug('connect', error);
        return reject(error)
      });

      this.tcpClient = client;

    }).asCallback(cb);
  }

  /**
   *
   * @param data
   * @param resolve
   * @param reject
   * @private
   */
  _add_CFM = function(data, resolve, reject) {

    const apiText = Tools.nameFromId(data.api, this.API).replace(/REQ$/,'CFM');
    const api = this.API[apiText];

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
        const ok = this.tcpClient.write(buf);
        debug('sendCommand', 'write completed', ok, 'data', buf.length, ':', buf.toString('hex'))
      }).catch((err)=>{
        debug('sendCommand', err);
        return reject(err)
      });
    }).asCallback(cb);
  }

  /**
   *
   * @param password
   * @param cb
   * @returns {Promise}
   */
  login(password, cb) {
    debug('login', 'call', password, 'cb '+!(!(cb)));

    return this.sendCommand({
      'api': this.API.GW_PASSWORD_ENTER_REQ,
      'password': password
    }).then(data => {
      if (!data.status) {
        throw new Error('Refused Login');
      }
      debug('login', 'Login Successful');
    }).catch(err => {
      debug('login', err);
      throw err;
    });

  }

  /**
   *
   * @param cb
   * @returns {*}
   */
  end(cb) {
    debug('end', 'call', 'cb '+!(!(cb)));
    this.tcpClient.removeAllListeners();
    this.tcpClient.destroy();

    return Promise.resolve(true).asCallback(cb);
  }

}

module.exports = Velux;
